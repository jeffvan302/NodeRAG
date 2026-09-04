import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Pool } from 'pg';
import { hashPassword } from '../identity/passwords.js';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';
import { createSiloInTransaction, type SiloRecord } from '../store/silos.js';

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

const newSetupToken = (): string => `setup_${randomBytes(32).toString('base64url')}`;

export const issueSetupToken = async (database: SqlClient): Promise<string> => {
  const token = newSetupToken();
  const result = await database.query(
    `UPDATE noderag.setup_state
     SET setup_token_sha256 = $1
     WHERE id = 1 AND state = 'unconfigured' AND configured_at IS NULL`,
    [sha256(token)],
  );
  if (result.rowCount !== 1) throw new Error('setup-token-unavailable');
  return token;
};

export const ensureSetupTokenFile = async (database: SqlClient, path: string): Promise<boolean> => {
  const absolute = resolve(path);
  const status = await setupStatus(database);
  if (status.state !== 'unconfigured') {
    await rm(absolute, { force: true });
    return false;
  }
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  let token: string;
  try {
    const file = await lstat(absolute);
    if (!file.isFile() || file.isSymbolicLink())
      throw new Error('setup-token-file-must-be-regular');
    token = (await readFile(absolute, 'utf8')).trim();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') throw error;
    token = newSetupToken();
    const temporary = `${absolute}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${token}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, absolute);
  }
  if (!/^setup_[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error('invalid-setup-token-file');
  await chmod(absolute, 0o600);
  const digest = sha256(token);
  const found = await database.query<{ setup_token_sha256: Buffer | null }>(
    `SELECT setup_token_sha256 FROM noderag.setup_state
     WHERE id = 1 AND state = 'unconfigured' FOR UPDATE`,
  );
  const stored = found.rows[0]?.setup_token_sha256;
  if (stored === null || stored === undefined) {
    await database.query(
      `UPDATE noderag.setup_state SET setup_token_sha256 = $1
       WHERE id = 1 AND state = 'unconfigured'`,
      [digest],
    );
  } else if (stored.length !== digest.length || !timingSafeEqual(stored, digest)) {
    throw new Error('setup-token-file-does-not-match-database');
  }
  return true;
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
