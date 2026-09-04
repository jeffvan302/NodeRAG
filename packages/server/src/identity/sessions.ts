import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
const randomToken = (): string => randomBytes(32).toString('base64url');

export interface NewSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface CreateSessionInput {
  readonly principalId: number;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly now?: Date;
  readonly slidingMilliseconds?: number;
  readonly absoluteMilliseconds?: number;
}

export const createSession = async (
  database: SqlClient,
  input: CreateSessionInput,
): Promise<NewSession> => {
  const now = input.now ?? new Date();
  const sliding = input.slidingMilliseconds ?? 8 * 60 * 60_000;
  const absolute = input.absoluteMilliseconds ?? 7 * 24 * 60 * 60_000;
  const token = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(now.getTime() + Math.min(sliding, absolute));
  const absoluteExpiresAt = new Date(now.getTime() + absolute);
  await database.query(
    `INSERT INTO noderag.session
       (token_sha256, csrf_sha256, principal_id, created_at, last_seen_at,
        sliding_expires_at, absolute_expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)`,
    [
      sha256(token),
      sha256(csrfToken),
      input.principalId,
      now,
      expiresAt,
      absoluteExpiresAt,
      input.ip ?? null,
      input.userAgent ?? null,
    ],
  );
  return { token, csrfToken, expiresAt, absoluteExpiresAt };
};

interface SessionRow {
  readonly principal_id: number;
  readonly csrf_sha256: Buffer;
  readonly sliding_expires_at: Date;
  readonly absolute_expires_at: Date;
  readonly revoked_at: Date | null;
  readonly disabled: boolean;
  readonly deleted_at: Date | null;
}

export interface ValidSession {
  readonly principalId: number;
  readonly expiresAt: Date;
  readonly csrfMatches: (candidate: string) => boolean;
}

export const validateSession = async (
  pool: Pool,
  token: string,
  now = new Date(),
  slidingMilliseconds = 8 * 60 * 60_000,
): Promise<ValidSession | null> =>
  withTransaction(pool, async (database) => {
    const found = await database.query<SessionRow>(
      `SELECT s.principal_id, s.csrf_sha256, s.sliding_expires_at,
              s.absolute_expires_at, s.revoked_at, p.disabled, p.deleted_at
       FROM noderag.session s
       JOIN noderag.principal p ON p.id = s.principal_id
       WHERE s.token_sha256 = $1
       FOR UPDATE`,
      [sha256(token)],
    );
    const row = found.rows[0];
    if (
      row === undefined ||
      row.revoked_at !== null ||
      row.disabled ||
      row.deleted_at !== null ||
      row.sliding_expires_at.getTime() <= now.getTime() ||
      row.absolute_expires_at.getTime() <= now.getTime()
    ) {
      return null;
    }
    const principalId = databaseInteger(row.principal_id, 'session principal id');
    const expiresAt = new Date(
      Math.min(row.absolute_expires_at.getTime(), now.getTime() + slidingMilliseconds),
    );
    await database.query(
      `UPDATE noderag.session SET last_seen_at = $2, sliding_expires_at = $3
       WHERE token_sha256 = $1`,
      [sha256(token), now, expiresAt],
    );
    return {
      principalId,
      expiresAt,
      csrfMatches: (candidate: string) => {
        const digest = sha256(candidate);
        return digest.length === row.csrf_sha256.length && timingSafeEqual(digest, row.csrf_sha256);
      },
    };
  });

export const revokeSession = async (database: SqlClient, token: string): Promise<boolean> => {
  const result = await database.query(
    `UPDATE noderag.session SET revoked_at = now()
     WHERE token_sha256 = $1 AND revoked_at IS NULL`,
    [sha256(token)],
  );
  return result.rowCount === 1;
};

export interface BrowserMutationGuardInput {
  readonly expectedOrigin: string;
  readonly origin: string | undefined;
  readonly csrfToken: string | undefined;
  readonly session: ValidSession;
}

export const browserMutationAllowed = (input: BrowserMutationGuardInput): boolean =>
  input.origin === input.expectedOrigin &&
  input.csrfToken !== undefined &&
  input.session.csrfMatches(input.csrfToken);

export const sessionCookieOptions = (secure: boolean) => ({
  httpOnly: true,
  sameSite: 'strict' as const,
  secure,
  path: '/',
});
