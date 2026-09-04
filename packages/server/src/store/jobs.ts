import type { Pool } from 'pg';
import { databaseInteger, withTransaction, type SqlClient } from './database.js';

export type JobErrorClass = 'transient' | 'permanent' | 'cancelled' | 'indeterminate';

export interface ClaimedJob {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly documentId: number | null;
  readonly sourceId: number | null;
  readonly siloId: number | null;
  readonly buildId: number | null;
  readonly attempts: number;
  readonly logicalAttempt: number;
  readonly maximumAttempts: number;
  readonly leaseOwner: string;
  readonly leaseEpoch: number;
  readonly leasedUntil: Date;
  readonly frozenConfig: Readonly<Record<string, unknown>>;
  readonly checkpoint: Readonly<Record<string, unknown>>;
}

export class ClassifiedJobError extends Error {
  constructor(
    readonly code: string,
    readonly errorClass: JobErrorClass,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ClassifiedJobError';
  }
}

export class JobCancellationError extends ClassifiedJobError {
  constructor(message = 'Job cancellation was requested.') {
    super('job-cancelled', 'cancelled', message);
    this.name = 'JobCancellationError';
  }
}

const permanentErrorCodes = new Set([
  'active-build-or-markdown-missing',
  'document-build-already-indexed',
  'document-not-found',
  'embed-job-missing-scope',
  'empty-canonical-markdown',
  'extract-job-missing-scope',
  'invalid-cached-vector',
  'invalid-embedding-vector',
  'markdown-hash-mismatch',
  'no-chunks-produced',
  'original-hash-mismatch',
  'TOKEN_LIMIT',
]);

const errorCode = (error: unknown): string => {
  if (error instanceof ClassifiedJobError) return error.code;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string')
    return error.code;
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 160);
  return 'unknown-worker-failure';
};

export const classifyJobError = (
  error: unknown,
): {
  readonly code: string;
  readonly errorClass: JobErrorClass;
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
} => {
  if (error instanceof ClassifiedJobError) {
    return {
      code: error.code,
      errorClass: error.errorClass,
      message: error.message.slice(0, 2000),
      detail: error.detail,
    };
  }
  const code = errorCode(error);
  const transientCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE']);
  return {
    code,
    errorClass: permanentErrorCodes.has(code)
      ? 'permanent'
      : transientCodes.has(code)
        ? 'transient'
        : 'indeterminate',
    message: error instanceof Error ? error.message.slice(0, 2000) : 'Unknown worker failure',
    detail: {},
  };
};

export const appendJobEvent = async (
  database: SqlClient,
  jobId: number,
  eventType: string,
  detail: Readonly<Record<string, unknown>> = {},
): Promise<number> => {
  const inserted = await database.query<{ sequence: number }>(
    `INSERT INTO noderag.job_event (job_id, sequence, event_type, detail)
     SELECT $1, COALESCE(max(sequence) + 1, 0), $2, $3
     FROM noderag.job_event WHERE job_id = $1
     RETURNING sequence`,
    [jobId, eventType, detail],
  );
  return inserted.rows[0]?.sequence ?? 0;
};

const validateLease = (leaseOwner: string, leaseMilliseconds: number): void => {
  if (leaseOwner.length < 1 || leaseOwner.length > 160) throw new Error('Invalid lease owner.');
  if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1000) {
    throw new Error('Lease duration must be at least one second.');
  }
};

