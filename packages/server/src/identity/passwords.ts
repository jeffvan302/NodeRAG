import { randomBytes } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import type { Pool } from 'pg';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';

export const passwordHashPolicy = {
  iterations: 2,
  parallelism: 1,
  memorySizeKiB: 65_536,
  hashLength: 32,
  saltLength: 16,
} as const;

const validatePassword = (password: string): void => {
  if (password.length < 12 || password.length > 1024) {
    throw new Error('Password must contain between 12 and 1024 characters.');
  }
};

export const hashPassword = async (password: string): Promise<string> => {
  validatePassword(password);
  return argon2id({
    password,
    salt: randomBytes(passwordHashPolicy.saltLength),
    iterations: passwordHashPolicy.iterations,
    parallelism: passwordHashPolicy.parallelism,
    memorySize: passwordHashPolicy.memorySizeKiB,
    hashLength: passwordHashPolicy.hashLength,
    outputType: 'encoded',
  });
};

export const verifyPassword = async (encoded: string, password: string): Promise<boolean> => {
  try {
    return await argon2Verify({ hash: encoded, password });
  } catch {
    return false;
  }
};

export type AuthenticationResult =
  | { readonly ok: true; readonly principalId: number; readonly serverAdmin: boolean }
  | {
      readonly ok: false;
      readonly code: 'invalid-credentials' | 'temporarily-locked' | 'login-disabled';
    };

interface AuthenticationRow {
  readonly principal_id: number;
  readonly password_hash: string;
  readonly server_admin: boolean;
  readonly failed_logins: number;
  readonly locked_until: Date | null;
  readonly disabled: boolean;
  readonly deleted_at: Date | null;
}

const consumeUnknownAccountCost = async (password: string): Promise<void> => {
  await argon2id({
    password,
    salt: new Uint8Array(passwordHashPolicy.saltLength).fill(0x5a),
    iterations: passwordHashPolicy.iterations,
    parallelism: passwordHashPolicy.parallelism,
    memorySize: passwordHashPolicy.memorySizeKiB,
    hashLength: passwordHashPolicy.hashLength,
    outputType: 'encoded',
  });
};

const lockoutMilliseconds = (failedLogins: number): number => {
  if (failedLogins < 3) return 0;
  return Math.min(15 * 60_000, 5_000 * 2 ** (failedLogins - 3));
};

const auditAuthentication = async (
  database: SqlClient,
  principalId: number | null,
  result: 'ok' | 'denied',
  sourceIp: string | null,
  requestId: string,
  reason?: string,
): Promise<void> => {
  await database.query(
    `INSERT INTO noderag.audit_log
       (principal_id, action, result, source_ip, request_id, detail)
     VALUES ($1, 'auth.login', $2, $3, $4, jsonb_build_object('reason', $5::text))`,
    [principalId, result, sourceIp, requestId, reason ?? null],
  );
};

export interface AuthenticatePasswordInput {
  readonly username: string;
  readonly password: string;
  readonly sourceIp?: string;
  readonly requestId: string;
  readonly now?: Date;
}

