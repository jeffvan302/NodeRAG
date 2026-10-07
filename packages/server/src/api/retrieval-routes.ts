import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readinessStateSchema } from '@noderag/shared';
import { z } from 'zod';
import { SiloScope, withSiloScope } from '../identity/scope.js';
import { setupStatus } from '../setup/bootstrap.js';
import { databaseInteger } from '../store/database.js';
import { readinessPermits } from '../application/readiness-policy.js';
import { hashNormalizedQuery, writeAuditEvent } from '../application/audit.js';
import { coordinatedEmbedder } from '../store/resources.js';
import { executeSearch, normalizeSearchQuery, type SearchFilters } from '../search/retrieval.js';
import {
  exactSearchEvidence,
  semanticSearchEvidence,
  semanticSentenceCandidates,
} from '../search/evidence.js';
import { SemanticEvidenceCache, semanticEvidenceCacheKey } from '../search/evidence-cache.js';
import { qwenQ8RetrievalCalibration } from '../search/confidence.js';
import type { ContentRoutesOptions } from './content-routes.js';
import type { AuthenticatedPrincipal } from './authentication.js';
import { decodeCursor, encodeCursor, CursorError } from './cursor.js';
import { sendProblem } from './problem.js';

const idSchema = z.coerce.number().int().positive().safe();
const positiveSmallId = z.coerce.number().int().min(1).max(32_767);
const filterSchema = z
  .object({
    sourceIds: z.array(idSchema).max(64).optional(),
    pathPrefix: z.string().max(1024).optional(),
    formats: z
      .array(z.enum(['pdf', 'docx', 'xlsx', 'txt', 'md']))
      .max(5)
      .optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
    modifiedFrom: z.coerce.date().optional(),
    modifiedTo: z.coerce.date().optional(),
    pageFrom: z.number().int().min(0).max(1_000_000).optional(),
    pageTo: z.number().int().min(0).max(1_000_000).optional(),
    hasImages: z.boolean().optional(),
    hasTables: z.boolean().optional(),
    minimumConfidence: z.number().min(0.05).max(0.95).optional(),
  })
  .strict();
const searchSchema = z
  .object({
    query: z.string().min(1).max(4000),
    mode: z.enum(['vector', 'semantic', 'keyword', 'hybrid']).default('vector'),
    silos: z.array(positiveSmallId).min(1).max(64).optional(),
    siloIds: z.array(positiveSmallId).min(1).max(64).optional(),
    filters: filterSchema.default({}),
    limit: z.number().int().min(1).max(50).default(10),
    cursor: z.string().max(2048).optional(),
    rerank: z.literal(false).optional(),
  })
  .strict()
  .refine((value) => value.silos === undefined || value.siloIds === undefined, {
    message: 'Use silos or siloIds, not both.',
  });
const embedSchema = z
  .object({
    texts: z.array(z.string().min(1).max(32_000)).min(1).max(16),
    inputType: z.enum(['query', 'document']).default('document'),
  })
  .strict();
const evidenceSchema = z
  .object({
    query: z.string().min(1).max(4000),
    mode: z.enum(['vector', 'semantic', 'keyword', 'hybrid']),
    chunkIds: z.array(idSchema).min(1).max(8),
  })
  .strict();
const listSchema = z.object({
  siloId: positiveSmallId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(2048).optional(),
  state: z
    .enum(['pending', 'extracting', 'awaiting_vision', 'ready', 'source_missing', 'failed'])
    .optional(),
  format: z.enum(['pdf', 'docx', 'xlsx', 'txt', 'md']).optional(),
});
const pageQuerySchema = z.object({ highlight: idSchema.optional() });
const contextQuerySchema = z.object({
  before: z.coerce.number().int().min(0).max(10).default(1),
  after: z.coerce.number().int().min(0).max(10).default(1),
});

