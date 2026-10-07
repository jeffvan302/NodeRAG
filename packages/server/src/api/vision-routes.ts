import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import type { AuthenticatedPrincipal, RequestAuthenticator } from './authentication.js';
import { SiloScope, withSiloScope } from '../identity/scope.js';
import { activateOllamaVision, OllamaVisionProvider } from '../vision/ollama.js';
import { visionActivationSample } from '../vision/activation-sample.js';
import type { SecretVault } from '../identity/secrets.js';
import {
  PDF_CONFIDENCE_POLICY_REVISION,
  PDF_CONFIDENCE_THRESHOLDS,
  PDF_EXTRACTION_VERSION,
  PDF_LAYOUT_POLICY_REVISION,
  PDF_PARSER_REVISION,
} from '../extract/pdf-layout.js';
import { calculateVisionDispatchEstimate } from '../vision/estimate.js';

const idSchema = z.coerce.number().int().positive();
const activationSchema = z
  .object({
    baseUrl: z.string().url(),
    model: z.string().min(1).max(200).default('minimax-m3:cloud'),
    bearerToken: z.string().min(1).max(4000).optional(),
    maximumParallel: z.number().int().min(1).max(16).default(2),
    maximumImagesPerCall: z.number().int().min(1).max(16).default(3),
    timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
    maximumAttempts: z.number().int().min(1).max(10).default(3),
    maximumImageDimension: z.number().int().min(256).max(8192).default(1650),
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
                ollama_parallel AS "maximumParallel",
                ollama_images_per_call AS "maximumImagesPerCall",
                ollama_timeout_ms AS "timeoutMs",
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
        pending_images: number;
        scan_pages: number;
        average_ms: number | null;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM noderag.document_image
            WHERE state = 'pending_vision') AS pending_images,
           (SELECT count(*)::integer FROM noderag.document_page
            WHERE extraction = 'vision') AS scan_pages,
           (SELECT round(avg(elapsed_ms))::integer FROM noderag.vision_cache
            WHERE elapsed_ms IS NOT NULL) AS average_ms`,
      ),
    ]);
    const estimate = projection.rows[0];
    const pendingImages = estimate?.pending_images ?? 0;
    const maximumImagesPerCall = Number(settings.rows[0]?.maximumImagesPerCall ?? 3);
    const projectedCalls = Math.ceil(pendingImages / maximumImagesPerCall);
    const averageMs = estimate?.average_ms ?? null;
    return reply.send({
      settings: settings.rows[0] ?? null,
      counts: counts.rows[0] ?? { pending: 0, failed: 0, analysed: 0, skipped: 0 },
      dispatches: dispatches.rows[0] ?? { open: 0, failed: 0 },
      estimate: {
        projectedCalls,
        pendingImages,
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
    try {
      const storedToken =
        body.data.bearerToken === undefined &&
        options.runtimeBearerToken === undefined &&
        options.secretVault !== undefined
          ? ((await options.secretVault.reveal(options.pool, 'ollama', 'bearer-token')) ??
            undefined)
          : undefined;
      const token = body.data.bearerToken ?? options.runtimeBearerToken ?? storedToken;
      const digestBody = {
        ...body.data,
        bearerToken:
          token === undefined
            ? null
            : createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16),
      };
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
              visionActivationSample(),
              controller.signal,
              body.data.maximumImagesPerCall,
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
                   ollama_images_per_call = $5,
                   ollama_timeout_ms = $6, ollama_max_attempts = $7, max_image_px = $8,
                   vision_activated_at = now(), vision_sample_elapsed_ms = $9,
                   ollama_secret_id = COALESCE($10::bigint, ollama_secret_id),
                   updated_at = now(), updated_by = $11
               WHERE id = 1`,
              [
                body.data.baseUrl,
                body.data.model,
                activation.model.digest ?? activation.model.name,
                body.data.maximumParallel,
                body.data.maximumImagesPerCall,
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
                bearerTokenPersisted: secretId !== null || storedToken !== undefined,
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
    const found = await withSiloScope(options.pool, scope, (database) =>
      database.query<{
        silo_id: number;
        projected_calls: number;
        scan_pages: number;
        average_ms: number | null;
        images_per_call: number;
      }>(
        `SELECT document.silo_id,
                count(image.id) FILTER (WHERE image.state = 'pending_vision')::integer
                  AS projected_calls,
                count(DISTINCT page.ordinal) FILTER (WHERE page.extraction = 'vision')::integer
                  AS scan_pages,
                (SELECT round(avg(elapsed_ms))::integer FROM noderag.vision_cache
                 WHERE elapsed_ms IS NOT NULL) AS average_ms,
                (SELECT ollama_images_per_call FROM noderag.settings WHERE id = 1)
                  AS images_per_call
         FROM noderag.document document
         LEFT JOIN noderag.document_page page ON page.document_id = document.id
         LEFT JOIN noderag.document_image image
           ON image.document_id = document.id AND image.page_ordinal = page.ordinal
         WHERE document.id = $1
         GROUP BY document.id, document.silo_id`,
        [documentId.data],
      ),
    );
    const row = found.rows[0];
    if (row === undefined || !scope.includes(row.silo_id))
      return reply.code(404).send(problem(404, 'not_found', request.id));
    return reply.send({
      documentId: documentId.data,
      pendingImages: row.projected_calls,
      projectedCalls: Math.ceil(row.projected_calls / row.images_per_call),
      scanPages: row.scan_pages,
      averageCallMs: row.average_ms,
      projectedElapsedMs:
        row.average_ms === null
          ? null
          : row.average_ms * Math.ceil(row.projected_calls / row.images_per_call),
      warnings: row.scan_pages >= 400 ? ['large-scan-provider-cost-and-time'] : [],
    });
  });

  app.get('/v1/documents/:id/extraction-diagnostics', async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    const documentId = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!documentId.success)
      return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'read_markdown');
    const diagnostic = await withSiloScope(options.pool, scope, async (database) => {
      const found = await database.query<{
        silo_id: number;
        extension: string;
        metadata: Record<string, unknown>;
      }>('SELECT silo_id,extension,metadata FROM noderag.document WHERE id=$1', [documentId.data]);
      const document = found.rows[0];
      if (document === undefined || !scope.includes(document.silo_id)) return null;
      const pages = await database.query<{
        ordinal: number;
        extraction: string;
        extraction_confidence: number;
      }>(
        `SELECT ordinal,extraction,extraction_confidence
         FROM noderag.document_page WHERE document_id=$1 ORDER BY ordinal`,
        [documentId.data],
      );
      const blocks = await database.query<{
        page_ordinal: number;
        kind: string;
        combined_confidence: number;
        warning_codes: string[];
        confidence_components: {
          routing?: { disposition?: string; reasons?: string[] };
        };
      }>(
        `SELECT page_ordinal,kind,combined_confidence,warning_codes,confidence_components
         FROM noderag.document_block
         WHERE document_id=$1 ORDER BY page_ordinal,reading_order,ordinal`,
        [documentId.data],
      );
      return { document, pages, blocks };
    });
    if (diagnostic === null) return reply.code(404).send(problem(404, 'not_found', request.id));
    const { document, pages, blocks } = diagnostic;
    const extractionMetadata =
      document.metadata['extractionMetadata'] !== null &&
      typeof document.metadata['extractionMetadata'] === 'object'
        ? (document.metadata['extractionMetadata'] as Record<string, unknown>)
        : {};
    const dispositions = blocks.rows.map(
      ({ confidence_components }) => confidence_components.routing?.disposition ?? 'native-safe',
    );
    const warnings = [
      ...new Set(blocks.rows.flatMap(({ warning_codes }) => warning_codes).filter(Boolean)),
    ].sort();
    const extractionCounts = {
      native: pages.rows.filter(({ extraction }) => extraction === 'text').length,
      vision: pages.rows.filter(({ extraction }) => extraction === 'vision').length,
      mixed: pages.rows.filter(({ extraction }) => extraction === 'mixed').length,
    };
    return reply.send({
      documentId: documentId.data,
      format: document.extension,
      revisions: {
        pdfExtractionVersion:
          extractionMetadata['pdfExtractionVersion'] ??
          (document.extension === 'pdf' ? 'legacy-or-unrecorded' : null),
        parserRevision: extractionMetadata['parserRevision'] ?? null,
        layoutPolicyRevision: extractionMetadata['layoutPolicyRevision'] ?? null,
        confidencePolicyRevision: extractionMetadata['confidencePolicyRevision'] ?? null,
        visionPromptRevision: extractionMetadata['visionPromptRevision'] ?? null,
        visionSchemaRevision: extractionMetadata['visionSchemaRevision'] ?? null,
        cropPolicyRevision: extractionMetadata['cropPolicyRevision'] ?? null,
      },
      pageCounts: extractionCounts,
      blockCounts: {
        total: blocks.rows.length,
        nativeSafe: dispositions.filter((value) => value === 'native-safe').length,
        regionalVision: dispositions.filter((value) => value === 'regional-vision').length,
        fullPageVision: dispositions.filter((value) => value === 'full-page-vision').length,
        lowConfidence: blocks.rows.filter(
          ({ combined_confidence }) => combined_confidence < PDF_CONFIDENCE_THRESHOLDS.nativeSafe,
        ).length,
      },
      thresholds: PDF_CONFIDENCE_THRESHOLDS,
      warnings,
      vision: {
        providerCalls: Number(extractionMetadata['visionProviderCalls'] ?? 0),
        cacheHits: Number(extractionMetadata['visionCacheHits'] ?? 0),
        cacheHitRate: (() => {
          const calls = Number(extractionMetadata['visionProviderCalls'] ?? 0);
          const hits = Number(extractionMetadata['visionCacheHits'] ?? 0);
          return calls + hits === 0 ? 0 : hits / (calls + hits);
        })(),
        regionalCandidates: Number(extractionMetadata['regionalVisionCandidates'] ?? 0),
      },
      extractionElapsedMs: Number(extractionMetadata['extractionElapsedMs'] ?? 0),
      fallbacks: warnings.filter((warning) => /fallback|unresolved|not-accepted/iu.test(warning)),
      markdownReader: {
        endpoint: `/v1/documents/${String(documentId.data)}/markdown`,
        available: true,
      },
      enhancedReindexAvailable:
        document.extension === 'pdf' &&
        extractionMetadata['pdfExtractionVersion'] !== PDF_EXTRACTION_VERSION,
      pages: pages.rows.map((page) => {
        const pageBlocks = blocks.rows.filter(({ page_ordinal }) => page_ordinal === page.ordinal);
        return {
          ordinal: page.ordinal,
          pageNumber: page.ordinal + 1,
          extraction: page.extraction,
          extractionConfidence: page.extraction_confidence,
          lowConfidenceBlocks: pageBlocks.filter(
            ({ combined_confidence }) => combined_confidence < PDF_CONFIDENCE_THRESHOLDS.nativeSafe,
          ).length,
          routingReasons: [
            ...new Set(
              pageBlocks.flatMap(
                ({ confidence_components }) => confidence_components.routing?.reasons ?? [],
              ),
            ),
          ],
        };
      }),
    });
  });

  app.get('/v1/documents/:id/enhanced-reindex-estimate', async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    const documentId = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!documentId.success)
      return reply.code(400).send(problem(400, 'invalid_request', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'read_markdown');
    const estimate = await withSiloScope(options.pool, scope, (database) =>
      database.query<{
        silo_id: number;
        extension: string;
        page_count: number;
        regional_candidates: number;
        full_page_candidates: number;
        images_per_call: number;
        parallel_calls: number;
        average_ms: number | null;
        metadata: Record<string, unknown>;
      }>(
        `SELECT document.silo_id,document.extension,document.page_count,document.metadata,
                (SELECT count(*)::integer FROM noderag.document_block block
                 WHERE block.document_id=document.id
                   AND block.confidence_components #>> '{routing,disposition}'='regional-vision')
                  AS regional_candidates,
                (SELECT count(*)::integer FROM noderag.document_page page
                 WHERE page.document_id=document.id AND page.extraction='vision')
                  AS full_page_candidates,
                settings.ollama_images_per_call AS images_per_call,
                settings.ollama_parallel AS parallel_calls,
                (SELECT round(avg(elapsed_ms))::integer FROM noderag.vision_cache
                 WHERE elapsed_ms IS NOT NULL) AS average_ms
         FROM noderag.document document CROSS JOIN noderag.settings settings
         WHERE document.id=$1 AND settings.id=1`,
        [documentId.data],
      ),
    );
    const row = estimate.rows[0];
    if (row === undefined || !scope.includes(row.silo_id))
      return reply.code(404).send(problem(404, 'not_found', request.id));
    if (row.extension !== 'pdf')
      return reply.code(400).send(problem(400, 'enhanced-reindex-pdf-only', request.id));
    const dispatch = calculateVisionDispatchEstimate(
      row.regional_candidates + row.full_page_candidates,
      row.images_per_call,
      row.parallel_calls,
      row.average_ms,
    );
    const extractionMetadata =
      row.metadata['extractionMetadata'] !== null &&
      typeof row.metadata['extractionMetadata'] === 'object'
        ? (row.metadata['extractionMetadata'] as Record<string, unknown>)
        : {};
    return reply.send({
      documentId: documentId.data,
      pageCount: row.page_count,
      regionalVisionCandidates: row.regional_candidates,
      fullPageVisionCandidates: row.full_page_candidates,
      estimatedImages: dispatch.estimatedImages,
      expectedCacheHits: 0,
      imagesPerCall: dispatch.imagesPerCall,
      parallelCalls: dispatch.parallelCalls,
      estimatedBatches: dispatch.estimatedBatches,
      estimatedParallelWaves: dispatch.estimatedParallelWaves,
      averageCallMs: row.average_ms,
      provisionalElapsedMs: dispatch.provisionalElapsedMs,
      currentExtractionVersion: extractionMetadata['pdfExtractionVersion'] ?? null,
      targetRevisions: {
        pdfExtractionVersion: PDF_EXTRACTION_VERSION,
        parserRevision: PDF_PARSER_REVISION,
        layoutPolicyRevision: PDF_LAYOUT_POLICY_REVISION,
        confidencePolicyRevision: PDF_CONFIDENCE_POLICY_REVISION,
      },
      estimateIsProvisional: true,
      warnings: [
        ...(row.page_count >= 400 ? ['large-pdf-provider-cost-and-time'] : []),
        ...(row.average_ms === null ? ['provider-duration-baseline-unavailable'] : []),
      ],
    });
  });
};
