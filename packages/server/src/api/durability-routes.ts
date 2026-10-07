import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readinessStateSchema } from '@noderag/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import { readinessPermits } from '../application/readiness-policy.js';
import { SiloScope, withSiloScope } from '../identity/scope.js';
import {
  detachSource,
  browseSourceFolders,
  enqueueSourceCrawl,
  registerSource,
  sourceDigest,
  validateSourceGlobs,
  validateSourceRoot,
} from '../ingest/sources.js';
import { setupStatus } from '../setup/bootstrap.js';
import type { DocumentFileStore } from '../storage/document-files.js';
import { databaseInteger } from '../store/database.js';
import { pauseJob, requestJobCancellation, resumeJob, retryJob } from '../store/jobs.js';
import { continueDocumentPurge, purgeSiloCompletely, startDocumentPurge } from '../store/purge.js';
import type { RequestAuthenticator, AuthenticatedPrincipal } from './authentication.js';

const idSchema = z.coerce.number().int().positive();
const sourceBodySchema = z.object({
  siloId: z.number().int().min(1).max(32_767),
  uri: z.string().min(1).max(4096),
  includeGlobs: z.array(z.string()).max(64).default(['**/*.md']),
  excludeGlobs: z.array(z.string()).max(64).default([]),
  scheduleIntervalMinutes: z.number().int().min(1).max(525_600).nullable().default(null),
  operatorNote: z.string().max(2000).optional(),
});
const sourceListQuerySchema = z.object({
  siloIds: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined ? undefined : value.split(',').map((item) => idSchema.parse(item.trim())),
    ),
});
const sourceFolderQuerySchema = z.object({
  siloId: z.coerce.number().int().min(1).max(32_767),
  path: z.string().min(1).max(4096).optional(),
});
const crawlBodySchema = z.object({ siloId: z.number().int().min(1).max(32_767) });
const sourcePatchSchema = z.object({
  siloId: z.number().int().min(1).max(32_767),
  uri: z.string().min(1).max(4096).optional(),
  includeGlobs: z.array(z.string()).max(64).optional(),
  excludeGlobs: z.array(z.string()).max(64).optional(),
  scheduleIntervalMinutes: z.number().int().min(1).max(525_600).nullable().optional(),
  scheduleEnabled: z.boolean().optional(),
  operatorNote: z.string().max(2000).nullable().optional(),
});
const missingReviewSchema = z.object({
  siloId: z.number().int().min(1).max(32_767),
  documentId: z.number().int().positive(),
  operatorNote: z.string().min(1).max(2000),
});
const jobActionBodySchema = z.object({ siloId: z.number().int().min(1).max(32_767) });
const documentPurgeBodySchema = z.object({
  siloId: z.number().int().min(1).max(32_767),
  confirmDocumentId: z.number().int().positive(),
});
const documentReindexBodySchema = z.object({
  siloId: z.number().int().min(1).max(32_767),
  enhanced: z.boolean().default(true),
});
const siloPurgeBodySchema = z.object({ confirmSlug: z.string().min(2).max(63) });
const eventQuerySchema = z.object({ once: z.coerce.boolean().default(false) });
const ingestionLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
});

const problem = (status: number, code: string, requestId: string) => ({
  type: `https://noderag.local/problems/${code}`,
  title: code.replaceAll('_', ' '),
  status,
  code,
  requestId,
});

const requirePrincipal = async (
  request: FastifyRequest,
  authenticate: RequestAuthenticator,
): Promise<AuthenticatedPrincipal | null> => authenticate(request);

const mutationAllowed = (principal: AuthenticatedPrincipal, request: FastifyRequest): boolean =>
  principal.csrfAllowed(request.headers['x-csrf-token']?.toString(), request.headers.origin);

const requireIdempotencyKey = (request: FastifyRequest): string => {
  const key = request.headers['idempotency-key']?.toString();
  if (key === undefined) throw new Error('idempotency_key_required');
  return key;
};

const stableDigest = (value: unknown): string => JSON.stringify(value);

export const sourceCreationFailure = (
  error: unknown,
  fallback = 'source-create-failed',
): { readonly status: number; readonly code: string } => {
  const message = error instanceof Error ? error.message : '';
  const databaseOrSystemCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  if (databaseOrSystemCode === '23505') return { status: 409, code: 'source-already-connected' };
  if (databaseOrSystemCode === '23503') return { status: 404, code: 'silo-not-found' };
  if (databaseOrSystemCode === 'ENOENT') return { status: 404, code: 'source-folder-not-found' };
  if (databaseOrSystemCode === 'EACCES' || databaseOrSystemCode === 'EPERM')
    return { status: 403, code: 'source-folder-unreadable' };
  if (databaseOrSystemCode === 'ENOTDIR') return { status: 400, code: 'source-root-not-directory' };
  if (message === 'source-folder-not-found')
    return { status: 404, code: 'source-folder-not-found' };
  if (message === 'source-folder-unreadable')
    return { status: 403, code: 'source-folder-unreadable' };
  if (
    message.startsWith('source-root') ||
    ['invalid-source-glob', 'too-many-source-globs', 'invalid-source-schedule'].includes(message)
  ) {
    return { status: 400, code: message };
  }
  return { status: 500, code: fallback };
};

