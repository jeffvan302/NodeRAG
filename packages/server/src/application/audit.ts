import { createHash } from 'node:crypto';
import type { SqlClient } from '../store/database.js';

const forbiddenDetailKey = /(authorization|body|cookie|password|query|secret|token)/i;

const sanitizeValue = (value: unknown): unknown => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenDetailKey.test(key)) continue;
      sanitized[key] = sanitizeValue(child);
    }
    return sanitized;
  }
  return String(value);
};

export const hashNormalizedQuery = (query: string): Buffer => {
  const normalized = query.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  return createHash('sha256').update(normalized, 'utf8').digest();
};

export interface AuditEvent {
  readonly principalId?: number;
  readonly gatewayId?: number;
  readonly siloId?: number;
  readonly action: string;
  readonly result: 'ok' | 'denied' | 'error';
  readonly normalizedQuerySha256?: Uint8Array;
  readonly rowCount?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly sourceIp?: string;
  readonly requestId?: string;
}

export const writeAuditEvent = async (database: SqlClient, event: AuditEvent): Promise<void> => {
  await database.query(
    `INSERT INTO noderag.audit_log
       (principal_id, gateway_id, silo_id, action, result, query_sha256,
        row_count, detail, source_ip, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      event.principalId ?? null,
      event.gatewayId ?? null,
      event.siloId ?? null,
      event.action,
      event.result,
      event.normalizedQuerySha256 ?? null,
      event.rowCount ?? null,
      sanitizeValue(event.detail ?? {}),
      event.sourceIp ?? null,
      event.requestId ?? null,
    ],
  );
};

export const cleanExpiredAuditEvents = async (
  database: SqlClient,
  batchSize = 1000,
): Promise<number> => {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new Error('Audit cleanup batch must be between 1 and 10000.');
  }
  const deleted = await database.query(
    `WITH expired AS (
       SELECT a.id FROM noderag.audit_log a
       CROSS JOIN noderag.settings s
       WHERE a.occurred_at < now() - make_interval(days => s.audit_retention_days)
       ORDER BY a.id LIMIT $1
     )
     DELETE FROM noderag.audit_log a USING expired e WHERE a.id = e.id`,
    [batchSize],
  );
  return deleted.rowCount ?? 0;
};
