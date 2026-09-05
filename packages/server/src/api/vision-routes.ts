import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import type { AuthenticatedPrincipal, RequestAuthenticator } from './authentication.js';
import { SiloScope } from '../identity/scope.js';
import { activateOllamaVision, OllamaVisionProvider } from '../vision/ollama.js';
import type { SecretVault } from '../identity/secrets.js';

const idSchema = z.coerce.number().int().positive();
const activationSchema = z
  .object({
    baseUrl: z.string().url(),
    model: z.string().min(1).max(200),
    bearerToken: z.string().min(1).max(4000).optional(),
    maximumParallel: z.number().int().min(1).max(16).default(2),
    timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
    maximumAttempts: z.number().int().min(1).max(10).default(3),
    maximumImageDimension: z.number().int().min(256).max(8192).default(2048),
  })
  .strict();
const retrySchema = z
  .object({
    documentId: z.number().int().positive().optional(),
    siloId: z.number().int().positive().max(32_767).optional(),
  })
  .strict();
const imageRevisionSchema = z.object({ siloId: z.number().int().positive().max(32_767) }).strict();

const problem = (status: number, code: string, requestId: string) => ({
  type: `https://noderag.local/problems/${code}`,
  title: code.replaceAll('_', ' '),
  status,
  code,
  requestId,
});

const mutationAllowed = (principal: AuthenticatedPrincipal, request: FastifyRequest): boolean =>
  principal.csrfAllowed(request.headers['x-csrf-token']?.toString(), request.headers.origin);

const idempotencyKey = (request: FastifyRequest): string => {
  const key = request.headers['idempotency-key']?.toString();
  if (key === undefined) throw new Error('idempotency_key_required');
  return key;
};

const activationImagePath = (): string =>
  typeof __filename === 'string' && __filename.endsWith('.cjs')
    ? join(__dirname, 'vendor', 'vision-table.png')
    : resolve('fixtures/formats/images/table.png');

export interface VisionRoutesOptions {
  readonly pool: Pool;
  readonly authenticate: RequestAuthenticator;
  readonly runtimeBearerToken?: string;
  readonly secretVault?: SecretVault;
}