export const claimNextJob = async (
  pool: Pool,
  leaseOwner: string,
  leaseMilliseconds = 60_000,
): Promise<ClaimedJob | null> => {
  validateLease(leaseOwner, leaseMilliseconds);
  return withTransaction(pool, async (database) => {
    const readiness = await database.query<{ state: string }>(
      'SELECT state FROM noderag.setup_state WHERE id = 1 FOR SHARE',
    );
    if (readiness.rows[0]?.state !== 'operational') return null;
    const claimed = await database.query<{
      id: unknown;
      kind: string;
      payload: unknown;
      document_id: unknown;
      source_id: unknown;
      silo_id: unknown;
      build_id: unknown;
      attempts: number;
      logical_attempt: number;
      max_attempts: number;
      lease_epoch: unknown;
      leased_until: Date;
      frozen_config: Record<string, unknown>;
      checkpoint: Record<string, unknown>;
      reclaimed: boolean;
    }>(
      `WITH candidate AS (
         SELECT j.id, j.state = 'leased' AS reclaimed
         FROM noderag.job j
         LEFT JOIN noderag.document_dispatch dispatch ON dispatch.document_id = j.document_id
         LEFT JOIN noderag.silo s ON s.id = j.silo_id
         WHERE ((j.state IN ('pending', 'retry_wait') AND j.run_after <= now())
                OR (j.state = 'leased' AND j.leased_until <= now()))
           AND j.cancel_requested_at IS NULL
           AND (s.id IS NULL OR s.lifecycle_state = 'active')
         ORDER BY j.priority,
                  COALESCE(dispatch.last_claimed_at, '-infinity'::timestamptz),
                  j.run_after, j.id
         FOR UPDATE OF j SKIP LOCKED LIMIT 1
       )
       UPDATE noderag.job j
       SET state = 'leased', lease_owner = $1,
           leased_until = now() + ($2::bigint * interval '1 millisecond'),
           heartbeat_at = now(), attempts = j.attempts + 1,
           logical_attempt = j.logical_attempt + CASE WHEN candidate.reclaimed THEN 0 ELSE 1 END,
           lease_epoch = j.lease_epoch + 1, retry_at = NULL,
           frozen_config = CASE WHEN j.frozen_config = '{}'::jsonb THEN
             jsonb_build_object(
               'schemaRevision', '000010_evaluation_baselines',
               'parserRevision', 2,
               'settings', COALESCE((
                 SELECT to_jsonb(settings) - 'updated_by'
                 FROM noderag.settings settings WHERE settings.id = 1
               ), '{}'::jsonb),
               'build', COALESCE((
                 SELECT to_jsonb(build) FROM noderag.build build WHERE build.id = j.build_id
               ), '{}'::jsonb),
               'model', COALESCE((
                 SELECT to_jsonb(model)
                 FROM noderag.model_manifest model
                 JOIN noderag.build build ON build.model_manifest_id = model.id
                 WHERE build.id = j.build_id
               ), '{}'::jsonb)
             ) ELSE j.frozen_config END,
           updated_at = now()
       FROM candidate
       WHERE j.id = candidate.id
       RETURNING j.id, j.kind, j.payload, j.document_id, j.source_id, j.silo_id,
                 j.build_id, j.attempts, j.logical_attempt, j.max_attempts,
                 j.lease_epoch, j.leased_until, j.frozen_config, j.checkpoint,
                 candidate.reclaimed`,
      [leaseOwner, leaseMilliseconds],
    );
    const row = claimed.rows[0];
    if (row === undefined) return null;
    const id = databaseInteger(row.id, 'job id');
    const documentId =
      row.document_id === null ? null : databaseInteger(row.document_id, 'job document id');
    if (documentId !== null) {
      await database.query(
        `INSERT INTO noderag.document_dispatch (document_id, last_claimed_at)
         VALUES ($1, now())
         ON CONFLICT (document_id) DO UPDATE SET last_claimed_at = EXCLUDED.last_claimed_at`,
        [documentId],
      );
    }
    const leaseEpoch = databaseInteger(row.lease_epoch, 'job lease epoch');
    await appendJobEvent(database, id, row.reclaimed ? 'lease_reclaimed' : 'leased', {
      owner: leaseOwner,
      leaseEpoch,
      logicalAttempt: row.logical_attempt,
    });
    return {
      id,
      kind: row.kind,
      payload: row.payload,
      documentId,
      sourceId: row.source_id === null ? null : databaseInteger(row.source_id, 'job source id'),
      siloId: row.silo_id === null ? null : databaseInteger(row.silo_id, 'job silo id'),
      buildId: row.build_id === null ? null : databaseInteger(row.build_id, 'job build id'),
      attempts: row.attempts,
      logicalAttempt: row.logical_attempt,
      maximumAttempts: row.max_attempts,
      leaseOwner,
      leaseEpoch,
      leasedUntil: row.leased_until,
      frozenConfig: row.frozen_config,
      checkpoint: row.checkpoint,
    };
  });
};