const readinessAllows = async (pool: Pool, routeClass: 'read' | 'mutation'): Promise<boolean> =>
  readinessPermits(readinessStateSchema.parse((await setupStatus(pool)).state), routeClass);

export interface DurabilityRoutesOptions {
  readonly pool: Pool;
  readonly authenticate: RequestAuthenticator;
  readonly files: DocumentFileStore;
  readonly sourceRoots: readonly string[];
  readonly logRoot?: string;
}

export const recentStructuredErrors = async (logRoot: string | undefined) => {
  if (logRoot === undefined) return [];
  const errors: Array<Record<string, unknown>> = [];
  for (const service of ['noderag', 'worker', 'embedder', 'postgresql']) {
    const content = await readFile(resolve(logRoot, `${service}.log`), 'utf8').catch(() => '');
    for (const line of content.split('\n').slice(-500)) {
      if (!line.startsWith('{')) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const level = typeof entry['level'] === 'number' ? entry['level'] : 0;
        const event = typeof entry['event'] === 'string' ? entry['event'] : undefined;
        const code = typeof entry['code'] === 'string' ? entry['code'] : undefined;
        if (level < 40 && code === undefined && !(event ?? '').match(/fail|error/iu)) continue;
        errors.push({
          service,
          ...(typeof entry['time'] === 'number' ? { time: entry['time'] } : {}),
          ...(level === 0 ? {} : { level }),
          ...(event === undefined ? {} : { event }),
          ...(code === undefined ? {} : { code }),
          ...(typeof entry['errorName'] === 'string' ? { errorName: entry['errorName'] } : {}),
          ...(typeof entry['requestId'] === 'string' ? { requestId: entry['requestId'] } : {}),
        });
      } catch {
        // Lifecycle tools may emit non-JSON status lines; they are intentionally not exposed.
      }
    }
  }
  return errors.slice(-100).reverse();
};

