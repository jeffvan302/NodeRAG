import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type SqlClient } from '../store/database.js';

export interface StoredResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface IdempotentOperationInput {
  readonly principalId: number;
  readonly operation: string;
  readonly key: string;
  readonly request: string | Uint8Array;
  readonly ttlMilliseconds?: number;
  readonly now?: Date;
}

export interface IdempotentOperationResult {
  readonly replayed: boolean;
  readonly response: StoredResponse;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('The Idempotency-Key was already used with a different request digest.');
    this.name = 'IdempotencyConflictError';
  }
}

const digest = (request: string | Uint8Array): Buffer =>
  createHash('sha256').update(request).digest();

interface IdempotencyRow {
  readonly request_sha256: Buffer;
  readonly response_status: number | null;
  readonly response_headers: Record<string, string> | null;
  readonly response_body: unknown;
  readonly completed_at: Date | null;
}

export const executeIdempotent = async (
  pool: Pool,
  input: IdempotentOperationInput,
  operation: (database: SqlClient) => Promise<StoredResponse>,
): Promise<IdempotentOperationResult> => {
  if (input.key.length < 8 || input.key.length > 200) throw new Error('Invalid Idempotency-Key.');
  if (input.operation.length < 1 || input.operation.length > 120) {
    throw new Error('Invalid idempotency operation.');
  }
  const requestDigest = digest(input.request);
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMilliseconds ?? 24 * 60 * 60_000));
  return withTransaction(pool, async (database) => {
    await database.query(
      `INSERT INTO noderag.idempotency_record
         (principal_id, operation, idempotency_key, request_sha256, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [input.principalId, input.operation, input.key, requestDigest, expiresAt],
    );
    const found = await database.query<IdempotencyRow>(
      `SELECT request_sha256, response_status, response_headers, response_body, completed_at
       FROM noderag.idempotency_record
       WHERE principal_id = $1 AND operation = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [input.principalId, input.operation, input.key],
    );
    const row = found.rows[0];
    if (row === undefined) throw new Error('Idempotency record disappeared.');
    if (!row.request_sha256.equals(requestDigest)) throw new IdempotencyConflictError();
    if (row.completed_at !== null && row.response_status !== null) {
      return {
        replayed: true,
        response: {
          status: row.response_status,
          headers: row.response_headers ?? {},
          body: row.response_body,
        },
      };
    }
    const response = await operation(database);
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      throw new Error('Invalid stored response status.');
    }
    await database.query(
      `UPDATE noderag.idempotency_record
       SET response_status = $4, response_headers = $5, response_body = $6,
           completed_at = $7, expires_at = $8
       WHERE principal_id = $1 AND operation = $2 AND idempotency_key = $3`,
      [
        input.principalId,
        input.operation,
        input.key,
        response.status,
        response.headers,
        response.body,
        now,
        expiresAt,
      ],
    );
    return { replayed: false, response };
  });
};
