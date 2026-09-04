import { BlockList, isIP } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const randomBase62 = (length: number): string => {
  let value = '';
  while (value.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= 248) continue;
      value += alphabet[byte % alphabet.length];
      if (value.length === length) break;
    }
  }
  return value;
};

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export interface CreateApiKeyInput {
  readonly label: string;
  readonly createdBy: number;
  readonly searchOnly?: boolean;
  readonly expiresAt?: Date;
  readonly cidrAllow?: readonly string[];
  readonly ratePerMinute?: number;
}

export interface CreatedApiKey {
  readonly principalId: number;
  readonly prefix: string;
  readonly token: string;
}

const requireServerAdministrator = async (
  database: SqlClient,
  principalId: number,
): Promise<void> => {
  const admin = await database.query(
    `SELECT 1 FROM noderag.principal p
     JOIN noderag.app_user u ON u.principal_id = p.id
     WHERE p.id = $1 AND u.server_admin AND NOT p.disabled AND p.deleted_at IS NULL`,
    [principalId],
  );
  if (admin.rowCount !== 1) throw new Error('server-admin-required');
};

export const createApiKeyInTransaction = async (
  database: SqlClient,
  input: CreateApiKeyInput,
): Promise<CreatedApiKey> => {
  const prefix = randomBase62(8);
  const token = `nrag_${prefix}_${randomBase62(43)}`;
  await requireServerAdministrator(database, input.createdBy);
  const principal = await database.query<{ id: number }>(
    `INSERT INTO noderag.principal (kind, label, created_by)
       VALUES ('api_key', $1, $2) RETURNING id`,
    [input.label, input.createdBy],
  );
  const principalId = databaseInteger(principal.rows[0]?.id, 'API key principal id');
  await database.query(
    `INSERT INTO noderag.api_key
         (principal_id, prefix, key_sha256, search_only, expires_at, cidr_allow, rate_per_min)
       VALUES ($1, $2, $3, $4, $5, $6::inet[], $7)`,
    [
      principalId,
      prefix,
      sha256(token),
      input.searchOnly ?? true,
      input.expiresAt ?? null,
      input.cidrAllow ?? null,
      input.ratePerMinute ?? null,
    ],
  );
  await database.query(
    `INSERT INTO noderag.audit_log (principal_id, action, result, detail)
       VALUES ($1, 'api_key.create', 'ok', jsonb_build_object('keyPrincipalId', $2::bigint, 'prefix', $3::text))`,
    [input.createdBy, principalId, prefix],
  );
  return { principalId, prefix, token };
};

export const createApiKey = async (pool: Pool, input: CreateApiKeyInput): Promise<CreatedApiKey> =>
  withTransaction(pool, (database) => createApiKeyInTransaction(database, input));

interface ApiKeyRow {
  readonly principal_id: number;
  readonly key_sha256: Buffer;
  readonly search_only: boolean;
  readonly expires_at: Date | null;
  readonly cidr_allow: string[] | null;
  readonly rate_per_min: number | null;
  readonly revoked_at: Date | null;
  readonly disabled: boolean;
  readonly deleted_at: Date | null;
}

interface RateWindow {
  readonly startedAt: number;
  readonly count: number;
}

export class ApiKeyRateLimiter {
  readonly #windows = new Map<number, RateWindow>();

  consume(principalId: number, maximum: number | null, now: Date): boolean {
    if (maximum === null) return true;
    const minute = Math.floor(now.getTime() / 60_000) * 60_000;
    const current = this.#windows.get(principalId);
    if (current === undefined || current.startedAt !== minute) {
      this.#windows.set(principalId, { startedAt: minute, count: 1 });
      return true;
    }
    if (current.count >= maximum) return false;
    this.#windows.set(principalId, { startedAt: minute, count: current.count + 1 });
    return true;
  }
}

const ipAllowed = (sourceIp: string, cidrs: readonly string[] | null): boolean => {
  if (cidrs === null || cidrs.length === 0) return true;
  const version = isIP(sourceIp);
  if (version === 0) return false;
  const family = version === 4 ? 'ipv4' : 'ipv6';
  const blockList = new BlockList();
  for (const cidr of cidrs) {
    const separator = cidr.lastIndexOf('/');
    if (separator === -1) {
      blockList.addAddress(cidr, family);
      continue;
    }
    const address = cidr.slice(0, separator);
    const prefix = Number(cidr.slice(separator + 1));
    if (isIP(address) !== version || !Number.isInteger(prefix)) return false;
    blockList.addSubnet(address, prefix, family);
  }
  return blockList.check(sourceIp, family);
};

export type ApiKeyAuthentication =
  | { readonly ok: true; readonly principalId: number; readonly searchOnly: boolean }
  | { readonly ok: false; readonly code: 'invalid-key' | 'cidr-denied' | 'rate-limited' };

export const authenticateApiKey = async (
  database: SqlClient,
  limiter: ApiKeyRateLimiter,
  token: string,
  sourceIp: string,
  now = new Date(),
): Promise<ApiKeyAuthentication> => {
  const match = /^nrag_([A-Za-z0-9]{8})_([A-Za-z0-9]{43})$/.exec(token);
  if (match === null) return { ok: false, code: 'invalid-key' };
  const found = await database.query<ApiKeyRow>(
    `SELECT k.principal_id, k.key_sha256, k.search_only, k.expires_at, k.cidr_allow,
            k.rate_per_min, k.revoked_at, p.disabled, p.deleted_at
     FROM noderag.api_key k
     JOIN noderag.principal p ON p.id = k.principal_id
     WHERE k.prefix = $1`,
    [match[1]],
  );
  const row = found.rows[0];
  const digest = sha256(token);
  if (
    row === undefined ||
    row.key_sha256.length !== digest.length ||
    !timingSafeEqual(row.key_sha256, digest) ||
    row.revoked_at !== null ||
    row.disabled ||
    row.deleted_at !== null ||
    (row.expires_at !== null && row.expires_at.getTime() <= now.getTime())
  ) {
    return { ok: false, code: 'invalid-key' };
  }
  const principalId = databaseInteger(row.principal_id, 'API key principal id');
  if (!ipAllowed(sourceIp, row.cidr_allow)) return { ok: false, code: 'cidr-denied' };
  if (!limiter.consume(principalId, row.rate_per_min, now)) {
    return { ok: false, code: 'rate-limited' };
  }
  await database.query(
    'UPDATE noderag.api_key SET last_used_at = $2, last_used_ip = $3 WHERE principal_id = $1',
    [row.principal_id, now, sourceIp],
  );
  return { ok: true, principalId, searchOnly: row.search_only };
};

export const revokeApiKey = async (
  database: SqlClient,
  principalId: number,
  revokedBy: number,
): Promise<void> => {
  await requireServerAdministrator(database, revokedBy);
  await database.query(
    `UPDATE noderag.api_key SET revoked_at = now()
     WHERE principal_id = $1 AND revoked_at IS NULL`,
    [principalId],
  );
  await database.query(
    `INSERT INTO noderag.audit_log (principal_id, action, result, detail)
     VALUES ($1, 'api_key.revoke', 'ok', jsonb_build_object('keyPrincipalId', $2::bigint))`,
    [revokedBy, principalId],
  );
};
