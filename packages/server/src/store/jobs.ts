import type { Pool } from 'pg';
import { databaseInteger, withTransaction } from './database.js';

export interface ClaimedJob {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly leasedUntil: Date;
}

export const claimNextJob = async (
  pool: Pool,
  leaseOwner: string,
  leaseMilliseconds = 60_000,
  now = new Date(),
): Promise<ClaimedJob | null> => {
  if (leaseOwner.length < 1 || leaseOwner.length > 160) throw new Error('Invalid lease owner.');
  if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1000) {
    throw new Error('Lease duration must be at least one second.');
  }
  return withTransaction(pool, async (database) => {
    const readiness = await database.query<{ state: string }>(
      'SELECT state FROM noderag.setup_state WHERE id = 1 FOR SHARE',
    );
    if (readiness.rows[0]?.state !== 'operational') return null;
    const available = await database.query<{
      id: unknown;
      kind: string;
      payload: unknown;
      attempts: number;
    }>(
      `SELECT id, kind, payload, attempts FROM noderag.job
       WHERE state IN ('pending', 'retry_wait') AND run_after <= $1
       ORDER BY priority, run_after, id
       FOR UPDATE SKIP LOCKED LIMIT 1`,
      [now],
    );
    const row = available.rows[0];
    if (row === undefined) return null;
    const id = databaseInteger(row.id, 'job id');
    const leasedUntil = new Date(now.getTime() + leaseMilliseconds);
    await database.query(
      `UPDATE noderag.job
       SET state = 'leased', lease_owner = $2, leased_until = $3,
           attempts = attempts + 1, updated_at = $4
       WHERE id = $1`,
      [id, leaseOwner, leasedUntil, now],
    );
    await database.query(
      `INSERT INTO noderag.job_event (job_id, sequence, event_type, detail)
       SELECT $1, COALESCE(max(sequence) + 1, 0), 'leased',
              jsonb_build_object('owner', $2::text)
       FROM noderag.job_event WHERE job_id = $1`,
      [id, leaseOwner],
    );
    return { id, kind: row.kind, payload: row.payload, attempts: row.attempts + 1, leasedUntil };
  });
};