const exactFilters = (filters: z.infer<typeof filterSchema>): SearchFilters => ({
  ...(filters.sourceIds === undefined ? {} : { sourceIds: filters.sourceIds }),
  ...(filters.pathPrefix === undefined ? {} : { pathPrefix: filters.pathPrefix }),
  ...(filters.formats === undefined ? {} : { formats: filters.formats }),
  ...(filters.createdFrom === undefined ? {} : { createdFrom: filters.createdFrom }),
  ...(filters.createdTo === undefined ? {} : { createdTo: filters.createdTo }),
  ...(filters.modifiedFrom === undefined ? {} : { modifiedFrom: filters.modifiedFrom }),
  ...(filters.modifiedTo === undefined ? {} : { modifiedTo: filters.modifiedTo }),
  ...(filters.pageFrom === undefined ? {} : { pageFrom: filters.pageFrom }),
  ...(filters.pageTo === undefined ? {} : { pageTo: filters.pageTo }),
  ...(filters.hasImages === undefined ? {} : { hasImages: filters.hasImages }),
  ...(filters.hasTables === undefined ? {} : { hasTables: filters.hasTables }),
  ...(filters.minimumConfidence === undefined
    ? {}
    : { minimumConfidence: filters.minimumConfidence }),
});

interface DocumentRow {
  readonly id: unknown;
  readonly silo_id: number;
  readonly name: string;
  readonly title: string | null;
  readonly extension: string;
  readonly mime_type: string | null;
  readonly relative_path: string | null;
  readonly byte_count: unknown;
  readonly source_mtime: Date | null;
  readonly original_sha256: Buffer;
  readonly markdown_sha256: Buffer | null;
  readonly character_count: number | null;
  readonly page_count: number | null;
  readonly page_basis: string;
  readonly offsets_match_original: boolean;
  readonly source_state: string;
  readonly source_id: unknown | null;
  readonly state: string;
  readonly created_at: Date;
  readonly indexed_at: Date | null;
  readonly image_count?: unknown;
  readonly ingestion_jobs?: unknown;
}

const documentIngestionJobs = `
  (SELECT COALESCE(jsonb_agg(summary.item ORDER BY summary.id DESC), '[]'::jsonb)
   FROM (
     SELECT job.id,
            jsonb_build_object(
              'id', job.id,
              'kind', job.kind,
              'state', job.state,
              'logicalAttempt', job.logical_attempt,
              'maximumAttempts', job.max_attempts,
              'progress', job.progress,
              'createdAt', job.created_at,
              'updatedAt', job.updated_at,
              'finishedAt', job.finished_at,
              'error', job.structured_error
            ) AS item
     FROM noderag.job job
     WHERE job.document_id=d.id AND job.silo_id=d.silo_id
       AND job.kind IN ('extract','vision','embed')
     ORDER BY job.id DESC LIMIT 12
   ) summary) AS ingestion_jobs`;

const requirePrincipal = async (
  request: FastifyRequest,
  authenticate: ContentRoutesOptions['authenticate'],
): Promise<AuthenticatedPrincipal | null> => authenticate(request);

const readReady = async (options: ContentRoutesOptions): Promise<boolean> => {
  const state = readinessStateSchema.parse((await setupStatus(options.pool)).state);
  return readinessPermits(state, 'read');
};

const digestFile = async (path: string): Promise<Buffer> => {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part as Buffer);
  return hash.digest();
};

const asDocument = (row: DocumentRow) => ({
  id: databaseInteger(row.id, 'document id'),
  siloId: row.silo_id,
  name: row.name,
  title: row.title,
  format: row.extension,
  mimeType: row.mime_type,
  path: row.relative_path ?? row.name,
  bytes: databaseInteger(row.byte_count, 'document byte count'),
  modifiedAt: row.source_mtime,
  characters: row.character_count,
  pages: row.page_count,
  pageBasis: row.page_basis,
  offsetsMatchOriginal: row.offsets_match_original,
  sourceState: row.source_state,
  sourceId: row.source_id === null ? null : databaseInteger(row.source_id, 'source id'),
  state: row.state,
  createdAt: row.created_at,
  indexedAt: row.indexed_at,
  ...(row.image_count === undefined
    ? {}
    : { imageCount: databaseInteger(row.image_count, 'image count') }),
  ...(row.ingestion_jobs === undefined ? {} : { ingestionJobs: row.ingestion_jobs }),
});