export const registerVisionRoutes = (app: FastifyInstance, options: VisionRoutesOptions): void => {
  app.get('/v1/admin/vision/status', async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!principal.serverAdmin)
      return reply.code(403).send(problem(403, 'server_admin_required', request.id));
    const [settings, counts, dispatches, projection] = await Promise.all([
      options.pool.query(
        `SELECT vision_enabled AS "enabled", ollama_base_url AS "baseUrl",
                ollama_model AS model, ollama_model_revision AS "modelRevision",
                ollama_parallel AS "maximumParallel", ollama_timeout_ms AS "timeoutMs",
                ollama_max_attempts AS "maximumAttempts", max_image_px AS "maximumImageDimension",
                (ollama_secret_id IS NOT NULL) AS "credentialConfigured",
                vision_activated_at AS "activatedAt",
                vision_sample_elapsed_ms AS "sampleElapsedMs"
         FROM noderag.settings WHERE id = 1`,
      ),
      options.pool.query(
        `SELECT count(*) FILTER (WHERE state = 'pending_vision')::integer AS pending,
                count(*) FILTER (WHERE state = 'failed')::integer AS failed,
                count(*) FILTER (WHERE state = 'analysed')::integer AS analysed,
                count(*) FILTER (WHERE state = 'skipped')::integer AS skipped
         FROM noderag.document_image`,
      ),
      options.pool.query(
        `SELECT count(*) FILTER (WHERE state = 'dispatched')::integer AS open,
                count(*) FILTER (WHERE state = 'failed')::integer AS failed
         FROM noderag.vision_dispatch`,
      ),
      options.pool.query<{
        projected_calls: number;
        scan_pages: number;
        average_ms: number | null;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM noderag.document_image
            WHERE state = 'pending_vision') AS projected_calls,
           (SELECT count(*)::integer FROM noderag.document_page
            WHERE extraction = 'vision') AS scan_pages,
           (SELECT round(avg(elapsed_ms))::integer FROM noderag.vision_cache
            WHERE elapsed_ms IS NOT NULL) AS average_ms`,
      ),
    ]);
    const estimate = projection.rows[0];
    const projectedCalls = estimate?.projected_calls ?? 0;
    const averageMs = estimate?.average_ms ?? null;
    return reply.send({
      settings: settings.rows[0] ?? null,
      counts: counts.rows[0] ?? { pending: 0, failed: 0, analysed: 0, skipped: 0 },
      dispatches: dispatches.rows[0] ?? { open: 0, failed: 0 },
      estimate: {
        projectedCalls,
        scanPages: estimate?.scan_pages ?? 0,
        averageCallMs: averageMs,
        projectedElapsedMs: averageMs === null ? null : averageMs * projectedCalls,
      },
      warnings: (estimate?.scan_pages ?? 0) >= 400 ? ['large-scan-provider-cost-and-time'] : [],
    });
  });

  app.post('/v1/admin/vision/test', async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!principal.serverAdmin)
      return reply.code(403).send(problem(403, 'server_admin_required', request.id));
    if (!mutationAllowed(principal, request))
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    const body = activationSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const token = body.data.bearerToken ?? options.runtimeBearerToken;
    const digestBody = {
      ...body.data,
      bearerToken:
        token === undefined
          ? null
          : createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16),
    };
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: 'vision-provider-activation',
          key: idempotencyKey(request),
          request: JSON.stringify(digestBody),
        },
        async (database) => {
          const provider = new OllamaVisionProvider({
            baseUrl: body.data.baseUrl,
            model: body.data.model,
            ...(token === undefined ? {} : { bearerToken: token }),
          });
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), body.data.timeoutMs);
          const started = performance.now();
          try {
            const activation = await activateOllamaVision(
              provider,
              await readFile(activationImagePath()),
              controller.signal,
            );
            const elapsedMs = Math.max(0, Math.round(performance.now() - started));
            let secretId: number | null = null;
            if (body.data.bearerToken !== undefined && options.secretVault !== undefined) {
              await options.secretVault.store(
                database,
                'ollama',
                'bearer-token',
                body.data.bearerToken,
                principal.principalId,
              );
              const secret = await database.query<{ id: number }>(
                `SELECT id FROM noderag.encrypted_secret
                 WHERE provider = 'ollama' AND name = 'bearer-token'`,
              );
              secretId = secret.rows[0]?.id ?? null;
            }
            await database.query(
              `UPDATE noderag.settings
               SET vision_enabled = true, ollama_base_url = $1, ollama_model = $2,
                   ollama_model_revision = $3, ollama_parallel = $4,
                   ollama_timeout_ms = $5, ollama_max_attempts = $6, max_image_px = $7,
                   vision_activated_at = now(), vision_sample_elapsed_ms = $8,
                   ollama_secret_id = COALESCE($9::bigint, ollama_secret_id),
                   updated_at = now(), updated_by = $10
               WHERE id = 1`,
              [
                body.data.baseUrl,
                body.data.model,
                activation.model.digest ?? activation.model.name,
                body.data.maximumParallel,
                body.data.timeoutMs,
                body.data.maximumAttempts,
                body.data.maximumImageDimension,
                elapsedMs,
                secretId,
                principal.principalId,
              ],
            );
            return {
              status: 200,
              headers: {},
              body: {
                activated: true,
                model: activation.model.name,
                modelRevision: activation.model.digest,
                sample: activation.sample,
                elapsedMs,
                securityWarning: provider.securityWarning(),
                bearerTokenPersisted: secretId !== null,
              },
            };
          } finally {
            clearTimeout(timeout);
          }
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      const code = error instanceof Error ? error.message : 'vision-capability-test-failed';
      return reply.code(422).send(problem(422, code, request.id));
    }
  });

  app.post('/v1/admin/vision/retry', async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!principal.serverAdmin)
      return reply.code(403).send(problem(403, 'server_admin_required', request.id));
    if (!mutationAllowed(principal, request))
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    const body = retrySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(problem(400, 'invalid_request', request.id));
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: 'vision-manual-retry',
          key: idempotencyKey(request),
          request: JSON.stringify(body.data),
        },
        async (database) => {
          const inserted = await database.query(
            `INSERT INTO noderag.job
               (kind, document_id, silo_id, build_id, priority, max_attempts, payload)
             SELECT 'vision', document.id, document.silo_id, build.id, 3, 5,
                    jsonb_build_object('reason', 'manual-retry')
             FROM noderag.document document
             JOIN noderag.silo_build_state active
               ON active.silo_id=document.silo_id AND active.state='active'
             JOIN noderag.build build ON build.id=active.build_id
             WHERE document.state = 'awaiting_vision'
               AND ($1::bigint IS NULL OR document.id = $1)
               AND ($2::smallint IS NULL OR document.silo_id = $2)
             ON CONFLICT (document_id, kind)
               WHERE document_id IS NOT NULL
                 AND state IN ('pending', 'leased', 'retry_wait', 'paused')
             DO UPDATE SET state = 'pending', run_after = now(), retry_at = NULL,
                           attempts = 0, logical_attempt = 0, updated_at = now()
             RETURNING id`,
            [body.data.documentId ?? null, body.data.siloId ?? null],
          );
          return {
            status: 202,
            headers: {},
            body: { accepted: true, scheduled: inserted.rowCount ?? 0 },
          };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      const code = error instanceof Error ? error.message : 'vision-retry-failed';
      return reply.code(400).send(problem(400, code, request.id));
    }
  });

  app.post('/v1/images/:id/revision', async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (!mutationAllowed(principal, request))
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    const imageId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const body = imageRevisionSchema.safeParse(request.body);
    if (!imageId.success || !body.success)
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
          operation: `image-vision-revision:${String(imageId.data)}`,
          key: idempotencyKey(request),
          request: JSON.stringify({ imageId: imageId.data, siloId: body.data.siloId }),
        },
        async (database) => {
          await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
            scope.postgresArray(),
          ]);
          const image = await database.query<{ document_id: unknown }>(
            `UPDATE noderag.document_image
             SET state='pending_vision',last_error_code=NULL
             WHERE id=$1 AND silo_id=$2 RETURNING document_id`,
            [imageId.data, body.data.siloId],
          );
          const documentId = image.rows[0]?.document_id;
          if (documentId === undefined) throw new Error('image-not-found');
          const queued = await database.query<{ id: unknown }>(
            `INSERT INTO noderag.job
               (kind,document_id,silo_id,build_id,priority,payload)
             SELECT 'vision',$1,$2,active.build_id,3,
                    jsonb_build_object('reason','image-revision','imageId',$3::bigint)
             FROM noderag.silo_build_state active
             WHERE active.silo_id=$2 AND active.state='active'
             ON CONFLICT (document_id, kind)
               WHERE document_id IS NOT NULL
                 AND state IN ('pending','leased','retry_wait','paused')
             DO UPDATE SET state='pending',run_after=now(),retry_at=NULL,
                           cancel_requested_at=NULL,updated_at=now(),
                           payload=EXCLUDED.payload
             RETURNING id`,
            [documentId, body.data.siloId, imageId.data],
          );
          return {
            status: 202,
            headers: {},
            body: {
              accepted: true,
              imageId: imageId.data,
              jobId: queued.rows[0]?.id,
            },
          };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      const code = error instanceof Error ? error.message : 'image-revision-failed';
      return reply
        .code(code === 'image-not-found' ? 404 : 400)
        .send(problem(code === 'image-not-found' ? 404 : 400, code, request.id));
    }
  });

  app.get('/v1/documents/:id/vision-estimate', async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    const documentId = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!documentId.success)
      return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'read_markdown');
    const found = await options.pool.query<{
      silo_id: number;
      projected_calls: number;
      scan_pages: number;
      average_ms: number | null;
    }>(
      `SELECT document.silo_id,
              count(image.id) FILTER (WHERE image.state = 'pending_vision')::integer
                AS projected_calls,
              count(DISTINCT page.ordinal) FILTER (WHERE page.extraction = 'vision')::integer
                AS scan_pages,
              (SELECT round(avg(elapsed_ms))::integer FROM noderag.vision_cache
               WHERE elapsed_ms IS NOT NULL) AS average_ms
       FROM noderag.document document
       LEFT JOIN noderag.document_page page ON page.document_id = document.id
       LEFT JOIN noderag.document_image image
         ON image.document_id = document.id AND image.page_ordinal = page.ordinal
       WHERE document.id = $1
       GROUP BY document.id, document.silo_id`,
      [documentId.data],
    );
    const row = found.rows[0];
    if (row === undefined || !scope.includes(row.silo_id))
      return reply.code(404).send(problem(404, 'not_found', request.id));
    return reply.send({
      documentId: documentId.data,
      projectedCalls: row.projected_calls,
      scanPages: row.scan_pages,
      averageCallMs: row.average_ms,
      projectedElapsedMs: row.average_ms === null ? null : row.average_ms * row.projected_calls,
      warnings: row.scan_pages >= 400 ? ['large-scan-provider-cost-and-time'] : [],
    });
  });
};