const readJobEvents = async (
  pool: Pool,
  siloIds: readonly number[],
  cursor: { readonly jobId: number; readonly sequence: number },
) =>
  pool.query<{
    job_id: unknown;
    sequence: number;
    event_type: string;
    detail: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT event.job_id, event.sequence, event.event_type, event.detail, event.created_at
     FROM noderag.job_event event
     JOIN noderag.job job ON job.id = event.job_id
     WHERE job.silo_id = ANY ($1::smallint[])
       AND (event.job_id > $2 OR (event.job_id = $2 AND event.sequence > $3))
     ORDER BY event.job_id, event.sequence LIMIT 200`,
    [siloIds, cursor.jobId, cursor.sequence],
  );

const eventCursor = (value: string | undefined): { jobId: number; sequence: number } => {
  if (value === undefined || value.length === 0) return { jobId: 0, sequence: -1 };
  const match = /^(\d+):(\d+)$/u.exec(value);
  if (match === null) throw new Error('invalid-last-event-id');
  return { jobId: idSchema.parse(match[1]), sequence: Number(match[2]) };
};

const eventBody = (
  rows: readonly {
    readonly job_id: unknown;
    readonly sequence: number;
    readonly event_type: string;
    readonly detail: Record<string, unknown>;
    readonly created_at: Date;
  }[],
): string =>
  rows
    .map((row) => {
      const jobId = databaseInteger(row.job_id, 'event job id');
      return `id: ${String(jobId)}:${String(row.sequence)}\nevent: ${row.event_type}\ndata: ${JSON.stringify(
        {
          jobId,
          sequence: row.sequence,
          detail: row.detail,
          createdAt: row.created_at.toISOString(),
        },
      )}\n\n`;
    })
    .join('');

export const registerDurabilityRoutes = (
  app: FastifyInstance,
  options: DurabilityRoutesOptions,
): void => {
  app.get('/v1/source-folders', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!(await readinessAllows(options.pool, 'read')))
      return reply.code(503).send(problem(503, 'read_not_ready', request.id));
    const query = sourceFolderQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'configure_source', {
      requestedSiloIds: [query.data.siloId],
    });
    if (!scope.includes(query.data.siloId))
      return reply.code(404).send(problem(404, 'not_found', request.id));
    try {
      return reply.send(await browseSourceFolders(query.data.path, options.sourceRoots));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'source-folder-browse-failed';
      const status = code === 'source-folder-not-found' ? 404 : 400;
      return reply.code(status).send(problem(status, code, request.id));
    }
  });

  app.post('/v1/sources', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!mutationAllowed(principal, request))
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    if (!(await readinessAllows(options.pool, 'mutation')))
      return reply.code(503).send(problem(503, 'mutation_not_ready', request.id));
    const body = sourceBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'configure_source', {
      requestedSiloIds: [body.data.siloId],
    });
    if (!scope.includes(body.data.siloId))
      return reply.code(404).send(problem(404, 'silo_not_found', request.id));
    try {
      const verifiedUri = await validateSourceRoot(body.data.uri, options.sourceRoots);
      const key = requireIdempotencyKey(request);
      const registration = {
        siloId: body.data.siloId,
        principalId: principal.principalId,
        uri: verifiedUri,
        includeGlobs: body.data.includeGlobs,
        excludeGlobs: body.data.excludeGlobs,
        scheduleIntervalMinutes: body.data.scheduleIntervalMinutes,
        ...(body.data.operatorNote === undefined ? {} : { operatorNote: body.data.operatorNote }),
      };
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `source-create:${String(body.data.siloId)}`,
          key,
          request: sourceDigest(registration),
        },
        async (database) => {
          await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
            scope.postgresArray(),
          ]);
          return { status: 201, headers: {}, body: await registerSource(database, registration) };
        },
      );
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      if (error instanceof Error && error.message === 'idempotency_key_required')
        return reply.code(400).send(problem(400, error.message, request.id));
      const failure = sourceCreationFailure(error);
      request.log.error(
        {
          errorName: error instanceof Error ? error.name : 'unknown',
          code: failure.code,
          requestId: request.id,
        },
        'source creation failed',
      );
      return reply.code(failure.status).send(problem(failure.status, failure.code, request.id));
    }
  });

  app.get('/v1/sources', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!(await readinessAllows(options.pool, 'read')))
      return reply.code(503).send(problem(503, 'read_not_ready', request.id));
    const query = sourceListQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'upload', {
      ...(query.data.siloIds === undefined ? {} : { requestedSiloIds: query.data.siloIds }),
    });
    if (scope.siloIds.length === 0) return reply.send({ items: [] });
    const sources = await withSiloScope(options.pool, scope, (database) =>
      database.query(
        `SELECT id, silo_id AS "siloId", uri, include_glob AS "includeGlobs",
                exclude_glob AS "excludeGlobs", schedule_enabled AS "scheduleEnabled",
                schedule_interval_minutes AS "scheduleIntervalMinutes",
                health_state AS "healthState", last_crawl_at AS "lastCrawlAt",
                next_crawl_at AS "nextCrawlAt", operator_note AS "operatorNote"
         FROM noderag.source WHERE silo_id = ANY ($1::smallint[]) ORDER BY id`,
        [scope.siloIds],
      ),
    );
    return reply.send({ items: sources.rows });
  });

  app.get('/v1/sources/:id', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    const sourceId = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!sourceId.success) return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'upload');
    const found = await withSiloScope(options.pool, scope, (database) =>
      database.query(
        `SELECT id, silo_id AS "siloId", uri, include_glob AS "includeGlobs",
                exclude_glob AS "excludeGlobs", schedule_enabled AS "scheduleEnabled",
                schedule_interval_minutes AS "scheduleIntervalMinutes",
                health_state AS "healthState", health_error AS "healthError",
                last_crawl_at AS "lastCrawlAt", next_crawl_at AS "nextCrawlAt",
                operator_note AS "operatorNote"
         FROM noderag.source WHERE id = $1`,
        [sourceId.data],
      ),
    );
    const row = found.rows[0];
    return row === undefined
      ? reply.code(404).send(problem(404, 'not_found', request.id))
      : reply.send(row);
  });

  app.post('/v1/sources/:id/crawl', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!mutationAllowed(principal, request))
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    const sourceId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = crawlBodySchema.safeParse(request.body);
    if (!sourceId.success || !body.success)
      return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'reindex', {
      requestedSiloIds: [body.data.siloId],
    });
    if (!scope.includes(body.data.siloId))
      return reply.code(404).send(problem(404, 'not_found', request.id));
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `source-crawl:${String(sourceId.data)}`,
          key: requireIdempotencyKey(request),
          request: stableDigest({ sourceId: sourceId.data, siloId: body.data.siloId }),
        },
        async (database) => {
          await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
            scope.postgresArray(),
          ]);
          const source = await database.query(
            `SELECT 1 FROM noderag.source WHERE id = $1 AND silo_id = $2`,
            [sourceId.data, body.data.siloId],
          );
          if (source.rowCount !== 1) throw new Error('source-not-found');
          const jobId = await enqueueSourceCrawl(
            database,
            sourceId.data,
            body.data.siloId,
            principal.principalId,
          );
          return { status: 202, headers: {}, body: { jobId } };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      const code = error instanceof Error ? error.message : 'crawl-failed';
      return reply
        .code(code === 'source-not-found' ? 404 : 400)
        .send(problem(code === 'source-not-found' ? 404 : 400, code, request.id));
    }
  });

  app.patch('/v1/sources/:id', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!mutationAllowed(principal, request))
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    const sourceId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = sourcePatchSchema.safeParse(request.body);
    if (!sourceId.success || !body.success)
      return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'configure_source', {
      requestedSiloIds: [body.data.siloId],
    });
    if (!scope.includes(body.data.siloId))
      return reply.code(404).send(problem(404, 'not_found', request.id));
    try {
      const verifiedUri =
        body.data.uri === undefined
          ? undefined
          : await validateSourceRoot(body.data.uri, options.sourceRoots);
      if (body.data.includeGlobs !== undefined) validateSourceGlobs(body.data.includeGlobs);
      if (body.data.excludeGlobs !== undefined) validateSourceGlobs(body.data.excludeGlobs);
      const update = { ...body.data, ...(verifiedUri === undefined ? {} : { uri: verifiedUri }) };
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `source-update:${String(sourceId.data)}`,
          key: requireIdempotencyKey(request),
          request: stableDigest(update),
        },
        async (database) => {
          await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
            scope.postgresArray(),
          ]);
          const updated = await database.query(
            `UPDATE noderag.source
             SET uri = COALESCE($3, uri),
                 include_glob = COALESCE($4, include_glob),
                 exclude_glob = COALESCE($5, exclude_glob),
                 schedule_interval_minutes = CASE WHEN $6 THEN $7 ELSE schedule_interval_minutes END,
                 schedule_enabled = COALESCE($8, schedule_enabled),
                 operator_note = CASE WHEN $9 THEN $10 ELSE operator_note END,
                 next_crawl_at = CASE
                   WHEN COALESCE($8, schedule_enabled)
                     AND (CASE WHEN $6 THEN $7 ELSE schedule_interval_minutes END) IS NOT NULL
                   THEN now() + ((CASE WHEN $6 THEN $7 ELSE schedule_interval_minutes END)::bigint
                                  * interval '1 minute')
                   ELSE NULL END
             WHERE id = $1 AND silo_id = $2
             RETURNING id, silo_id AS "siloId", uri,
                       schedule_enabled AS "scheduleEnabled",
                       schedule_interval_minutes AS "scheduleIntervalMinutes"`,
            [
              sourceId.data,
              body.data.siloId,
              update.uri ?? null,
              update.includeGlobs ?? null,
              update.excludeGlobs ?? null,
              update.scheduleIntervalMinutes !== undefined,
              update.scheduleIntervalMinutes ?? null,
              update.scheduleEnabled ?? null,
              update.operatorNote !== undefined,
              update.operatorNote ?? null,
            ],
          );
          const row = updated.rows[0];
          if (row === undefined) throw new Error('source-not-found');
          await database.query(
            `INSERT INTO noderag.audit_log (principal_id, silo_id, action, result, detail)
             VALUES ($1, $2, 'source.update', 'ok',
                     jsonb_build_object('sourceId', $3::bigint,
                                        'scheduleEnabled', $4::boolean))`,
            [
              principal.principalId,
              body.data.siloId,
              sourceId.data,
              update.scheduleEnabled ?? false,
            ],
          );
          return { status: 200, headers: {}, body: row };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      if (error instanceof Error && error.message === 'source-not-found')
        return reply.code(404).send(problem(404, error.message, request.id));
      const failure = sourceCreationFailure(error, 'source-update-failed');
      request.log.error(
        {
          errorName: error instanceof Error ? error.name : 'unknown',
          code: failure.code,
          requestId: request.id,
        },
        'source update failed',
      );
      return reply.code(failure.status).send(problem(failure.status, failure.code, request.id));
    }
  });

  app.post('/v1/sources/:id/review-missing', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!mutationAllowed(principal, request))
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    const sourceId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = missingReviewSchema.safeParse(request.body);
    if (!sourceId.success || !body.success)
      return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'upload', {
      requestedSiloIds: [body.data.siloId],
    });
    if (!scope.includes(body.data.siloId))
      return reply.code(404).send(problem(404, 'not_found', request.id));
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `source-missing-review:${String(sourceId.data)}:${String(body.data.documentId)}`,
          key: requireIdempotencyKey(request),
          request: stableDigest(body.data),
        },
        async (database) => {
          await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
            scope.postgresArray(),
          ]);
          const updated = await database.query(
            `UPDATE noderag.document SET source_note = $4
             WHERE id = $1 AND source_id = $2 AND silo_id = $3 AND source_state = 'missing'`,
            [body.data.documentId, sourceId.data, body.data.siloId, body.data.operatorNote],
          );
          if (updated.rowCount !== 1) throw new Error('missing-document-not-found');
          await database.query(
            `INSERT INTO noderag.audit_log (principal_id, silo_id, action, result, detail)
             VALUES ($1, $2, 'source.missing.review', 'ok',
                     jsonb_build_object('sourceId', $3::bigint,
                                        'documentId', $4::bigint))`,
            [principal.principalId, body.data.siloId, sourceId.data, body.data.documentId],
          );
          return { status: 200, headers: {}, body: { reviewed: true } };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      const code = error instanceof Error ? error.message : 'missing-review-failed';
      return reply
        .code(code === 'missing-document-not-found' ? 404 : 400)
        .send(problem(code === 'missing-document-not-found' ? 404 : 400, code, request.id));
    }
  });

  app.delete('/v1/sources/:id', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!mutationAllowed(principal, request))
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    const sourceId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = crawlBodySchema.safeParse(request.body);
    if (!sourceId.success || !body.success)
      return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'delete', {
      requestedSiloIds: [body.data.siloId],
    });
    if (!scope.includes(body.data.siloId))
      return reply.code(404).send(problem(404, 'not_found', request.id));
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `source-detach:${String(sourceId.data)}`,
          key: requireIdempotencyKey(request),
          request: stableDigest({ sourceId: sourceId.data, siloId: body.data.siloId }),
        },
        async (database) => {
          await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
            scope.postgresArray(),
          ]);
          const detached = await detachSource(
            database,
            sourceId.data,
            body.data.siloId,
            principal.principalId,
          );
          if (!detached) throw new Error('source-not-found');
          return { status: 200, headers: {}, body: { detached: true } };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      const code = error instanceof Error ? error.message : 'source-detach-failed';
      return reply
        .code(code === 'source-not-found' ? 404 : 400)
        .send(problem(code === 'source-not-found' ? 404 : 400, code, request.id));
    }
  });

  app.get('/v1/jobs', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'upload');
    if (scope.siloIds.length === 0) return reply.send({ items: [] });
    const jobs = await options.pool.query(
      `SELECT job.id, job.kind, job.source_id AS "sourceId",
              job.document_id AS "documentId", job.silo_id AS "siloId", job.state,
              job.priority, job.logical_attempt AS "logicalAttempt",
              job.max_attempts AS "maximumAttempts", job.lease_epoch AS "leaseEpoch",
              job.heartbeat_at AS "heartbeatAt", job.progress, job.checkpoint,
              job.retry_at AS "retryAt", job.cancel_requested_at AS "cancelRequestedAt",
              job.result, job.error_class AS "errorClass", job.structured_error AS error,
              job.created_at AS "createdAt", job.updated_at AS "updatedAt",
              job.finished_at AS "finishedAt", document.name AS "documentName",
              document.relative_path AS "documentPath", source.uri AS "sourceUri"
       FROM noderag.job job
       LEFT JOIN noderag.document document
         ON document.id = job.document_id AND document.silo_id = job.silo_id
       LEFT JOIN noderag.source source
         ON source.id = job.source_id AND source.silo_id = job.silo_id
       WHERE job.silo_id = ANY ($1::smallint[])
       ORDER BY CASE
                  WHEN job.state IN ('pending', 'leased', 'retry_wait', 'paused') THEN 0
                  WHEN job.state = 'failed' THEN 1
                  ELSE 2
                END,
                job.updated_at DESC, job.id DESC LIMIT 200`,
      [scope.siloIds],
    );
    return reply.send({ items: jobs.rows });
  });

  app.get('/v1/jobs/:id', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    const jobId = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!jobId.success) return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'upload');
    const found = await options.pool.query(
      `SELECT job.id, job.kind, job.source_id AS "sourceId",
              job.document_id AS "documentId", job.silo_id AS "siloId", job.state,
              job.priority, job.frozen_config AS "frozenConfig",
              job.logical_attempt AS "logicalAttempt", job.max_attempts AS "maximumAttempts",
              job.lease_epoch AS "leaseEpoch", job.heartbeat_at AS "heartbeatAt", job.progress,
              job.checkpoint, job.retry_at AS "retryAt",
              job.cancel_requested_at AS "cancelRequestedAt", job.result,
              job.error_class AS "errorClass", job.structured_error AS error,
              job.created_at AS "createdAt", job.updated_at AS "updatedAt",
              job.finished_at AS "finishedAt", document.name AS "documentName",
              document.relative_path AS "documentPath", source.uri AS "sourceUri"
       FROM noderag.job job
       LEFT JOIN noderag.document document
         ON document.id = job.document_id AND document.silo_id = job.silo_id
       LEFT JOIN noderag.source source
         ON source.id = job.source_id AND source.silo_id = job.silo_id
       WHERE job.id = $1 AND job.silo_id = ANY ($2::smallint[])`,
      [jobId.data, scope.siloIds],
    );
    return found.rows[0] === undefined
      ? reply.code(404).send(problem(404, 'not_found', request.id))
      : reply.send(found.rows[0]);
  });

  app.get('/v1/jobs/stream', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    const query = eventQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'upload');
    let cursor;
    try {
      cursor = eventCursor(request.headers['last-event-id']?.toString());
    } catch {
      return reply.code(400).send(problem(400, 'invalid_last_event_id', request.id));
    }
    const first = await readJobEvents(options.pool, scope.siloIds, cursor);
    if (query.data.once) {
      return reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache, no-transform')
        .send(eventBody(first.rows));
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    let rows = first.rows;
    let heartbeat = 0;
    while (!request.raw.destroyed && !reply.raw.destroyed) {
      if (rows.length > 0) {
        reply.raw.write(eventBody(rows));
        const last = rows.at(-1);
        if (last !== undefined) {
          cursor = {
            jobId: databaseInteger(last.job_id, 'event job id'),
            sequence: last.sequence,
          };
        }
      } else if (heartbeat % 15 === 0) reply.raw.write(': keep-alive\n\n');
      await delay(1000);
      heartbeat += 1;
      rows = (await readJobEvents(options.pool, scope.siloIds, cursor)).rows;
    }
  });

  const jobMutation = (
    path:
      '/v1/jobs/:id/cancel' | '/v1/jobs/:id/pause' | '/v1/jobs/:id/resume' | '/v1/jobs/:id/retry',
    action: 'upload' | 'reindex',
  ): void => {
    app.post(path, async (request, reply) => {
      const principal = await requirePrincipal(request, options.authenticate);
      if (principal === null)
        return reply.code(401).send(problem(401, 'authentication_required', request.id));
      if (!mutationAllowed(principal, request))
        return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
      const jobId = idSchema.safeParse((request.params as { id?: unknown }).id);
      const body = jobActionBodySchema.safeParse(request.body);
      if (!jobId.success || !body.success)
        return reply.code(400).send(problem(400, 'invalid_request', request.id));
      const scope = await SiloScope.resolve(options.pool, principal.principalId, action, {
        requestedSiloIds: [body.data.siloId],
      });
      if (!scope.includes(body.data.siloId))
        return reply.code(404).send(problem(404, 'not_found', request.id));
      try {
        const result = await executeIdempotent(
          options.pool,
          {
            principalId: principal.principalId,
            operation: `${path}:${String(jobId.data)}`,
            key: requireIdempotencyKey(request),
            request: stableDigest({ jobId: jobId.data, siloId: body.data.siloId }),
          },
          async () => {
            const outcome = path.endsWith('/cancel')
              ? await requestJobCancellation(options.pool, jobId.data, body.data.siloId)
              : path.endsWith('/pause')
                ? await pauseJob(options.pool, jobId.data, body.data.siloId)
                : path.endsWith('/resume')
                  ? await resumeJob(options.pool, jobId.data, body.data.siloId)
                  : await retryJob(options.pool, jobId.data, body.data.siloId);
            return { status: 202, headers: {}, body: { outcome } };
          },
        );
        return reply.code(result.response.status).send(result.response.body);
      } catch (error) {
        if (error instanceof IdempotencyConflictError)
          return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
        const code = error instanceof Error ? error.message : 'job-action-failed';
        return reply.code(400).send(problem(400, code, request.id));
      }
    });
  };
  jobMutation('/v1/jobs/:id/cancel', 'upload');
  jobMutation('/v1/jobs/:id/pause', 'upload');
  jobMutation('/v1/jobs/:id/resume', 'upload');
  jobMutation('/v1/jobs/:id/retry', 'reindex');

  app.post('/v1/documents/:id/reindex', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!mutationAllowed(principal, request))
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    const documentId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = documentReindexBodySchema.safeParse(request.body);
    if (!documentId.success || !body.success)
      return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'reindex', {
      requestedSiloIds: [body.data.siloId],
    });
    if (!scope.includes(body.data.siloId))
      return reply.code(404).send(problem(404, 'not_found', request.id));
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `document-reindex:${String(documentId.data)}`,
          key: requireIdempotencyKey(request),
          request: stableDigest({
            documentId: documentId.data,
            siloId: body.data.siloId,
            enhanced: body.data.enhanced,
          }),
        },
        async (database) => {
          await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
            scope.postgresArray(),
          ]);
          const document = await database.query<{ extension: string; state: string }>(
            `SELECT extension, state FROM noderag.document
             WHERE id = $1 AND silo_id = $2 AND state <> 'purging' FOR UPDATE`,
            [documentId.data, body.data.siloId],
          );
          const row = document.rows[0];
          if (row === undefined) throw new Error('document-not-found');
          const queued = await database.query<{ id: unknown }>(
            `INSERT INTO noderag.job (kind, document_id, silo_id, priority, payload)
             VALUES ('extract', $1, $2, 3,
                     jsonb_build_object(
                       'format', $3::text,
                       'reason', CASE WHEN $4::boolean AND $3::text='pdf'
                                      THEN 'enhanced-pdf-reindex' ELSE 'manual-reindex' END,
                       'targetExtractionVersion', CASE WHEN $4::boolean AND $3::text='pdf'
                                                       THEN 'pdf-layout.v3-hybrid' ELSE NULL END,
                       'replaceExisting', $4::boolean AND $3::text='pdf',
                       'previousDocumentState', $5::text))
             ON CONFLICT (document_id, kind)
               WHERE document_id IS NOT NULL
                 AND state IN ('pending', 'leased', 'retry_wait', 'paused')
             DO UPDATE SET state = 'pending', run_after = now(), retry_at = NULL,
                           cancel_requested_at = NULL, attempts = 0,
                           logical_attempt = 0, payload = EXCLUDED.payload, updated_at = now()
             RETURNING id`,
            [documentId.data, body.data.siloId, row.extension, body.data.enhanced, row.state],
          );
          const jobId = databaseInteger(queued.rows[0]?.id, 'reindex job id');
          await database.query(
            `UPDATE noderag.document
             SET state = CASE WHEN $3::boolean AND state IN
                                    ('ready', 'source_missing', 'awaiting_vision')
                              THEN state ELSE 'pending' END,
                 error_code = NULL, error_detail = NULL,
                 metadata = metadata || jsonb_build_object(
                   'enhancedReindex', jsonb_build_object(
                     'state', 'queued', 'targetExtractionVersion',
                     CASE WHEN $3::boolean THEN 'pdf-layout.v3-hybrid' ELSE NULL END,
                     'queuedAt', now()))
             WHERE id = $1 AND silo_id = $2`,
            [documentId.data, body.data.siloId, body.data.enhanced && row.extension === 'pdf'],
          );
          await database.query(
            `INSERT INTO noderag.job_event (job_id, sequence, event_type, detail)
             SELECT $1, COALESCE(max(sequence) + 1, 0), 'queued',
                    jsonb_build_object('reason', 'manual-reindex')
             FROM noderag.job_event WHERE job_id = $1`,
            [jobId],
          );
          return {
            status: 202,
            headers: {},
            body: {
              accepted: true,
              jobId,
              enhanced: body.data.enhanced && row.extension === 'pdf',
              targetExtractionVersion:
                body.data.enhanced && row.extension === 'pdf' ? 'pdf-layout.v3-hybrid' : null,
            },
          };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      const code = error instanceof Error ? error.message : 'reindex-failed';
      return reply
        .code(code === 'document-not-found' ? 404 : 400)
        .send(problem(code === 'document-not-found' ? 404 : 400, code, request.id));
    }
  });

  app.delete('/v1/documents/:id', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!mutationAllowed(principal, request))
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    const documentId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = documentPurgeBodySchema.safeParse(request.body);
    if (!documentId.success || !body.success || documentId.data !== body.data.confirmDocumentId) {
      return reply.code(400).send(problem(400, 'document_confirmation_mismatch', request.id));
    }
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'delete', {
      requestedSiloIds: [body.data.siloId],
    });
    if (!scope.includes(body.data.siloId))
      return reply.code(404).send(problem(404, 'not_found', request.id));
    try {
      const accepted = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `document-purge:${String(documentId.data)}`,
          key: requireIdempotencyKey(request),
          request: stableDigest({ documentId: documentId.data, siloId: body.data.siloId }),
        },
        async (database) => {
          await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
            scope.postgresArray(),
          ]);
          const operationId = await startDocumentPurge(
            database,
            documentId.data,
            body.data.siloId,
            principal.principalId,
          );
          if (operationId === null) throw new Error('document-not-found');
          return { status: 202, headers: {}, body: { operationId, accepted: true } };
        },
      );
      const operationId = (accepted.response.body as { operationId: number }).operationId;
      await continueDocumentPurge(options.pool, options.files, operationId);
      return reply.code(accepted.response.status).send(accepted.response.body);
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      const code = error instanceof Error ? error.message : 'document-purge-failed';
      return reply
        .code(code === 'document-not-found' ? 404 : code.endsWith('draining') ? 409 : 400)
        .send(
          problem(
            code === 'document-not-found' ? 404 : code.endsWith('draining') ? 409 : 400,
            code,
            request.id,
          ),
        );
    }
  });

  app.get('/v1/admin/logs', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!principal.serverAdmin)
      return reply.code(403).send(problem(403, 'server_admin_required', request.id));
    const query = ingestionLogQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const [rows, count] = await Promise.all([
      options.pool.query(
        `SELECT event.id, event.created_at AS "createdAt", event.event_type AS "eventType",
              event.detail, job.id AS "jobId", job.kind, job.state,
              job.logical_attempt AS "logicalAttempt", job.max_attempts AS "maximumAttempts",
              job.progress, job.error_class AS "errorClass", job.structured_error AS error,
              document.id AS "documentId", document.name AS "documentName",
              document.relative_path AS "documentPath", silo.id AS "siloId",
              silo.display_name AS "siloName"
       FROM noderag.job_event event
       JOIN noderag.job job ON job.id = event.job_id
       LEFT JOIN noderag.document document ON document.id = job.document_id
       LEFT JOIN noderag.silo silo ON silo.id = job.silo_id
       WHERE event.created_at >= now() - interval '24 hours'
         AND job.kind IN ('crawl', 'extract', 'vision', 'embed')
       ORDER BY event.created_at DESC, event.id DESC
       LIMIT $1`,
        [query.data.limit],
      ),
      options.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM noderag.job_event event
         JOIN noderag.job job ON job.id = event.job_id
         WHERE event.created_at >= now() - interval '24 hours'
           AND job.kind IN ('crawl', 'extract', 'vision', 'embed')`,
      ),
    ]);
    const generatedAt = new Date();
    const itemCount = Number(count.rows[0]?.count ?? rows.rows.length);
    return reply.send({
      generatedAt: generatedAt.toISOString(),
      windowStartedAt: new Date(generatedAt.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      windowHours: 24,
      itemCount,
      returnedCount: rows.rows.length,
      truncated: itemCount > rows.rows.length,
      items: rows.rows,
    });
  });

  app.get('/v1/admin/health', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!principal.serverAdmin)
      return reply.code(403).send(problem(403, 'server_admin_required', request.id));
    const findings = await options.pool.query(
      `SELECT id, silo_id AS "siloId", document_id AS "documentId",
              chunk_id AS "chunkId", category, identity_key AS "identityKey",
              detail, first_detected_at AS "firstDetectedAt",
              last_detected_at AS "lastDetectedAt"
       FROM noderag.integrity_finding WHERE resolved_at IS NULL
       ORDER BY last_detected_at DESC, id LIMIT 1000`,
    );
    return reply.send({
      status: findings.rows.length === 0 ? 'ok' : 'degraded',
      openFindingCount: findings.rows.length,
      findings: findings.rows,
      recentErrors: await recentStructuredErrors(options.logRoot),
    });
  });

  app.delete('/v1/admin/silos/:id', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!principal.serverAdmin)
      return reply.code(403).send(problem(403, 'server_admin_required', request.id));
    if (!mutationAllowed(principal, request))
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    const siloId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = siloPurgeBodySchema.safeParse(request.body);
    if (!siloId.success || !body.success)
      return reply.code(400).send(problem(400, 'invalid_request', request.id));
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `silo-purge:${String(siloId.data)}`,
          key: requireIdempotencyKey(request),
          request: stableDigest({ siloId: siloId.data, confirmSlug: body.data.confirmSlug }),
        },
        async () => ({
          status: 202,
          headers: {},
          body: await purgeSiloCompletely(options.pool, options.files, {
            siloId: siloId.data,
            expectedSlug: body.data.confirmSlug,
            principalId: principal.principalId,
          }),
        }),
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      const code = error instanceof Error ? error.message : 'silo-purge-failed';
      const status =
        code === 'silo-confirmation-mismatch' ? 400 : code.endsWith('draining') ? 409 : 404;
      return reply.code(status).send(problem(status, code, request.id));
    }
  });
};