export const heartbeatJob = async (
  pool: Pool,
  job: ClaimedJob,
  leaseMilliseconds = 60_000,
  progress: Readonly<Record<string, unknown>> = {},
  checkpoint?: Readonly<Record<string, unknown>>,
): Promise<void> => {
  validateLease(job.leaseOwner, leaseMilliseconds);
  await withTransaction(pool, async (database) => {
    const updated = await database.query<{ cancel_requested_at: Date | null }>(
      `UPDATE noderag.job
       SET heartbeat_at = now(),
           leased_until = now() + ($4::bigint * interval '1 millisecond'),
           progress = progress || $5::jsonb,
           checkpoint = CASE WHEN $6::jsonb IS NULL THEN checkpoint ELSE checkpoint || $6::jsonb END,
           updated_at = now()
       WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_epoch = $3
       RETURNING cancel_requested_at`,
      [job.id, job.leaseOwner, job.leaseEpoch, leaseMilliseconds, progress, checkpoint ?? null],
    );
    const row = updated.rows[0];
    if (row === undefined) throw new Error('job-lease-lost');
    if (row.cancel_requested_at !== null) throw new JobCancellationError();
    if (Object.keys(progress).length > 0 || checkpoint !== undefined) {
      await appendJobEvent(database, job.id, 'progress', {
        leaseEpoch: job.leaseEpoch,
        ...progress,
      });
    }
  });
};

export const completeJob = async (
  database: SqlClient,
  job: ClaimedJob,
  detail: Readonly<Record<string, unknown>> = {},
): Promise<void> => {
  const result = await database.query(
    `UPDATE noderag.job
     SET state = 'succeeded', lease_owner = NULL, leased_until = NULL,
         heartbeat_at = NULL, result = $4, error_class = NULL,
         structured_error = NULL, finished_at = now(), updated_at = now()
     WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_epoch = $3
       AND cancel_requested_at IS NULL`,
    [job.id, job.leaseOwner, job.leaseEpoch, detail],
  );
  if (result.rowCount !== 1) throw new Error('job-lease-lost-or-cancelled');
  await appendJobEvent(database, job.id, 'succeeded', {
    leaseEpoch: job.leaseEpoch,
    ...detail,
  });
};

export const cancelClaimedJob = async (
  pool: Pool,
  job: ClaimedJob,
  detail: Readonly<Record<string, unknown>> = {},
): Promise<void> => {
  await withTransaction(pool, async (database) => {
    const result = await database.query(
      `UPDATE noderag.job
       SET state = 'cancelled', lease_owner = NULL, leased_until = NULL,
           heartbeat_at = NULL, error_class = 'cancelled',
           structured_error = jsonb_build_object('code', 'job-cancelled'),
           finished_at = now(), updated_at = now()
       WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_epoch = $3`,
      [job.id, job.leaseOwner, job.leaseEpoch],
    );
    if (result.rowCount !== 1) return;
    await appendJobEvent(database, job.id, 'cancelled', {
      leaseEpoch: job.leaseEpoch,
      ...detail,
    });
  });
};

export const failJob = async (pool: Pool, job: ClaimedJob, error: unknown): Promise<void> => {
  const failure = classifyJobError(error);
  if (failure.errorClass === 'cancelled') {
    await cancelClaimedJob(pool, job, { code: failure.code });
    return;
  }
  await withTransaction(pool, async (database) => {
    const terminal =
      failure.errorClass === 'permanent' || job.logicalAttempt >= job.maximumAttempts;
    const delayMilliseconds = Math.min(60_000, 1000 * 2 ** Math.max(0, job.logicalAttempt - 1));
    const nextState = terminal ? 'failed' : 'retry_wait';
    const result = await database.query(
      `UPDATE noderag.job
       SET state = $4, lease_owner = NULL, leased_until = NULL, heartbeat_at = NULL,
           run_after = CASE WHEN $4 = 'retry_wait'
             THEN now() + ($5::bigint * interval '1 millisecond') ELSE run_after END,
           retry_at = CASE WHEN $4 = 'retry_wait'
             THEN now() + ($5::bigint * interval '1 millisecond') ELSE NULL END,
           last_error_code = $6, last_error_detail = $7, error_class = $8,
           structured_error = jsonb_build_object('code', $6::text, 'message', $7::text,
                                                  'class', $8::text, 'detail', $9::jsonb),
           finished_at = CASE WHEN $4 = 'failed' THEN now() ELSE NULL END,
           updated_at = now()
       WHERE id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_epoch = $3`,
      [
        job.id,
        job.leaseOwner,
        job.leaseEpoch,
        nextState,
        delayMilliseconds,
        failure.code,
        failure.message,
        failure.errorClass,
        failure.detail,
      ],
    );
    if (result.rowCount !== 1) return;
    await appendJobEvent(database, job.id, terminal ? 'failed' : 'retry_scheduled', {
      attempt: job.logicalAttempt,
      leaseEpoch: job.leaseEpoch,
      delayMilliseconds: terminal ? null : delayMilliseconds,
      errorClass: failure.errorClass,
      code: failure.code,
    });
    if (terminal && job.documentId !== null && job.kind !== 'vision') {
      await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
        job.siloId === null ? '{}' : `{${String(job.siloId)}}`,
      ]);
      await database.query(
        `UPDATE noderag.document SET state = 'failed', error_code = $2, error_detail = $3
         WHERE id = $1 AND ($4::smallint IS NULL OR silo_id = $4)`,
        [job.documentId, failure.code, failure.message, job.siloId],
      );
    }
  });
};

