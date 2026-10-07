import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Pool } from 'pg';
import { hashPassword } from '../identity/passwords.js';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';
import { createSiloInTransaction, type SiloRecord } from '../store/silos.js';

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

const newSetupToken = (): string => `setup_${randomBytes(32).toString('base64url')}`;
const newRecoveryCode = (): string => `recovery_${randomBytes(24).toString('base64url')}`;

const setupTokenLifetimeMilliseconds = (): number => {
  const hours = Number(process.env['NODERAG_SETUP_TOKEN_HOURS'] ?? '24');
  return Math.min(168, Math.max(1, Number.isFinite(hours) ? hours : 24)) * 60 * 60 * 1000;
};

export const issueSetupToken = async (database: SqlClient): Promise<string> => {
  const token = newSetupToken();
  const issuedAt = new Date();
  const result = await database.query(
    `UPDATE noderag.setup_state
     SET setup_token_sha256 = $1, setup_token_issued_at = $2,
         setup_token_expires_at = $3, setup_step = 'verify-token', setup_progress = 0
     WHERE id = 1 AND state = 'unconfigured' AND configured_at IS NULL`,
    [sha256(token), issuedAt, new Date(issuedAt.getTime() + setupTokenLifetimeMilliseconds())],
  );
  if (result.rowCount !== 1) throw new Error('setup-token-unavailable');
  await database.query(
    `INSERT INTO noderag.setup_event (event_type, step, progress)
     VALUES ('token-issued', 'verify-token', 0)`,
  );
  return token;
};

export const ensureSetupTokenFile = async (database: SqlClient, path: string): Promise<boolean> => {
  const absolute = resolve(path);
  const status = await setupStatus(database);
  if (status.state !== 'unconfigured') {
    await rm(absolute, { force: true });
    return false;
  }
  if (!status.tokenIssued && status.tokenExpiresAt !== null) {
    await rm(absolute, { force: true });
    await database.query(
      `UPDATE noderag.setup_state
       SET setup_token_sha256 = NULL, setup_token_issued_at = NULL,
           setup_token_expires_at = NULL
       WHERE id = 1 AND state = 'unconfigured' AND setup_token_expires_at <= now()`,
    );
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
  if (!/^setup_(?:[A-Za-z0-9_-]{43}|[a-f0-9]{64})$/u.test(token))
    throw new Error('invalid-setup-token-file');
  await chmod(absolute, 0o600);
  const digest = sha256(token);
  const found = await database.query<{ setup_token_sha256: Buffer | null }>(
    `SELECT setup_token_sha256 FROM noderag.setup_state
     WHERE id = 1 AND state = 'unconfigured' FOR UPDATE`,
  );
  const stored = found.rows[0]?.setup_token_sha256;
  if (stored === null || stored === undefined) {
    const issuedAt = new Date();
    await database.query(
      `UPDATE noderag.setup_state
       SET setup_token_sha256 = $1, setup_token_issued_at = $2,
           setup_token_expires_at = $3, setup_step = 'verify-token', setup_progress = 0
       WHERE id = 1 AND state = 'unconfigured'`,
      [digest, issuedAt, new Date(issuedAt.getTime() + setupTokenLifetimeMilliseconds())],
    );
    await database.query(
      `INSERT INTO noderag.setup_event (event_type, step, progress)
       VALUES ('token-issued', 'verify-token', 0)`,
    );
  } else if (stored.length !== digest.length || !timingSafeEqual(stored, digest)) {
    throw new Error('setup-token-file-does-not-match-database');
  } else {
    await database.query(
      `UPDATE noderag.setup_state
       SET setup_token_issued_at = COALESCE(setup_token_issued_at, now()),
           setup_token_expires_at = COALESCE(
             setup_token_expires_at,
             now() + ($1::text || ' milliseconds')::interval
           )
       WHERE id = 1 AND state = 'unconfigured'`,
      [setupTokenLifetimeMilliseconds()],
    );
  }
  return true;
};

export const setupStatus = async (
  database: SqlClient,
): Promise<{
  readonly state: string;
  readonly tokenIssued: boolean;
  readonly tokenExpiresAt: string | null;
  readonly step: string;
  readonly progress: number;
}> => {
  const result = await database.query<{
    state: string;
    token_issued: boolean;
    setup_token_expires_at: Date | null;
    setup_step: string;
    setup_progress: number;
  }>(
    `SELECT state,
            setup_token_sha256 IS NOT NULL
              AND setup_token_expires_at > now() AS token_issued,
            setup_token_expires_at, setup_step, setup_progress
     FROM noderag.setup_state WHERE id = 1`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Setup state is missing.');
  return {
    state: row.state,
    tokenIssued: row.token_issued,
    tokenExpiresAt: row.setup_token_expires_at?.toISOString() ?? null,
    step: row.setup_step,
    progress: row.setup_progress,
  };
};

export const verifySetupToken = async (database: SqlClient, token: string): Promise<boolean> => {
  const result = await database.query<{
    setup_token_sha256: Buffer | null;
    setup_token_expires_at: Date | null;
    state: string;
  }>(
    `SELECT setup_token_sha256, setup_token_expires_at, state
     FROM noderag.setup_state WHERE id = 1`,
  );
  const row = result.rows[0];
  const candidate = sha256(token);
  return (
    row?.state === 'unconfigured' &&
    row.setup_token_sha256 !== null &&
    row.setup_token_expires_at !== null &&
    row.setup_token_expires_at.getTime() > Date.now() &&
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
  readonly recoveryCode: string;
}

export const bootstrapFirstAdministrator = async (
  pool: Pool,
  input: BootstrapInput,
): Promise<BootstrapResult> => {
  const passwordHash = await hashPassword(input.password);
  const recoveryCode = newRecoveryCode();
  return withTransaction(pool, async (database) => {
    const setup = await database.query<{
      state: string;
      setup_token_sha256: Buffer | null;
      setup_token_expires_at: Date | null;
    }>(
      `SELECT state, setup_token_sha256, setup_token_expires_at
       FROM noderag.setup_state WHERE id = 1 FOR UPDATE`,
    );
    const row = setup.rows[0];
    const candidate = sha256(input.setupToken);
    if (
      row?.state !== 'unconfigured' ||
      row.setup_token_sha256 === null ||
      row.setup_token_expires_at === null ||
      row.setup_token_expires_at.getTime() <= Date.now() ||
      row.setup_token_sha256.length !== candidate.length ||
      !timingSafeEqual(row.setup_token_sha256, candidate)
    ) {
      throw new Error('invalid-or-consumed-setup-token');
    }
    await database.query(
      `UPDATE noderag.setup_state
       SET state = 'initializing', setup_step = 'administrator', setup_progress = 20
       WHERE id = 1`,
    );
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
           setup_token_issued_at = NULL, setup_token_expires_at = NULL,
           configured_at = now(), configured_by = $1, last_error = NULL,
           setup_step = 'sign-in', setup_progress = 30, recovery_code_sha256 = $2
       WHERE id = 1`,
      [principalId, sha256(recoveryCode)],
    );
    await database.query(
      `INSERT INTO noderag.setup_event (event_type, step, progress, detail)
       VALUES ('administrator-created', 'sign-in', 30,
               jsonb_build_object('principalId', $1::bigint))`,
      [principalId],
    );
    await database.query(
      `INSERT INTO noderag.audit_log (principal_id, action, result)
       VALUES ($1, 'setup.configure', 'ok')`,
      [principalId],
    );
    return { principalId, defaultSilo, recoveryCode };
  });
};
