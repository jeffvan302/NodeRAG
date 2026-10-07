import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readinessStateSchema } from '@noderag/shared';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import { readinessPermits } from '../application/readiness-policy.js';
import { SiloScope } from '../identity/scope.js';
import { setupStatus } from '../setup/bootstrap.js';
import { databaseInteger, type SqlClient } from '../store/database.js';
import type { ContentRoutesOptions } from './content-routes.js';
import type { AuthenticatedPrincipal } from './authentication.js';
import { sendProblem } from './problem.js';

const idSchema = z.coerce.number().int().positive().safe();
const positiveSmallId = z.number().int().min(1).max(32_767);
const searchModeSchema = z.enum(['vector', 'semantic', 'keyword', 'hybrid']);
const createResearchSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const locatorSchema = z
  .object({
    pageStart: z.number().int().min(0).nullable(),
    pageEnd: z.number().int().min(0).nullable(),
    pageLabel: z.string().max(500),
    pageBasis: z.string().max(40),
    characterStart: z.number().int().min(0),
    characterEnd: z.number().int().min(0),
    characterUnit: z.literal('utf16'),
    byteStart: z.number().int().min(0),
    byteEnd: z.number().int().min(0),
    byteUnit: z.literal('utf8'),
    offsetsMatchOriginal: z.boolean(),
    pageLabels: z.array(z.string().max(500)).max(100),
  })
  .strict()
  .refine((value) => value.characterEnd >= value.characterStart, {
    message: 'characterEnd must follow characterStart.',
  })
  .refine((value) => value.byteEnd >= value.byteStart, {
    message: 'byteEnd must follow byteStart.',
  });
const evidenceSchema = z
  .array(
    z
      .object({
        kind: z.enum(['exact', 'semantic']),
        text: z.string().min(1).max(16_000),
        confidence: z.number().min(0).max(1),
      })
      .strict(),
  )
  .max(20);
const addReferenceSchema = z
  .object({
    siloId: positiveSmallId,
    documentId: idSchema,
    chunkId: idSchema,
    chunkIds: z.array(idSchema).min(1).max(8),
    text: z.string().min(1).max(64_000),
    headingPath: z.array(z.string().max(500)).max(64),
    locator: locatorSchema,
    confidence: z.number().min(0).max(1),
    evidence: evidenceSchema,
    query: z.string().trim().min(1).max(4000),
    mode: searchModeSchema,
  })
  .strict()
  .refine((value) => value.chunkIds.includes(value.chunkId), {
    message: 'chunkIds must contain chunkId.',
  });
const addPageReferenceSchema = z
  .object({
    siloId: positiveSmallId,
    documentId: idSchema,
    anchorChunkId: idSchema,
    pageOrdinal: z.number().int().min(0),
    confidence: z.number().min(0).max(1),
    evidence: evidenceSchema,
    query: z.string().trim().min(1).max(4000),
    mode: searchModeSchema,
  })
  .strict();
const pageMembershipQuerySchema = z.object({ documentId: idSchema }).strict();
const membershipQuerySchema = z
  .object({ chunkIds: z.string().min(1).max(1200) })
  .strict()
  .transform((value, context) => {
    const chunkIds = [...new Set(value.chunkIds.split(',').map((item) => Number(item.trim())))];
    if (
      chunkIds.length < 1 ||
      chunkIds.length > 50 ||
      chunkIds.some((id) => !Number.isSafeInteger(id) || id < 1)
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid chunk IDs.' });
      return z.NEVER;
    }
    return { chunkIds };
  });

class ResearchRouteError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ResearchRouteError';
  }
}

interface ResearchRow {
  readonly id: unknown;
  readonly name: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly item_count: unknown;
}

interface ReferenceRow {
  readonly id: unknown;
  readonly research_id: unknown;
  readonly silo_id: number;
  readonly silo_slug: string;
  readonly document_id: unknown;
  readonly chunk_id: unknown;
  readonly chunk_ids: unknown[];
  readonly page_ordinal: number | null;
  readonly passage_text: string;
  readonly heading_path: string[];
  readonly locator: Record<string, unknown>;
  readonly confidence: number;
  readonly evidence: unknown[];
  readonly query_text: string;
  readonly search_mode: string;
  readonly selected_at: Date;
  readonly document_name: string;
  readonly document_title: string | null;
  readonly document_format: string;
  readonly document_path: string | null;
  readonly document_pages: number | null;
  readonly document_characters: number | null;
  readonly original_available: boolean;
  readonly original_sha256: Buffer;
}

