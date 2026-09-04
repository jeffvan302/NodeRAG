import { rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { readinessStateSchema, type Embedder } from '@noderag/shared';
import type { Pool } from 'pg';
import { z } from 'zod';
import { hashNormalizedQuery } from '../application/audit.js';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import { readinessPermits } from '../application/readiness-policy.js';
import { SiloScope, withSiloScope } from '../identity/scope.js';
import { setupStatus } from '../setup/bootstrap.js';
import { databaseInteger } from '../store/database.js';
import { validatedMarkdownMetadata, type DocumentFileStore } from '../storage/document-files.js';
import { acceptMarkdownUpload, uploadRequestDigestInput } from '../ingest/upload.js';
import type { RequestAuthenticator } from './authentication.js';
import { coordinatedEmbedder } from '../store/resources.js';

const uploadQuerySchema = z.object({ siloId: z.coerce.number().int().min(1).max(32_767) });
const searchSchema = z.object({
  query: z.string().min(1).max(4000),
  siloIds: z.array(z.number().int().min(1).max(32_767)).min(1).max(64).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const problem = (status: number, code: string, requestId: string) => ({
  type: `https://noderag.local/problems/${code}`,
  title: code.replaceAll('_', ' '),
  status,
  code,
  requestId,
});

const vectorLiteral = (vector: readonly number[]): string => {
  if (vector.length !== 1024 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('invalid-query-vector');
  }
  return `[${vector.map((value) => String(value)).join(',')}]`;
};

export interface ContentRoutesOptions {
  readonly pool: Pool;
  readonly authenticate: RequestAuthenticator;
  readonly files: DocumentFileStore;
  readonly embedder: Embedder;
  readonly maximumUploadBytes?: number;
  readonly minimumFreeBytes?: number;
  readonly sourceRoots?: readonly string[];
}

export const registerContentRoutes = (
  app: FastifyInstance,
  options: ContentRoutesOptions,
): void => {
  const maximumUploadBytes = options.maximumUploadBytes ?? 2 * 1024 ** 3 - 1;
  app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: maximumUploadBytes },
    throwFileSizeLimit: true,
  });

  app.post('/v1/documents', async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === null) {
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    }
    if (
      !principal.csrfAllowed(request.headers['x-csrf-token']?.toString(), request.headers.origin)
    ) {
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    }
    const state = readinessStateSchema.parse((await setupStatus(options.pool)).state);
    if (!readinessPermits(state, 'mutation')) {
      return reply.code(503).send(problem(503, 'mutation_not_ready', request.id));
    }
    const parsedQuery = uploadQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send(problem(400, 'invalid_request', request.id));
    }
    const { siloId } = parsedQuery.data;
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'upload', {
      requestedSiloIds: [siloId],
    });
    if (!scope.includes(siloId)) {
      return reply.code(404).send(problem(404, 'silo_not_found', request.id));
    }
    const idempotencyKey = request.headers['idempotency-key']?.toString();
    if (idempotencyKey === undefined) {
      return reply.code(400).send(problem(400, 'idempotency_key_required', request.id));
    }
    let part: Awaited<ReturnType<typeof request.file>>;
    try {
      part = await request.file();
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send(problem(413, 'upload-too-large', request.id));
      }
      throw error;
    }
    if (part === undefined) return reply.code(400).send(problem(400, 'file_required', request.id));
    try {
      validatedMarkdownMetadata(part.filename, part.mimetype);
    } catch (error) {
      part.file.resume();
      const code = error instanceof Error ? error.message : 'invalid-upload';
      return reply.code(415).send(problem(415, code, request.id));
    }
    let staged;
    try {
      staged = await options.files.stageUpload(
        part.file,
        maximumUploadBytes,
        options.minimumFreeBytes ?? 128 * 1024 * 1024,
      );
      if (part.file.truncated) {
        await rm(staged.temporaryPath, { force: true });
        return reply.code(413).send(problem(413, 'upload-too-large', request.id));
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'upload-failed';
      const status =
        code === 'insufficient-disk-space'
          ? 507
          : code === 'upload-too-large' ||
              (error instanceof Error && 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE')
            ? 413
            : 400;
      return reply.code(status).send(problem(status, code, request.id));
    }
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `document-upload:${String(siloId)}`,
          key: idempotencyKey,
          request: uploadRequestDigestInput({
            siloId,
            filename: part.filename,
            mimeType: part.mimetype,
            sha256: staged.sha256,
            bytes: staged.bytes,
          }),
        },
        async (database) => {
          await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
            scope.postgresArray(),
          ]);
          const accepted = await acceptMarkdownUpload(database, options.files, {
            siloId,
            principalId: principal.principalId,
            filename: part.filename,
            mimeType: part.mimetype,
            staged,
          });
          return { status: 202, headers: {}, body: accepted };
        },
      );
      if (result.replayed) await rm(staged.temporaryPath, { force: true });
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      await rm(staged.temporaryPath, { force: true });
      if (error instanceof IdempotencyConflictError) {
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      }
      if (error instanceof Error && error.message === 'Invalid Idempotency-Key.') {
        return reply.code(400).send(problem(400, 'invalid_idempotency_key', request.id));
      }
      throw error;
    }
  });

  app.post('/v1/search', async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === null) {
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    }
    const state = readinessStateSchema.parse((await setupStatus(options.pool)).state);
    if (!readinessPermits(state, 'read')) {
      return reply.code(503).send(problem(503, 'read_not_ready', request.id));
    }
    const parsedBody = searchSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send(problem(400, 'invalid_request', request.id));
    }
    const body = parsedBody.data;
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'search', {
      ...(body.siloIds === undefined ? {} : { requestedSiloIds: body.siloIds }),
    });
    if (scope.siloIds.length === 0) return reply.code(200).send({ items: [] });
    const model = await options.pool.query<{
      maximum_tokens: number;
      query_prefix: string;
    }>(
      `SELECT m.maximum_tokens, b.query_prefix
       FROM noderag.build b JOIN noderag.model_manifest m ON m.id = b.model_manifest_id
       WHERE b.state = 'active'`,
    );
    const active = model.rows[0];
    if (active === undefined)
      return reply.code(503).send(problem(503, 'active_build_missing', request.id));
    let embedded;
    try {
      embedded = await coordinatedEmbedder(
        options.pool,
        `query:${request.id}`,
        options.embedder,
      ).embed([`${active.query_prefix}${body.query}`], active.maximum_tokens, 0);
    } catch (error) {
      if (error instanceof Error && error.message === 'TOKEN_LIMIT') {
        return reply.code(400).send(problem(400, 'query_too_long', request.id));
      }
      throw error;
    }
    const vector = embedded.vectors[0];
    if (vector === undefined) throw new Error('Embedder omitted the query vector.');
    const items = await withSiloScope(options.pool, scope, async (database) => {
      const settings = await database.query<{ ef_search: number }>(
        'SELECT ef_search FROM noderag.settings WHERE id = 1',
      );
      await database.query(`SELECT set_config('hnsw.ef_search', $1, true)`, [
        String(settings.rows[0]?.ef_search ?? 100),
      ]);
      const hits = await database.query<{
        id: unknown;
        silo_id: number;
        document_id: unknown;
        text: string;
        character_start: number;
        character_end: number;
        byte_start: number;
        byte_end: number;
        page_start: number | null;
        page_end: number | null;
        heading_path: string[] | null;
        name: string;
        title: string | null;
        page_basis: string;
        offsets_match_original: boolean;
        score: number;
      }>(
        `SELECT c.id, c.silo_id, c.document_id, c.text,
                c.character_start, c.character_end, c.byte_start, c.byte_end,
                c.page_start, c.page_end, c.heading_path,
                d.name, d.title, d.page_basis, d.offsets_match_original,
                1 - (c.embedding <=> $1::halfvec) AS score
         FROM noderag.chunk c
         JOIN noderag.document d ON d.silo_id = c.silo_id AND d.id = c.document_id
         JOIN noderag.build b ON b.id = c.build_id AND b.state = 'active'
         WHERE c.silo_id = ANY ($2::smallint[])
           AND d.state IN ('ready', 'source_missing')
         ORDER BY c.embedding <=> $1::halfvec, c.id
         LIMIT $3`,
        [vectorLiteral(vector), scope.siloIds, body.limit],
      );
      await database.query(
        `INSERT INTO noderag.audit_log
           (principal_id, silo_id, action, result, query_sha256, row_count, request_id,
            detail)
         VALUES ($1, NULL, 'search', 'ok', $2, $3, $4,
                 jsonb_build_object('mode', 'vector', 'siloCount', $5::int))`,
        [
          principal.principalId,
          hashNormalizedQuery(body.query),
          hits.rows.length,
          request.id,
          scope.siloIds.length,
        ],
      );
      return hits.rows.map((row) => ({
        chunkId: databaseInteger(row.id, 'chunk id'),
        siloId: row.silo_id,
        documentId: databaseInteger(row.document_id, 'search document id'),
        documentName: row.name,
        title: row.title,
        text: row.text,
        score: Number(row.score),
        headingPath: row.heading_path ?? [],
        locator: {
          pageStart: row.page_start,
          pageEnd: row.page_end,
          pageBasis: row.page_basis,
          characterStart: row.character_start,
          characterEnd: row.character_end,
          byteStart: row.byte_start,
          byteEnd: row.byte_end,
          offsetsMatchOriginal: row.offsets_match_original,
        },
      }));
    });
    return reply.code(200).send({ items });
  });
};