const findDocument = async (
  options: ContentRoutesOptions,
  principal: AuthenticatedPrincipal,
  documentId: number,
  action: 'read_markdown' | 'download_original',
  gatewayId?: number,
): Promise<{ readonly row: DocumentRow; readonly scope: SiloScope } | null> => {
  if (principal.searchOnly) return null;
  const scope = await SiloScope.resolve(options.pool, principal.principalId, action, {
    ...(gatewayId === undefined ? {} : { gatewayId }),
  });
  if (scope.siloIds.length === 0) return null;
  const found = await withSiloScope(options.pool, scope, (database) =>
    database.query<DocumentRow>(
      `SELECT d.*, (SELECT count(*) FROM noderag.document_image i
                    WHERE i.document_id = d.id AND i.silo_id = d.silo_id) AS image_count,
              ${documentIngestionJobs}
       FROM noderag.document d WHERE d.id = $1 AND d.silo_id = ANY ($2::smallint[])`,
      [documentId, scope.siloIds],
    ),
  );
  const row = found.rows[0];
  return row === undefined ? null : { row, scope };
};

interface SearchCursor {
  readonly kind: 'search';
  readonly offset: number;
  readonly fingerprint: string;
}

export const registerRetrievalRoutes = (
  app: FastifyInstance,
  options: ContentRoutesOptions,
  gatewayId?: number,
): void => {
  const semanticEvidenceCache = new SemanticEvidenceCache();

  app.post('/v1/search', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null) return sendProblem(reply, 401, 'authentication_required', request.id);
    if (!(await readReady(options))) return sendProblem(reply, 503, 'read_not_ready', request.id);
    const parsed = searchSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const body = parsed.data;
    const requestedSiloIds = body.silos ?? body.siloIds;
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'search', {
      ...(gatewayId === undefined ? {} : { gatewayId }),
      ...(requestedSiloIds === undefined ? {} : { requestedSiloIds }),
    });
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          query: normalizeSearchQuery(body.query),
          mode: body.mode,
          scope: scope.siloIds,
          filters: body.filters,
        }),
      )
      .digest('hex');
    let offset = 0;
    if (body.cursor !== undefined) {
      try {
        const cursor = decodeCursor<SearchCursor>(body.cursor);
        if (
          cursor.kind !== 'search' ||
          cursor.fingerprint !== fingerprint ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0 ||
          cursor.offset > 950
        ) {
          throw new CursorError();
        }
        offset = cursor.offset;
      } catch {
        return sendProblem(reply, 400, 'invalid_cursor', request.id);
      }
    }
    if (scope.siloIds.length === 0)
      return reply.code(200).send({
        items: [],
        mode: body.mode,
        elapsedMs: 0,
        nextCursor: null,
      });
    try {
      const result = await executeSearch({
        pool: options.pool,
        embedder: options.embedder,
        files: options.files,
        principalId: principal.principalId,
        scope,
        requestId: request.id,
        sourceIp: request.ip,
        ...(gatewayId === undefined ? {} : { gatewayId }),
        request: {
          query: body.query,
          mode: body.mode,
          limit: Math.min(200, offset + body.limit + 1),
          filters: exactFilters(body.filters),
        },
        ...(options.retrievalCalibration === undefined
          ? {}
          : { calibration: options.retrievalCalibration }),
      });
      const page = result.items.slice(offset, offset + body.limit);
      const hasNext = result.items.length > offset + body.limit;
      return reply.code(200).send({
        items: page,
        mode: result.mode,
        elapsedMs: result.elapsedMs,
        nextCursor: hasNext
          ? encodeCursor({ kind: 'search', offset: offset + body.limit, fingerprint })
          : null,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'search_failed';
      const normalizedQuery = normalizeSearchQuery(body.query);
      await writeAuditEvent(options.pool, {
        principalId: principal.principalId,
        ...(gatewayId === undefined ? {} : { gatewayId }),
        action: 'search',
        result: 'error',
        normalizedQuerySha256: hashNormalizedQuery(normalizedQuery),
        rowCount: 0,
        requestId: request.id,
        sourceIp: request.ip,
        detail: {
          queryLength: normalizedQuery.length,
          mode: body.mode,
          filters: exactFilters(body.filters),
          scope: scope.siloIds,
          hitCount: 0,
          outcome: 'error',
          errorCode: code,
        },
      }).catch(() => undefined);
      if (code === 'TOKEN_LIMIT') return sendProblem(reply, 400, 'query_too_long', request.id);
      if (code === 'active_build_missing')
        return sendProblem(reply, 503, 'active_build_missing', request.id);
      if (code === 'incompatible_active_models')
        return sendProblem(reply, 503, 'incompatible_active_models', request.id);
      throw error;
    }
  });

  app.post('/v1/search/evidence', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null) return sendProblem(reply, 401, 'authentication_required', request.id);
    if (!(await readReady(options))) return sendProblem(reply, 503, 'read_not_ready', request.id);
    const parsed = evidenceSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const body = parsed.data;
    const chunkIds = [...new Set(body.chunkIds)];
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'read_chunk', {
      ...(gatewayId === undefined ? {} : { gatewayId }),
    });
    if (scope.siloIds.length === 0) return sendProblem(reply, 404, 'not_found', request.id);
    const rows = await withSiloScope(options.pool, scope, (database) =>
      database.query<{
        id: unknown;
        text: string;
        maximum_tokens: number;
        query_prefix: string;
        document_prefix: string;
        dimensions: number;
        manifest_digest: string;
      }>(
        `SELECT chunk.id, chunk.text, manifest.maximum_tokens, build.query_prefix,
                manifest.document_prefix, manifest.dimensions, manifest.manifest_digest
         FROM noderag.chunk chunk
         JOIN noderag.silo_build_state active
           ON active.silo_id=chunk.silo_id AND active.build_id=chunk.build_id
          AND active.state='active'
         JOIN noderag.build build ON build.id=chunk.build_id
         JOIN noderag.model_manifest manifest ON manifest.id=build.model_manifest_id
         WHERE chunk.id=ANY($1::bigint[]) AND chunk.silo_id=ANY($2::smallint[])
         ORDER BY array_position($1::bigint[], chunk.id)`,
        [chunkIds, scope.siloIds],
      ),
    );
    if (rows.rows.length !== chunkIds.length)
      return sendProblem(reply, 404, 'not_found', request.id);
    const modelKeys = new Set(
      rows.rows.map(
        (row) =>
          `${row.manifest_digest}:${String(row.dimensions)}:${String(row.maximum_tokens)}:${row.query_prefix}:${row.document_prefix}`,
      ),
    );
    if (modelKeys.size !== 1)
      return sendProblem(reply, 503, 'incompatible_active_models', request.id);
    const model = rows.rows[0];
    if (model === undefined) return sendProblem(reply, 404, 'not_found', request.id);
    const passage = rows.rows.map(({ text }) => text).join('\n');
    const exact = exactSearchEvidence(body.query, passage);
    if (body.mode === 'keyword') {
      return reply.send({
        items: exact,
        semanticStatus: 'not-requested',
        semanticCache: 'not-used',
      });
    }
    const candidates = semanticSentenceCandidates(passage);
    if (candidates.length === 0) {
      return reply.send({
        items: body.mode === 'semantic' ? [] : exact,
        semanticStatus: 'ready',
        semanticCache: 'not-used',
      });
    }
    const calibration = options.retrievalCalibration ?? qwenQ8RetrievalCalibration;
    const cacheKey = semanticEvidenceCacheKey({
      query: normalizeSearchQuery(body.query),
      passage,
      manifestDigest: model.manifest_digest,
      dimensions: model.dimensions,
      maximumTokens: model.maximum_tokens,
      queryPrefix: model.query_prefix,
      documentPrefix: model.document_prefix,
      calibration,
    });
    try {
      const cached = await semanticEvidenceCache.getOrCompute(cacheKey, async () => {
        const embedded = await coordinatedEmbedder(
          options.pool,
          `evidence:${request.id}`,
          options.embedder,
        ).embed(
          [
            `${model.query_prefix}${normalizeSearchQuery(body.query)}`,
            ...candidates.map((candidate) => `${model.document_prefix}${candidate}`),
          ],
          model.maximum_tokens,
          1,
          { manifestDigest: model.manifest_digest, dimensions: model.dimensions },
        );
        const queryVector = embedded.vectors[0];
        if (queryVector === undefined) throw new Error('query-vector-missing');
        return semanticSearchEvidence(
          candidates,
          queryVector,
          embedded.vectors.slice(1),
          calibration,
          4,
        );
      });
      return reply.send({
        items: body.mode === 'semantic' ? cached.evidence : [...exact, ...cached.evidence],
        semanticStatus: 'ready',
        semanticCache: cached.status,
      });
    } catch {
      return reply.send({
        items: body.mode === 'semantic' ? [] : exact,
        semanticStatus: 'unavailable',
        semanticCache: 'not-used',
      });
    }
  });

  app.post('/v1/embed', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null) return sendProblem(reply, 401, 'authentication_required', request.id);
    if (principal.searchOnly) return sendProblem(reply, 404, 'not_found', request.id);
    const parsed = embedSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const active = await options.pool.query<{
      maximum_tokens: number;
      query_prefix: string;
      document_prefix: string;
      name: string;
      source_revision: string;
      manifest_digest: string;
      dimensions: number;
    }>(
      `SELECT m.maximum_tokens,m.query_prefix,m.document_prefix,m.name,m.source_revision,
              m.manifest_digest,m.dimensions
       FROM noderag.settings settings
       JOIN noderag.model_manifest m ON m.id=settings.model_manifest_id
       WHERE settings.id=1`,
    );
    const model = active.rows[0];
    if (model === undefined) return sendProblem(reply, 503, 'active_build_missing', request.id);
    const prefix = parsed.data.inputType === 'query' ? model.query_prefix : model.document_prefix;
    try {
      const batch = await coordinatedEmbedder(
        options.pool,
        `raw-embed:${request.id}`,
        options.embedder,
      ).embed(
        parsed.data.texts.map((text) => `${prefix}${text.normalize('NFC')}`),
        model.maximum_tokens,
        0,
        { manifestDigest: model.manifest_digest, dimensions: model.dimensions },
      );
      return reply.send({
        vectors: batch.vectors,
        tokenCounts: batch.tokenCounts,
        dimensions: batch.vectors[0]?.length ?? 0,
        model: model.name,
        revision: model.source_revision,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'TOKEN_LIMIT')
        return sendProblem(reply, 400, 'input_too_long', request.id);
      throw error;
    }
  });

  app.get('/v1/documents', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null) return sendProblem(reply, 401, 'authentication_required', request.id);
    if (principal.searchOnly) return sendProblem(reply, 404, 'not_found', request.id);
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const query = parsed.data;
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'read_markdown', {
      ...(gatewayId === undefined ? {} : { gatewayId }),
      ...(query.siloId === undefined ? {} : { requestedSiloIds: [query.siloId] }),
    });
    if (scope.siloIds.length === 0) return reply.send({ items: [], nextCursor: null });
    let after: { readonly createdAt: string; readonly id: number } | undefined;
    if (query.cursor !== undefined) {
      try {
        const cursor = decodeCursor<{
          kind: string;
          scope: readonly number[];
          createdAt: string;
          id: number;
        }>(query.cursor);
        if (
          cursor.kind !== 'documents' ||
          JSON.stringify(cursor.scope) !== JSON.stringify(scope.siloIds)
        )
          throw new CursorError();
        after = { createdAt: cursor.createdAt, id: cursor.id };
      } catch {
        return sendProblem(reply, 400, 'invalid_cursor', request.id);
      }
    }
    const found = await withSiloScope(options.pool, scope, (database) =>
      database.query<DocumentRow>(
        `SELECT d.*, (SELECT count(*) FROM noderag.document_image i
                      WHERE i.document_id = d.id AND i.silo_id = d.silo_id) AS image_count,
                ${documentIngestionJobs}
         FROM noderag.document d
         WHERE d.silo_id = ANY ($1::smallint[])
           AND ($2::text IS NULL OR d.state = $2)
           AND ($3::text IS NULL OR d.extension = $3)
           AND ($4::timestamptz IS NULL OR (d.created_at, d.id) < ($4::timestamptz, $5::bigint))
         ORDER BY d.created_at DESC, d.id DESC LIMIT $6`,
        [
          scope.siloIds,
          query.state ?? null,
          query.format ?? null,
          after?.createdAt ?? null,
          after?.id ?? null,
          query.limit + 1,
        ],
      ),
    );
    const hasNext = found.rows.length > query.limit;
    const rows = found.rows.slice(0, query.limit);
    const last = rows.at(-1);
    return reply.send({
      items: rows.map(asDocument),
      nextCursor:
        hasNext && last !== undefined
          ? encodeCursor({
              kind: 'documents',
              scope: scope.siloIds,
              createdAt: last.created_at.toISOString(),
              id: databaseInteger(last.id, 'document id'),
            })
          : null,
    });
  });

  app.get('/v1/documents/:id', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null) return sendProblem(reply, 401, 'authentication_required', request.id);
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const found = await findDocument(options, principal, parsed.data, 'read_markdown', gatewayId);
    if (found === null) return sendProblem(reply, 404, 'not_found', request.id);
    return reply.send(asDocument(found.row));
  });

  app.get('/v1/documents/:id/markdown', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null) return sendProblem(reply, 401, 'authentication_required', request.id);
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const found = await findDocument(options, principal, parsed.data, 'read_markdown', gatewayId);
    if (found === null) return sendProblem(reply, 404, 'not_found', request.id);
    const path = options.files.paths(parsed.data).markdownAbsolute;
    try {
      if (
        found.row.markdown_sha256 === null ||
        !(await digestFile(path)).equals(found.row.markdown_sha256)
      )
        return sendProblem(reply, 409, 'markdown_integrity_failed', request.id);
    } catch {
      return sendProblem(reply, 404, 'artifact_missing', request.id);
    }
    return reply.type('text/markdown; charset=utf-8').send(createReadStream(path));
  });

  app.get('/v1/documents/:id/pages/:ordinal', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null) return sendProblem(reply, 401, 'authentication_required', request.id);
    const params = request.params as { id?: unknown; ordinal?: unknown };
    const documentId = idSchema.safeParse(params.id);
    const ordinal = z.coerce.number().int().min(0).safeParse(params.ordinal);
    const query = pageQuerySchema.safeParse(request.query);
    if (!documentId.success || !ordinal.success || !query.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    const found = await findDocument(
      options,
      principal,
      documentId.data,
      'read_markdown',
      gatewayId,
    );
    if (found === null) return sendProblem(reply, 404, 'not_found', request.id);
    const result = await withSiloScope(options.pool, found.scope, async (database) => {
      const page = await database.query<{
        ordinal: number;
        page_number: number | null;
        label: string | null;
        character_start: number;
        character_end: number;
        byte_start: number;
        byte_end: number;
        extraction: string;
        extraction_confidence: number | null;
      }>(
        `SELECT ordinal, page_number, label, character_start, character_end, byte_start, byte_end, extraction, extraction_confidence
         FROM noderag.document_page WHERE document_id = $1 AND silo_id = $2 AND ordinal = $3`,
        [documentId.data, found.row.silo_id, ordinal.data],
      );
      const row = page.rows[0];
      if (row === undefined) return null;
      let highlight: { character_start: number; character_end: number } | undefined;
      if (query.data.highlight !== undefined) {
        const chunk = await database.query<{ character_start: number; character_end: number }>(
          `SELECT character_start, character_end FROM noderag.chunk
           WHERE id = $1 AND document_id = $2 AND silo_id = $3`,
          [query.data.highlight, documentId.data, found.row.silo_id],
        );
        highlight = chunk.rows[0];
        if (highlight === undefined) return null;
      }
      return { row, highlight };
    });
    if (result === null) return sendProblem(reply, 404, 'not_found', request.id);
    const markdown = await readFile(options.files.paths(documentId.data).markdownAbsolute, 'utf8');
    const pageMarkdown = markdown.slice(result.row.character_start, result.row.character_end);
    const highlightStart =
      Math.max(
        result.row.character_start,
        result.highlight?.character_start ?? result.row.character_start,
      ) - result.row.character_start;
    const highlightEnd =
      Math.min(
        result.row.character_end,
        result.highlight?.character_end ?? result.row.character_start,
      ) - result.row.character_start;
    return reply.send({
      ordinal: result.row.ordinal,
      pageNumber: result.row.page_number,
      label: result.row.label,
      extraction: result.row.extraction,
      extractionConfidence: result.row.extraction_confidence,
      markdown: pageMarkdown,
      context:
        result.highlight === undefined
          ? null
          : {
              before: pageMarkdown.slice(0, highlightStart),
              match: pageMarkdown.slice(highlightStart, highlightEnd),
              after: pageMarkdown.slice(highlightEnd),
            },
      locator: {
        characterStart: result.row.character_start,
        characterEnd: result.row.character_end,
        characterUnit: 'utf16',
        byteStart: result.row.byte_start,
        byteEnd: result.row.byte_end,
        byteUnit: 'utf8',
      },
    });
  });

  app.get('/v1/documents/:id/original', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null) return sendProblem(reply, 401, 'authentication_required', request.id);
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const found = await findDocument(
      options,
      principal,
      parsed.data,
      'download_original',
      gatewayId,
    );
    if (found === null) return sendProblem(reply, 404, 'not_found', request.id);
    const path = options.files.paths(parsed.data, found.row.extension).originalAbsolute;
    try {
      await access(path);
      if (!(await digestFile(path)).equals(found.row.original_sha256))
        return sendProblem(reply, 409, 'original_integrity_failed', request.id);
    } catch {
      return sendProblem(reply, 404, 'artifact_missing', request.id);
    }
    reply.header(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(found.row.name)}`,
    );
    return reply
      .type(found.row.mime_type ?? 'application/octet-stream')
      .send(createReadStream(path));
  });

  const chunkHandler =
    (context: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = await requirePrincipal(request, options.authenticate);
      if (principal === null) return sendProblem(reply, 401, 'authentication_required', request.id);
      const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
      const parsedQuery = context
        ? contextQuerySchema.safeParse(request.query)
        : { success: true as const, data: { before: 0, after: 0 } };
      if (!parsedId.success || !parsedQuery.success)
        return sendProblem(reply, 400, 'invalid_request', request.id);
      const scope = await SiloScope.resolve(options.pool, principal.principalId, 'read_chunk', {
        ...(gatewayId === undefined ? {} : { gatewayId }),
      });
      if (scope.siloIds.length === 0) return sendProblem(reply, 404, 'not_found', request.id);
      const result = await withSiloScope(options.pool, scope, async (database) => {
        const target = await database.query<{
          id: unknown;
          silo_id: number;
          document_id: unknown;
          ordinal: number;
          text: string;
          character_start: number;
          character_end: number;
          byte_start: number;
          byte_end: number;
          page_start: number | null;
          page_end: number | null;
          heading_path: string[] | null;
        }>(
          `SELECT id, silo_id, document_id, ordinal, text, character_start, character_end,
                byte_start, byte_end, page_start, page_end, heading_path
         FROM noderag.chunk chunk WHERE id = $1 AND silo_id = ANY ($2::smallint[])
           AND EXISTS (SELECT 1 FROM noderag.silo_build_state active
                       WHERE active.silo_id=chunk.silo_id
                         AND active.build_id=chunk.build_id AND active.state='active')`,
          [parsedId.data, scope.siloIds],
        );
        const row = target.rows[0];
        if (row === undefined) return null;
        const neighbours = await database.query<typeof row>(
          `SELECT id, silo_id, document_id, ordinal, text, character_start, character_end,
                byte_start, byte_end, page_start, page_end, heading_path
         FROM noderag.chunk chunk WHERE silo_id = $1 AND document_id = $2
           AND EXISTS (SELECT 1 FROM noderag.silo_build_state active
                       WHERE active.silo_id=chunk.silo_id
                         AND active.build_id=chunk.build_id AND active.state='active')
           AND ordinal BETWEEN $3 AND $4 ORDER BY ordinal`,
          [
            row.silo_id,
            row.document_id,
            row.ordinal - parsedQuery.data.before,
            row.ordinal + parsedQuery.data.after,
          ],
        );
        return { target: row, items: neighbours.rows };
      });
      if (result === null) return sendProblem(reply, 404, 'not_found', request.id);
      const map = (row: typeof result.target) => ({
        chunkId: databaseInteger(row.id, 'chunk id'),
        siloId: row.silo_id,
        documentId: databaseInteger(row.document_id, 'document id'),
        ordinal: row.ordinal,
        text: row.text,
        headingPath: row.heading_path ?? [],
        locator: {
          pageStart: row.page_start,
          pageEnd: row.page_end,
          characterStart: row.character_start,
          characterEnd: row.character_end,
          characterUnit: 'utf16',
          byteStart: row.byte_start,
          byteEnd: row.byte_end,
          byteUnit: 'utf8',
        },
      });
      return reply.send(
        context ? { target: map(result.target), items: result.items.map(map) } : map(result.target),
      );
    };
  app.get('/v1/chunks/:id', chunkHandler(false));
  app.get('/v1/chunks/:id/context', chunkHandler(true));

  app.get('/v1/images/:id', async (request, reply) => {
    const principal = await requirePrincipal(request, options.authenticate);
    if (principal === null) return sendProblem(reply, 401, 'authentication_required', request.id);
    if (principal.searchOnly) return sendProblem(reply, 404, 'not_found', request.id);
    const parsed = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'read_markdown', {
      ...(gatewayId === undefined ? {} : { gatewayId }),
    });
    const found = await withSiloScope(options.pool, scope, (database) =>
      database.query<{
        id: unknown;
        document_id: unknown;
        silo_id: number;
        page_ordinal: number;
        sequence: number;
        width: number | null;
        height: number | null;
        state: string;
        media_type: string | null;
        storage_path: string | null;
        vision_kind: string | null;
        vision_markdown: string | null;
        vision_alt: string | null;
        vision_confidence: number | null;
      }>(
        `SELECT id, document_id, silo_id, page_ordinal, sequence, width, height, state,
                media_type, storage_path, vision_kind, vision_markdown, vision_alt, vision_confidence
         FROM noderag.document_image WHERE id = $1 AND silo_id = ANY ($2::smallint[])`,
        [parsed.data, scope.siloIds],
      ),
    );
    const row = found.rows[0];
    if (row === undefined) return sendProblem(reply, 404, 'not_found', request.id);
    return reply.send({
      id: databaseInteger(row.id, 'image id'),
      documentId: databaseInteger(row.document_id, 'document id'),
      siloId: row.silo_id,
      pageOrdinal: row.page_ordinal,
      sequence: row.sequence,
      width: row.width,
      height: row.height,
      state: row.state,
      mediaType: row.media_type,
      contentAvailable: row.storage_path !== null,
      vision:
        row.vision_kind === null
          ? null
          : {
              kind: row.vision_kind,
              markdown: row.vision_markdown,
              alt: row.vision_alt,
              confidence: row.vision_confidence,
            },
    });
  });
};