export const authenticatePassword = async (
  pool: Pool,
  input: AuthenticatePasswordInput,
): Promise<AuthenticationResult> =>
  withTransaction(pool, async (database) => {
    const now = input.now ?? new Date();
    const loginSetting = await database.query<{ login_enabled: boolean }>(
      'SELECT login_enabled FROM noderag.settings WHERE id = 1',
    );
    if (loginSetting.rows[0]?.login_enabled !== true) {
      await consumeUnknownAccountCost(input.password);
      await auditAuthentication(
        database,
        null,
        'denied',
        input.sourceIp ?? null,
        input.requestId,
        'login-disabled',
      );
      return { ok: false, code: 'login-disabled' };
    }
    const found = await database.query<AuthenticationRow>(
      `SELECT u.principal_id, u.password_hash, u.server_admin, u.failed_logins,
              u.locked_until, p.disabled, p.deleted_at
       FROM noderag.app_user u
       JOIN noderag.principal p ON p.id = u.principal_id
       WHERE lower(u.username) = lower($1)
       FOR UPDATE`,
      [input.username],
    );
    const row = found.rows[0];
    if (row === undefined) {
      await consumeUnknownAccountCost(input.password);
      await auditAuthentication(database, null, 'denied', input.sourceIp ?? null, input.requestId);
      return { ok: false, code: 'invalid-credentials' };
    }
    const principalId = databaseInteger(row.principal_id, 'password principal id');
    if (row.disabled || row.deleted_at !== null) {
      await consumeUnknownAccountCost(input.password);
      await auditAuthentication(
        database,
        principalId,
        'denied',
        input.sourceIp ?? null,
        input.requestId,
        'disabled',
      );
      return { ok: false, code: 'invalid-credentials' };
    }
    if (row.locked_until !== null && row.locked_until.getTime() > now.getTime()) {
      await auditAuthentication(
        database,
        principalId,
        'denied',
        input.sourceIp ?? null,
        input.requestId,
        'locked',
      );
      return { ok: false, code: 'temporarily-locked' };
    }
    if (!(await verifyPassword(row.password_hash, input.password))) {
      const failedLogins = row.failed_logins + 1;
      const delay = lockoutMilliseconds(failedLogins);
      await database.query(
        `UPDATE noderag.app_user
         SET failed_logins = $2,
             locked_until = CASE WHEN $3::bigint = 0 THEN NULL ELSE $4::timestamptz END
         WHERE principal_id = $1`,
        [principalId, failedLogins, delay, delay === 0 ? null : new Date(now.getTime() + delay)],
      );
      await auditAuthentication(
        database,
        principalId,
        'denied',
        input.sourceIp ?? null,
        input.requestId,
        'invalid',
      );
      return { ok: false, code: 'invalid-credentials' };
    }
    await database.query(
      'UPDATE noderag.app_user SET failed_logins = 0, locked_until = NULL WHERE principal_id = $1',
      [principalId],
    );
    await auditAuthentication(database, principalId, 'ok', input.sourceIp ?? null, input.requestId);
    return { ok: true, principalId, serverAdmin: row.server_admin };
  });

export const changePasswordInTransaction = async (
  database: SqlClient,
  principalId: number,
  currentPassword: string,
  nextPassword: string,
): Promise<void> => {
  validatePassword(nextPassword);
  const found = await database.query<{ password_hash: string }>(
    `SELECT u.password_hash FROM noderag.app_user u
       JOIN noderag.principal p ON p.id = u.principal_id
       WHERE u.principal_id = $1 AND NOT p.disabled AND p.deleted_at IS NULL
       FOR UPDATE`,
    [principalId],
  );
  const row = found.rows[0];
  if (row === undefined || !(await verifyPassword(row.password_hash, currentPassword))) {
    throw new Error('invalid-current-password');
  }
  const nextHash = await hashPassword(nextPassword);
  await database.query(
    `UPDATE noderag.app_user
       SET password_hash = $2, must_change = false, failed_logins = 0,
           locked_until = NULL, password_changed_at = now()
       WHERE principal_id = $1`,
    [principalId, nextHash],
  );
  await database.query(
    'UPDATE noderag.session SET revoked_at = now() WHERE principal_id = $1 AND revoked_at IS NULL',
    [principalId],
  );
  await database.query(
    `INSERT INTO noderag.audit_log (principal_id, action, result)
       VALUES ($1, 'auth.password.change', 'ok')`,
    [principalId],
  );
};

export const changePassword = async (
  pool: Pool,
  principalId: number,
  currentPassword: string,
  nextPassword: string,
): Promise<void> => {
  await withTransaction(pool, (database) =>
    changePasswordInTransaction(database, principalId, currentPassword, nextPassword),
  );
};
