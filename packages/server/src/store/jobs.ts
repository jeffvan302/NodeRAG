import type { Pool } from 'pg';
import { databaseInteger, withTransaction, type SqlClient } from './database.js';

export interface ClaimedJob {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly documentId: number | null;
  readonly siloId: number | null;
  readonly buildId: number | null;
  readonly attempts: number;
  readonly leasedUntil: Date;
}

export const claimNextJob = async (
  pool: Pool,
  leaseOwner: string,
  leaseMilliseconds = 60_000,
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
      document_id: unknown;
      silo_id: unknown;
      build_id: unknown;
      attempts: number;
    }>(
      `SELECT id, kind, payload, document_id, silo_id, build_id, attempts FROM noderag.job
       WHERE ((state IN ('pending', 'retry_wait') AND run_after <= now())
              OR (state = 'leased' AND leased_until <= now()))
       ORDER BY priority, run_after, id
       FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const row = available.rows[0];
    if (row === undefined) return null;
    const id = databaseInteger(row.id, 'job id');
    const lease = await database.query<{ leased_until: Date }>(
      `UPDATE noderag.job
       SET state = 'leased', lease_owner = $2,
           leased_until = now() + ($3::bigint * interval '1 millisecond'),
           attempts = attempts + 1, updated_at = now()
       WHERE id = $1 RETURNING leased_until`,
      [id, leaseOwner, leaseMilliseconds],
    );
    const leasedUntil = lease.rows[0]?.leased_until;
    if (leasedUntil === undefined) throw new Error('job-lease-update-failed');
    await database.query(
      `INSERT INTO noderag.job_event (job_id, sequence, event_type, detail)
       SELECT $1, COALESCE(max(sequence) + 1, 0), 'leased',
              jsonb_build_object('owner', $2::text)
       FROM noderag.job_event WHERE job_id = $1`,
      [id, leaseOwner],
    );
    return {
      id,
      kind: row.kind,
      payload: row.payload,
      documentId:
        row.document_id === null ? null : databaseInteger(row.document_id, 'job document id'),
      siloId: row.silo_id === null ? null : databaseInteger(row.silo_id, 'job silo id'),
      buildId: row.build_id === null ? null : databaseInteger(row.build_id, 'job build id'),
      attempts: row.attempts + 1,
      leasedUntil,
    };
  });
};

export const appendJobEvent = async (
  database: SqlClient,
  jobId: number,
  eventType: string,
  detail: Readonly<Record<string, unknown>> = {},
): Promise<void> => {
  await database.query(
    `INSERT INTO noderag.job_event (job_id, sequence, event_type, detail)
     SELECT $1, COALESCE(max(sequence) + 1, 0), $2, $3
     FROM noderag.job_event WHERE job_id = $1`,
    [jobId, eventType, detail],
  );
};

export const completeJob = async (
  database: SqlClient,
  jobId: number,
  leaseOwner: string,
  detail: Readonly<Record<string, unknown>> = {},
): Promise<void> => {
  const result = await database.query(
    `UPDATE noderag.job
     SET state = 'succeeded', lease_owner = NULL, leased_until = NULL,
         finished_at = now(), updated_at = now()
     WHERE id = $1 AND state = 'leased' AND lease_owner = $2`,
    [jobId, leaseOwner],
  );
  if (result.rowCount !== 1) throw new Error('job-lease-lost');
  await appendJobEvent(database, jobId, 'succeeded', detail);
};

export const failJob = async (
  pool: Pool,
  job: ClaimedJob,
  leaseOwner: string,
  error: unknown,
): Promise<void> => {
  await withTransaction(pool, async (database) => {
    const terminal = job.attempts >= 5;
    const delayMilliseconds = Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempts - 1));
    const result = await database.query(
      `UPDATE noderag.job
       SET state = $3, lease_owner = NULL, leased_until = NULL,
           run_after = now() + ($4::bigint * interval '1 millisecond'),
           last_error_code = $5, last_error_detail = $6,
           finished_at = CASE WHEN $3 = 'failed' THEN now() ELSE NULL END,
           updated_at = now()
       WHERE id = $1 AND state = 'leased' AND lease_owner = $2`,
      [
        job.id,
        leaseOwner,
        terminal ? 'failed' : 'retry_wait',
        delayMilliseconds,
        error instanceof Error ? error.name : 'Error',
        error instanceof Error ? error.message.slice(0, 2000) : 'Unknown worker failure',
      ],
    );
    if (result.rowCount !== 1) return;
    await appendJobEvent(database, job.id, terminal ? 'failed' : 'retry_scheduled', {
      attempt: job.attempts,
      delayMilliseconds,
    });
    if (terminal && job.documentId !== null) {
      await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
        job.siloId === null ? '{}' : `{${String(job.siloId)}}`,
      ]);
      await database.query(
        `UPDATE noderag.document SET state = 'failed', error_code = $2, error_detail = $3
         WHERE id = $1 AND ($4::smallint IS NULL OR silo_id = $4)`,
        [
          job.documentId,
          error instanceof Error ? error.name : 'Error',
          error instanceof Error ? error.message.slice(0, 2000) : 'Unknown worker failure',
          job.siloId,
        ],
      );
    }
  });
};