const asResearch = (row: ResearchRow) => ({
  id: databaseInteger(row.id, 'research id'),
  name: row.name,
  itemCount: databaseInteger(row.item_count, 'research item count'),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const asReference = (row: ReferenceRow) => {
  const documentId = databaseInteger(row.document_id, 'research document id');
  const chunkId = databaseInteger(row.chunk_id, 'research chunk id');
  return {
    researchItemId: databaseInteger(row.id, 'research item id'),
    researchId: databaseInteger(row.research_id, 'research id'),
    selectedAt: row.selected_at,
    chunkId,
    chunkIds: row.chunk_ids.map((id) => databaseInteger(id, 'research chunk id')),
    referenceKind: row.page_ordinal === null ? 'passage' : 'page',
    pageOrdinal: row.page_ordinal,
    siloId: row.silo_id,
    silo: row.silo_slug,
    documentId,
    documentName: row.document_name,
    title: row.document_title,
    text: row.passage_text,
    markdown: row.passage_text,
    score: row.confidence,
    confidence: row.confidence,
    evidence: row.evidence,
    headingPath: row.heading_path,
    partOf: null,
    locator: row.locator,
    query: row.query_text,
    mode: row.search_mode,
    document: {
      id: documentId,
      title: row.document_title ?? row.document_name,
      format: row.document_format,
      path: row.document_path ?? row.document_name,
      pages: row.document_pages,
      characters: row.document_characters,
      originalAvailable: row.original_available,
      sha256: row.original_sha256.toString('hex'),
    },
  };
};

const problemFor = (reply: FastifyReply, error: unknown, requestId: string) => {
  if (error instanceof ResearchRouteError)
    return sendProblem(reply, error.status, error.code, requestId);
  if (error instanceof IdempotencyConflictError)
    return sendProblem(reply, 409, 'idempotency_conflict', requestId);
  if (error instanceof Error && error.message === 'Invalid Idempotency-Key.')
    return sendProblem(reply, 400, 'invalid_idempotency_key', requestId);
  throw error;
};

const requireResearchPrincipal = async (
  request: FastifyRequest,
  reply: FastifyReply,
  options: ContentRoutesOptions,
): Promise<AuthenticatedPrincipal | null> => {
  const principal = await options.authenticate(request);
  if (principal === null) {
    sendProblem(reply, 401, 'authentication_required', request.id);
    return null;
  }
  if (principal.searchOnly) {
    sendProblem(reply, 404, 'not_found', request.id);
    return null;
  }
  return principal;
};

const requireMutation = async (
  request: FastifyRequest,
  reply: FastifyReply,
  options: ContentRoutesOptions,
): Promise<AuthenticatedPrincipal | null> => {
  const principal = await requireResearchPrincipal(request, reply, options);
  if (principal === null) return null;
  if (!principal.csrfAllowed(request.headers['x-csrf-token']?.toString(), request.headers.origin)) {
    sendProblem(reply, 403, 'csrf_rejected', request.id);
    return null;
  }
  const state = readinessStateSchema.parse((await setupStatus(options.pool)).state);
  if (!readinessPermits(state, 'mutation')) {
    sendProblem(reply, 503, 'mutation_not_ready', request.id);
    return null;
  }
  return principal;
};

const requireIdempotencyKey = (request: FastifyRequest, reply: FastifyReply): string | null => {
  const key = request.headers['idempotency-key']?.toString();
  if (key !== undefined) return key;
  sendProblem(reply, 400, 'idempotency_key_required', request.id);
  return null;
};

const researchOwnedBy = async (
  database: SqlClient,
  researchId: number,
  principalId: number,
): Promise<boolean> => {
  const found = await database.query(
    `SELECT 1 FROM noderag.research_collection
     WHERE id=$1 AND owner_principal_id=$2`,
    [researchId, principalId],
  );
  return found.rowCount === 1;
};

const referenceColumns = `
  rr.id, rr.research_id, rr.silo_id, silo.slug AS silo_slug,
  rr.document_id, rr.chunk_id, rr.chunk_ids, rr.page_ordinal,
  rr.passage_text, rr.heading_path, rr.locator,
  rr.confidence, rr.evidence, rr.query_text,
  rr.search_mode, rr.selected_at,
  document.name AS document_name, document.title AS document_title,
  document.extension AS document_format, document.relative_path AS document_path,
  document.page_count AS document_pages, document.character_count AS document_characters,
  (document.source_state = 'present') AS original_available, document.original_sha256`;

export const registerResearchRoutes = (
  app: FastifyInstance,
  options: ContentRoutesOptions,
): void => {
  app.get('/v1/research', async (request, reply) => {
    const principal = await requireResearchPrincipal(request, reply, options);
    if (principal === null) return;
    const state = readinessStateSchema.parse((await setupStatus(options.pool)).state);
    if (!readinessPermits(state, 'read'))
      return sendProblem(reply, 503, 'read_not_ready', request.id);
    const rows = await options.pool.query<ResearchRow>(
      `SELECT research.id, research.name, research.created_at, research.updated_at,
              count(rr.id) AS item_count
       FROM noderag.research_collection research
       LEFT JOIN noderag.research_reference rr ON rr.research_id=research.id
       WHERE research.owner_principal_id=$1
       GROUP BY research.id
       ORDER BY research.updated_at DESC, research.id DESC`,
      [principal.principalId],
    );
    return reply.send({ items: rows.rows.map(asResearch) });
  });

  app.post('/v1/research', async (request, reply) => {
    const principal = await requireMutation(request, reply, options);
    if (principal === null) return;
    const parsed = createResearchSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const key = requireIdempotencyKey(request, reply);
    if (key === null) return;
    const name = parsed.data.name.normalize('NFC');
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: 'research-create',
          key,
          request: JSON.stringify({ name }),
        },
        async (database) => {
          const inserted = await database.query<ResearchRow>(
            `INSERT INTO noderag.research_collection(owner_principal_id,name)
             VALUES($1,$2)
             ON CONFLICT (owner_principal_id, (lower(name))) DO NOTHING
             RETURNING id,name,created_at,updated_at,0::bigint AS item_count`,
            [principal.principalId, name],
          );
          const row = inserted.rows[0];
          if (row === undefined) throw new ResearchRouteError(409, 'research_name_exists');
          return { status: 201, headers: {}, body: asResearch(row) };
        },
      );
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return problemFor(reply, error, request.id);
    }
  });

  app.get('/v1/research/memberships', async (request, reply) => {
    const principal = await requireResearchPrincipal(request, reply, options);
    if (principal === null) return;
    const parsed = membershipQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'read_chunk');
    if (scope.siloIds.length === 0) return reply.send({ items: [] });
    const memberships = await options.pool.query<{
      chunk_id: unknown;
      research_id: unknown;
      research_name: string;
      research_item_id: unknown;
    }>(
      `SELECT rr.chunk_id, research.id AS research_id,
              research.name AS research_name, rr.id AS research_item_id
       FROM noderag.research_reference rr
       JOIN noderag.research_collection research ON research.id=rr.research_id
       WHERE research.owner_principal_id=$1
         AND rr.chunk_id=ANY($2::bigint[])
         AND rr.silo_id=ANY($3::smallint[])
         AND rr.page_ordinal IS NULL
       ORDER BY rr.chunk_id, research.name, research.id`,
      [principal.principalId, parsed.data.chunkIds, scope.siloIds],
    );
    return reply.send({
      items: memberships.rows.map((row) => ({
        chunkId: databaseInteger(row.chunk_id, 'research chunk id'),
        researchId: databaseInteger(row.research_id, 'research id'),
        researchName: row.research_name,
        researchItemId: databaseInteger(row.research_item_id, 'research item id'),
      })),
    });
  });

  app.get('/v1/research/:id/page-memberships', async (request, reply) => {
    const principal = await requireResearchPrincipal(request, reply, options);
    if (principal === null) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const parsedQuery = pageMembershipQuerySchema.safeParse(request.query);
    if (!parsedId.success || !parsedQuery.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    if (!(await researchOwnedBy(options.pool, parsedId.data, principal.principalId)))
      return sendProblem(reply, 404, 'research_not_found', request.id);
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'read_chunk');
    if (scope.siloIds.length === 0) return reply.send({ items: [] });
    const memberships = await options.pool.query<{
      id: unknown;
      page_ordinal: number;
      locator: Record<string, unknown>;
    }>(
      `SELECT rr.id, rr.page_ordinal, rr.locator
       FROM noderag.research_reference rr
       WHERE rr.research_id=$1
         AND rr.document_id=$2
         AND rr.silo_id=ANY($3::smallint[])
         AND rr.page_ordinal IS NOT NULL
       ORDER BY rr.page_ordinal, rr.id`,
      [parsedId.data, parsedQuery.data.documentId, scope.siloIds],
    );
    return reply.send({
      items: memberships.rows.map((row) => ({
        researchItemId: databaseInteger(row.id, 'research item id'),
        pageOrdinal: row.page_ordinal,
        pageNumber:
          typeof row.locator['pageStart'] === 'number'
            ? row.locator['pageStart']
            : row.page_ordinal + 1,
      })),
    });
  });

  app.get('/v1/research/:id/items', async (request, reply) => {
    const principal = await requireResearchPrincipal(request, reply, options);
    if (principal === null) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsedId.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    if (!(await researchOwnedBy(options.pool, parsedId.data, principal.principalId)))
      return sendProblem(reply, 404, 'research_not_found', request.id);
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'read_chunk');
    const count = await options.pool.query<{ count: unknown }>(
      `SELECT count(*) AS count FROM noderag.research_reference WHERE research_id=$1`,
      [parsedId.data],
    );
    if (scope.siloIds.length === 0) {
      return reply.send({
        items: [],
        total: databaseInteger(count.rows[0]?.count, 'item count'),
        hidden: databaseInteger(count.rows[0]?.count, 'hidden item count'),
      });
    }
    const rows = await options.pool.query<ReferenceRow>(
      `SELECT ${referenceColumns}
       FROM noderag.research_reference rr
       JOIN noderag.document document
         ON document.silo_id=rr.silo_id AND document.id=rr.document_id
       JOIN noderag.silo silo ON silo.id=rr.silo_id
       WHERE rr.research_id=$1 AND rr.silo_id=ANY($2::smallint[])
       ORDER BY rr.selected_at, rr.id
       LIMIT 1000`,
      [parsedId.data, scope.siloIds],
    );
    const total = databaseInteger(count.rows[0]?.count, 'item count');
    return reply.send({
      items: rows.rows.map(asReference),
      total,
      hidden: total - rows.rows.length,
    });
  });

  app.post('/v1/research/:id/items', async (request, reply) => {
    const principal = await requireMutation(request, reply, options);
    if (principal === null) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const parsedBody = addReferenceSchema.safeParse(request.body);
    if (!parsedId.success || !parsedBody.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    const key = requireIdempotencyKey(request, reply);
    if (key === null) return;
    const body = parsedBody.data;
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'read_chunk', {
      requestedSiloIds: [body.siloId],
    });
    if (!scope.includes(body.siloId))
      return sendProblem(reply, 404, 'reference_not_found', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `research-reference-add:${String(parsedId.data)}`,
          key,
          request: JSON.stringify(body),
        },
        async (database) => {
          if (!(await researchOwnedBy(database, parsedId.data, principal.principalId)))
            throw new ResearchRouteError(404, 'research_not_found');
          const source = await database.query(
            `SELECT 1 FROM noderag.chunk chunk
             JOIN noderag.silo_build_state active
               ON active.silo_id=chunk.silo_id AND active.build_id=chunk.build_id
              AND active.state='active'
             WHERE chunk.id=$1 AND chunk.silo_id=$2 AND chunk.document_id=$3`,
            [body.chunkId, body.siloId, body.documentId],
          );
          if (source.rowCount !== 1) throw new ResearchRouteError(404, 'reference_not_found');
          const inserted = await database.query<ReferenceRow>(
            `WITH upsert AS (
             INSERT INTO noderag.research_reference
               (research_id,silo_id,document_id,chunk_id,chunk_ids,passage_text,
                heading_path,locator,confidence,evidence,query_text,search_mode)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12)
             ON CONFLICT (research_id,silo_id,document_id,chunk_id)
               WHERE page_ordinal IS NULL
             DO UPDATE
               SET chunk_ids=EXCLUDED.chunk_ids, passage_text=EXCLUDED.passage_text,
                   heading_path=EXCLUDED.heading_path, locator=EXCLUDED.locator,
                   confidence=EXCLUDED.confidence, evidence=EXCLUDED.evidence,
                   query_text=EXCLUDED.query_text, search_mode=EXCLUDED.search_mode
             RETURNING *)
             SELECT ${referenceColumns}
             FROM upsert rr
             JOIN noderag.document document
               ON document.silo_id=rr.silo_id AND document.id=rr.document_id
             JOIN noderag.silo silo ON silo.id=rr.silo_id`,
            [
              parsedId.data,
              body.siloId,
              body.documentId,
              body.chunkId,
              body.chunkIds,
              body.text.normalize('NFC'),
              body.headingPath.map((heading) => heading.normalize('NFC')),
              JSON.stringify(body.locator),
              body.confidence,
              JSON.stringify(body.evidence),
              body.query.normalize('NFC'),
              body.mode,
            ],
          );
          const row = inserted.rows[0];
          if (row === undefined) throw new Error('Research reference insertion returned no row.');
          await database.query(
            `UPDATE noderag.research_collection SET updated_at=now() WHERE id=$1`,
            [parsedId.data],
          );
          return { status: 201, headers: {}, body: asReference(row) };
        },
      );
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return problemFor(reply, error, request.id);
    }
  });

  app.post('/v1/research/:id/pages', async (request, reply) => {
    const principal = await requireMutation(request, reply, options);
    if (principal === null) return;
    const parsedId = idSchema.safeParse((request.params as { id?: unknown }).id);
    const parsedBody = addPageReferenceSchema.safeParse(request.body);
    if (!parsedId.success || !parsedBody.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    const key = requireIdempotencyKey(request, reply);
    if (key === null) return;
    const body = parsedBody.data;
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'read_chunk', {
      requestedSiloIds: [body.siloId],
    });
    if (!scope.includes(body.siloId))
      return sendProblem(reply, 404, 'reference_not_found', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `research-page-add:${String(parsedId.data)}`,
          key,
          request: JSON.stringify(body),
        },
        async (database) => {
          if (!(await researchOwnedBy(database, parsedId.data, principal.principalId)))
            throw new ResearchRouteError(404, 'research_not_found');
          const anchor = await database.query(
            `SELECT 1 FROM noderag.chunk chunk
             JOIN noderag.silo_build_state active
               ON active.silo_id=chunk.silo_id AND active.build_id=chunk.build_id
              AND active.state='active'
             WHERE chunk.id=$1 AND chunk.silo_id=$2 AND chunk.document_id=$3`,
            [body.anchorChunkId, body.siloId, body.documentId],
          );
          if (anchor.rowCount !== 1) throw new ResearchRouteError(404, 'reference_not_found');
          const page = await database.query<{
            ordinal: number;
            page_number: number | null;
            label: string | null;
            character_start: number;
            character_end: number;
            byte_start: number;
            byte_end: number;
          }>(
            `SELECT ordinal,page_number,label,character_start,character_end,byte_start,byte_end
             FROM noderag.document_page
             WHERE document_id=$1 AND silo_id=$2 AND ordinal=$3`,
            [body.documentId, body.siloId, body.pageOrdinal],
          );
          const pageRow = page.rows[0];
          if (pageRow === undefined) throw new ResearchRouteError(404, 'document_page_not_found');
          const pageChunks = await database.query<{
            id: unknown;
            heading_path: string[];
          }>(
            `SELECT chunk.id,chunk.heading_path
             FROM noderag.chunk chunk
             JOIN noderag.silo_build_state active
               ON active.silo_id=chunk.silo_id AND active.build_id=chunk.build_id
              AND active.state='active'
             WHERE chunk.silo_id=$1 AND chunk.document_id=$2
               AND chunk.character_start < $3 AND chunk.character_end > $4
             ORDER BY chunk.ordinal,chunk.id
             LIMIT 8`,
            [body.siloId, body.documentId, pageRow.character_end, pageRow.character_start],
          );
          const chunkIds = pageChunks.rows.map((row) =>
            databaseInteger(row.id, 'research chunk id'),
          );
          if (chunkIds.length === 0) chunkIds.push(body.anchorChunkId);
          const primaryChunkId = chunkIds[0] ?? body.anchorChunkId;
          let markdown: string;
          try {
            markdown = await readFile(
              options.files.paths(body.documentId).markdownAbsolute,
              'utf8',
            );
          } catch {
            throw new ResearchRouteError(404, 'artifact_missing');
          }
          const displayedPage = pageRow.page_number ?? pageRow.ordinal + 1;
          const pageText = markdown
            .slice(pageRow.character_start, pageRow.character_end)
            .normalize('NFC')
            .slice(0, 64_000);
          const passageText =
            pageText.trim().length > 0
              ? pageText
              : `[Page ${String(displayedPage)} contains no extracted text.]`;
          const locator = {
            pageStart: displayedPage,
            pageEnd: displayedPage,
            pageLabel: pageRow.label ?? `p. ${String(displayedPage)}`,
            pageBasis: 'exact',
            characterStart: pageRow.character_start,
            characterEnd: pageRow.character_end,
            characterUnit: 'utf16',
            byteStart: pageRow.byte_start,
            byteEnd: pageRow.byte_end,
            byteUnit: 'utf8',
            offsetsMatchOriginal: false,
            pageLabels: [pageRow.label ?? `p. ${String(displayedPage)}`],
          };
          const inserted = await database.query<ReferenceRow>(
            `WITH upsert AS (
             INSERT INTO noderag.research_reference
               (research_id,silo_id,document_id,chunk_id,chunk_ids,page_ordinal,passage_text,
                heading_path,locator,confidence,evidence,query_text,search_mode)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13)
             ON CONFLICT (research_id,silo_id,document_id,page_ordinal)
               WHERE page_ordinal IS NOT NULL
             DO UPDATE SET chunk_id=EXCLUDED.chunk_id,chunk_ids=EXCLUDED.chunk_ids,
                   passage_text=EXCLUDED.passage_text,heading_path=EXCLUDED.heading_path,
                   locator=EXCLUDED.locator,confidence=EXCLUDED.confidence,
                   evidence=EXCLUDED.evidence,query_text=EXCLUDED.query_text,
                   search_mode=EXCLUDED.search_mode
             RETURNING *)
             SELECT ${referenceColumns}
             FROM upsert rr
             JOIN noderag.document document
               ON document.silo_id=rr.silo_id AND document.id=rr.document_id
             JOIN noderag.silo silo ON silo.id=rr.silo_id`,
            [
              parsedId.data,
              body.siloId,
              body.documentId,
              primaryChunkId,
              chunkIds,
              pageRow.ordinal,
              passageText,
              pageChunks.rows[0]?.heading_path ?? [],
              JSON.stringify(locator),
              body.confidence,
              JSON.stringify(body.evidence),
              body.query.normalize('NFC'),
              body.mode,
            ],
          );
          const row = inserted.rows[0];
          if (row === undefined) throw new Error('Research page insertion returned no row.');
          await database.query(
            `UPDATE noderag.research_collection SET updated_at=now() WHERE id=$1`,
            [parsedId.data],
          );
          return { status: 201, headers: {}, body: asReference(row) };
        },
      );
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return problemFor(reply, error, request.id);
    }
  });

  app.delete('/v1/research/:id/items/:itemId', async (request, reply) => {
    const principal = await requireMutation(request, reply, options);
    if (principal === null) return;
    const params = request.params as { id?: unknown; itemId?: unknown };
    const parsedId = idSchema.safeParse(params.id);
    const parsedItemId = idSchema.safeParse(params.itemId);
    if (!parsedId.success || !parsedItemId.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    const key = requireIdempotencyKey(request, reply);
    if (key === null) return;
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `research-reference-remove:${String(parsedId.data)}`,
          key,
          request: JSON.stringify({ itemId: parsedItemId.data }),
        },
        async (database) => {
          if (!(await researchOwnedBy(database, parsedId.data, principal.principalId)))
            throw new ResearchRouteError(404, 'research_not_found');
          const removed = await database.query(
            `DELETE FROM noderag.research_reference
             WHERE id=$1 AND research_id=$2 RETURNING id`,
            [parsedItemId.data, parsedId.data],
          );
          if (removed.rowCount !== 1)
            throw new ResearchRouteError(404, 'research_reference_not_found');
          await database.query(
            `UPDATE noderag.research_collection SET updated_at=now() WHERE id=$1`,
            [parsedId.data],
          );
          return {
            status: 200,
            headers: {},
            body: { removed: true, researchItemId: parsedItemId.data },
          };
        },
      );
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return problemFor(reply, error, request.id);
    }
  });
};