export const requestJobCancellation = async (
  pool: Pool,
  jobId: number,
  siloId: number,
): Promise<'requested' | 'cancelled' | 'terminal' | 'not_found'> =>
  withTransaction(pool, async (database) => {
    await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [`{${String(siloId)}}`]);
    const found = await database.query<{ state: string }>(
      `SELECT state FROM noderag.job WHERE id = $1 AND silo_id = $2 FOR UPDATE`,
      [jobId, siloId],
    );
    const state = found.rows[0]?.state;
    if (state === undefined) return 'not_found';
    if (['succeeded', 'failed', 'cancelled'].includes(state)) return 'terminal';
    const immediate = state !== 'leased';
    await database.query(
      `UPDATE noderag.job
       SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
           state = CASE WHEN $3 THEN 'cancelled' ELSE state END,
           error_class = CASE WHEN $3 THEN 'cancelled' ELSE error_class END,
           finished_at = CASE WHEN $3 THEN now() ELSE finished_at END,
           updated_at = now()
       WHERE id = $1 AND silo_id = $2`,
      [jobId, siloId, immediate],
    );
    await appendJobEvent(database, jobId, immediate ? 'cancelled' : 'cancellation_requested');
    return immediate ? 'cancelled' : 'requested';
  });

const transitionJob = async (
  pool: Pool,
  jobId: number,
  siloId: number,
  fromStates: readonly string[],
  toState: 'paused' | 'pending',
  eventType: string,
): Promise<boolean> =>
  withTransaction(pool, async (database) => {
    await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [`{${String(siloId)}}`]);
    const result = await database.query(
      `UPDATE noderag.job
       SET state = $4,
           run_after = CASE WHEN $4 = 'pending' THEN now() ELSE run_after END,
           retry_at = CASE WHEN $4 = 'pending' THEN NULL ELSE retry_at END,
           updated_at = now()
       WHERE id = $1 AND silo_id = $2 AND state = ANY ($3::text[])
         AND cancel_requested_at IS NULL`,
      [jobId, siloId, fromStates, toState],
    );
    if (result.rowCount !== 1) return false;
    await appendJobEvent(database, jobId, eventType);
    return true;
  });

export const pauseJob = async (pool: Pool, jobId: number, siloId: number): Promise<boolean> =>
  transitionJob(pool, jobId, siloId, ['pending', 'retry_wait'], 'paused', 'paused');

export const resumeJob = async (pool: Pool, jobId: number, siloId: number): Promise<boolean> =>
  transitionJob(pool, jobId, siloId, ['paused'], 'pending', 'resumed');

export const retryJob = async (pool: Pool, jobId: number, siloId: number): Promise<boolean> =>
  withTransaction(pool, async (database) => {
    await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [`{${String(siloId)}}`]);
    const result = await database.query(
      `UPDATE noderag.job
       SET state = 'pending', logical_attempt = 0, run_after = now(), retry_at = NULL,
           cancel_requested_at = NULL, error_class = NULL, structured_error = NULL,
           last_error_code = NULL, last_error_detail = NULL, finished_at = NULL,
           updated_at = now()
       WHERE id = $1 AND silo_id = $2 AND state IN ('failed', 'cancelled')`,
      [jobId, siloId],
    );
    if (result.rowCount !== 1) return false;
    await appendJobEvent(database, jobId, 'manual_retry');
    return true;
  });
