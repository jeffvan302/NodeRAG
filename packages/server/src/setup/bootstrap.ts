import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { hashPassword } from '../identity/passwords.js';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';
import { createSiloInTransaction, type SiloRecord } from '../store/silos.js';

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export const issueSetupToken = async (database: SqlClient): Promise<string> => {
  const token = `setup_${randomBytes(32).toString('base64url')}`;
  const result = await database.query(
    `UPDATE noderag.setup_state
     SET setup_token_sha256 = $1
     WHERE id = 1 AND state = 'unconfigured' AND configured_at IS NULL`,
    [sha256(token)],
  );
  if (result.rowCount !== 1) throw new Error('setup-token-unavailable');
  return token;
};

export const setupStatus = async (
  database: SqlClient,
): Promise<{ readonly state: string; readonly tokenIssued: boolean }> => {
  const result = await database.query<{ state: string; token_issued: boolean }>(
    `SELECT state, setup_token_sha256 IS NOT NULL AS token_issued
     FROM noderag.setup_state WHERE id = 1`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Setup state is missing.');
  return { state: row.state, tokenIssued: row.token_issued };
};

export const verifySetupToken = async (database: SqlClient, token: string): Promise<boolean> => {
  const result = await database.query<{ setup_token_sha256: Buffer | null; state: string }>(
    'SELECT setup_token_sha256, state FROM noderag.setup_state WHERE id = 1',
  );
  const row = result.rows[0];
  const candidate = sha256(token);
  return (
    row?.state === 'unconfigured' &&
    row.setup_token_sha256 !== null &&
    row.setup_token_sha256.length === candidate.length &&
    timingSafeEqual(row.setup_token_sha256, candidate)
  );
};

export interface BootstrapInput {
  readonly setupToken: string;
  readonly username: string;
  readonly password: string;
  readonly email?: string;
  readonly defaultSiloName?: string;
}

export interface BootstrapResult {
  readonly principalId: number;
  readonly defaultSilo: SiloRecord;
}

export const bootstrapFirstAdministrator = async (
  pool: Pool,
  input: BootstrapInput,
): Promise<BootstrapResult> => {
  const passwordHash = await hashPassword(input.password);
  return withTransaction(pool, async (database) => {
    const setup = await database.query<{
      state: string;
      setup_token_sha256: Buffer | null;
    }>('SELECT state, setup_token_sha256 FROM noderag.setup_state WHERE id = 1 FOR UPDATE');
    const row = setup.rows[0];
    const candidate = sha256(input.setupToken);
    if (
      row?.state !== 'unconfigured' ||
      row.setup_token_sha256 === null ||
      row.setup_token_sha256.length !== candidate.length ||
      !timingSafeEqual(row.setup_token_sha256, candidate)
    ) {
      throw new Error('invalid-or-consumed-setup-token');
    }
    await database.query("UPDATE noderag.setup_state SET state = 'initializing' WHERE id = 1");
    const principal = await database.query<{ id: number }>(
      `INSERT INTO noderag.principal (kind, label)
       VALUES ('user', $1) RETURNING id`,
      [input.username],
    );
    const principalId = databaseInteger(principal.rows[0]?.id, 'administrator principal id');
    await database.query(`UPDATE noderag.principal SET created_by = $1 WHERE id = $1`, [
      principalId,
    ]);
    await database.query(
      `INSERT INTO noderag.app_user
         (principal_id, username, email, password_hash, server_admin)
       VALUES ($1, $2, $3, $4, true)`,
      [principalId, input.username, input.email ?? null, passwordHash],
    );
    const defaultSilo = await createSiloInTransaction(database, {
      slug: 'default',
      displayName: input.defaultSiloName ?? 'Default',
      description: 'Initial NodeRag silo',
      creatingPrincipalId: principalId,
    });
    await database.query(
      `UPDATE noderag.setup_state
       SET state = 'operational', setup_token_sha256 = NULL,
           configured_at = now(), configured_by = $1, last_error = NULL
       WHERE id = 1`,
      [principalId],
    );
    await database.query(
      `INSERT INTO noderag.audit_log (principal_id, action, result)
       VALUES ($1, 'setup.configure', 'ok')`,
      [principalId],
    );
    return { principalId, defaultSilo };
  });
};
