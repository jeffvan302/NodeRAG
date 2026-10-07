import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SiloScope, withSiloScope } from '../identity/scope.js';
import { databaseInteger } from '../store/database.js';
import { writeAuditEvent } from '../application/audit.js';
import { executeSearch, type SearchFilters } from '../search/retrieval.js';
import type { ContentRoutesOptions } from './content-routes.js';
import { sendProblem } from './problem.js';

const requestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const searchArguments = z
  .object({
    query: z.string().min(1).max(4000),
    mode: z.enum(['vector', 'semantic', 'keyword', 'hybrid']).default('vector'),
    siloIds: z.array(z.number().int().min(1).max(32_767)).max(64).optional(),
    limit: z.number().int().min(1).max(50).default(10),
    filters: z
      .object({
        sourceIds: z.array(z.number().int().positive()).max(64).optional(),
        pathPrefix: z.string().max(1024).optional(),
        formats: z
          .array(z.enum(['pdf', 'docx', 'xlsx', 'txt', 'md']))
          .max(5)
          .optional(),
        pageFrom: z.number().int().min(0).optional(),
        pageTo: z.number().int().min(0).optional(),
        hasImages: z.boolean().optional(),
        hasTables: z.boolean().optional(),
        minimumConfidence: z.number().min(0.05).max(0.95).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
const chunkArguments = z
  .object({
    chunkId: z.number().int().positive(),
    before: z.number().int().min(0).max(10).default(1),
    after: z.number().int().min(0).max(10).default(1),
  })
  .strict();
const pageArguments = z
  .object({
    documentId: z.number().int().positive(),
    pageOrdinal: z.number().int().min(0),
    highlightChunkId: z.number().int().positive(),
  })
  .strict();
const callSchema = z
  .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })
  .strict();

const tools = [
  {
    name: 'search_documents',
    title: 'Search NodeRag documents',
    description:
      'Search only the silos granted to the authenticated principal. Requested silo IDs can narrow but never widen that scope.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 4000 },
        mode: {
          type: 'string',
          enum: ['vector', 'semantic', 'keyword', 'hybrid'],
          default: 'vector',
        },
        siloIds: {
          type: 'array',
          maxItems: 64,
          items: { type: 'integer', minimum: 1, maximum: 32767 },
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        filters: {
          type: 'object',
          properties: {
            minimumConfidence: {
              type: 'number',
              minimum: 0.05,
              maximum: 0.95,
              default: 0.3,
            },
          },
          additionalProperties: false,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_chunk_context',
    title: 'Get passage context',
    description: 'Return an authorized chunk and a bounded number of neighboring chunks.',
    inputSchema: {
      type: 'object',
      properties: {
        chunkId: { type: 'integer', minimum: 1 },
        before: { type: 'integer', minimum: 0, maximum: 10, default: 1 },
        after: { type: 'integer', minimum: 0, maximum: 10, default: 1 },
      },
      required: ['chunkId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_document_page',
    title: 'Get highlighted document page',
    description:
      'Return a page pre-split around an authorized highlight chunk; a complete unscoped page is never returned.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'integer', minimum: 1 },
        pageOrdinal: { type: 'integer', minimum: 0 },
        highlightChunkId: { type: 'integer', minimum: 1 },
      },
      required: ['documentId', 'pageOrdinal', 'highlightChunkId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_silos',
    title: 'List searchable silos',
    description: 'List only silos the authenticated principal can search through this gateway.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const;

const response = (id: string | number | null | undefined, result: unknown) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  result,
});
const protocolError = (
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});
const toolResult = (value: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: { result: value },
  isError: false,
});
const toolFailure = (code: string) => ({
  content: [{ type: 'text', text: code }],
  structuredContent: { code },
  isError: true,
});

const exactFilters = (input: z.infer<typeof searchArguments>['filters']): SearchFilters => ({
  ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds }),
  ...(input.pathPrefix === undefined ? {} : { pathPrefix: input.pathPrefix }),
  ...(input.formats === undefined ? {} : { formats: input.formats }),
  ...(input.pageFrom === undefined ? {} : { pageFrom: input.pageFrom }),
  ...(input.pageTo === undefined ? {} : { pageTo: input.pageTo }),
  ...(input.hasImages === undefined ? {} : { hasImages: input.hasImages }),
  ...(input.hasTables === undefined ? {} : { hasTables: input.hasTables }),
  ...(input.minimumConfidence === undefined ? {} : { minimumConfidence: input.minimumConfidence }),
});

export const registerMcpRoutes = (
  app: FastifyInstance,
  options: ContentRoutesOptions,
  gatewayId?: number,
): void => {
  app.post('/mcp', async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === null) return sendProblem(reply, 401, 'authentication_required', request.id);
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send(protocolError(null, -32600, 'Invalid Request'));
    const message = parsed.data;
    if (message.method === 'notifications/initialized') return reply.code(202).send();
    if (message.method === 'initialize') {
      return reply.send(
        response(message.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'NodeRag', version: '1.0.0-rc.1' },
          instructions:
            'NodeRag scopes every tool to the authenticated principal and the current gateway. Silo arguments only narrow access.',
        }),
      );
    }
    if (message.method === 'ping') return reply.send(response(message.id, {}));
    if (message.method === 'tools/list') return reply.send(response(message.id, { tools }));
    if (message.method !== 'tools/call')
      return reply.code(404).send(protocolError(message.id, -32601, 'Method not found'));
    const call = callSchema.safeParse(message.params);
    if (!call.success)
      return reply.code(400).send(protocolError(message.id, -32602, 'Invalid params'));
    try {
      if (call.data.name === 'search_documents') {
        const args = searchArguments.safeParse(call.data.arguments ?? {});
        if (!args.success)
          return reply.send(response(message.id, toolFailure('invalid_arguments')));
        const scope = await SiloScope.resolve(options.pool, principal.principalId, 'search', {
          ...(gatewayId === undefined ? {} : { gatewayId }),
          ...(args.data.siloIds === undefined ? {} : { requestedSiloIds: args.data.siloIds }),
        });
        const result =
          scope.siloIds.length === 0
            ? { items: [], mode: args.data.mode, elapsedMs: 0 }
            : await executeSearch({
                pool: options.pool,
                embedder: options.embedder,
                files: options.files,
                principalId: principal.principalId,
                scope,
                requestId: request.id,
                sourceIp: request.ip,
                ...(gatewayId === undefined ? {} : { gatewayId }),
                request: {
                  query: args.data.query,
                  mode: args.data.mode,
                  limit: args.data.limit,
                  filters: exactFilters(args.data.filters),
                },
                ...(options.retrievalCalibration === undefined
                  ? {}
                  : { calibration: options.retrievalCalibration }),
              });
        return reply.send(
          response(
            message.id,
            toolResult({ items: result.items, mode: result.mode, elapsedMs: result.elapsedMs }),
          ),
        );
      }
      if (call.data.name === 'list_silos') {
        if (Object.keys(call.data.arguments ?? {}).length > 0)
          return reply.send(response(message.id, toolFailure('invalid_arguments')));
        const scope = await SiloScope.resolve(options.pool, principal.principalId, 'list_silos', {
          ...(gatewayId === undefined ? {} : { gatewayId }),
        });
        const found = await options.pool.query<{ id: number; slug: string; display_name: string }>(
          `SELECT id,slug,display_name FROM noderag.silo WHERE id=ANY($1::smallint[]) ORDER BY display_name,id`,
          [scope.siloIds],
        );
        const value = {
          items: found.rows.map((row) => ({
            id: row.id,
            slug: row.slug,
            displayName: row.display_name,
          })),
        };
        await writeAuditEvent(options.pool, {
          principalId: principal.principalId,
          ...(gatewayId === undefined ? {} : { gatewayId }),
          action: 'mcp.list_silos',
          result: 'ok',
          rowCount: value.items.length,
          requestId: request.id,
          sourceIp: request.ip,
          detail: { scope: scope.siloIds, outcome: 'ok' },
        });
        return reply.send(response(message.id, toolResult(value)));
      }
      if (call.data.name === 'get_chunk_context') {
        const args = chunkArguments.safeParse(call.data.arguments ?? {});
        if (!args.success)
          return reply.send(response(message.id, toolFailure('invalid_arguments')));
        const scope = await SiloScope.resolve(options.pool, principal.principalId, 'read_chunk', {
          ...(gatewayId === undefined ? {} : { gatewayId }),
        });
        const value = await withSiloScope(options.pool, scope, async (database) => {
          const target = await database.query<{
            id: unknown;
            silo_id: number;
            document_id: unknown;
            ordinal: number;
          }>(
            `SELECT chunk.id,chunk.silo_id,chunk.document_id,chunk.ordinal
             FROM noderag.chunk chunk
             JOIN noderag.silo_build_state active
               ON active.silo_id=chunk.silo_id AND active.build_id=chunk.build_id
              AND active.state='active'
             WHERE chunk.id=$1 AND chunk.silo_id=ANY($2::smallint[])`,
            [args.data.chunkId, scope.siloIds],
          );
          const row = target.rows[0];
          if (row === undefined) return null;
          const chunks = await database.query<{
            id: unknown;
            ordinal: number;
            text: string;
            page_start: number | null;
            page_end: number | null;
            character_start: number;
            character_end: number;
            byte_start: number;
            byte_end: number;
          }>(
            `SELECT chunk.id,chunk.ordinal,chunk.text,chunk.page_start,chunk.page_end,
                    chunk.character_start,chunk.character_end,chunk.byte_start,chunk.byte_end
             FROM noderag.chunk chunk
             JOIN noderag.silo_build_state active
               ON active.silo_id=chunk.silo_id AND active.build_id=chunk.build_id
              AND active.state='active'
             WHERE chunk.silo_id=$1 AND chunk.document_id=$2
               AND chunk.ordinal BETWEEN $3 AND $4 ORDER BY chunk.ordinal`,
            [
              row.silo_id,
              row.document_id,
              row.ordinal - args.data.before,
              row.ordinal + args.data.after,
            ],
          );
          await writeAuditEvent(database, {
            principalId: principal.principalId,
            ...(gatewayId === undefined ? {} : { gatewayId }),
            siloId: row.silo_id,
            action: 'mcp.get_chunk_context',
            result: 'ok',
            rowCount: chunks.rows.length,
            requestId: request.id,
            sourceIp: request.ip,
            detail: { scope: scope.siloIds, chunkId: args.data.chunkId, outcome: 'ok' },
          });
          return {
            targetChunkId: args.data.chunkId,
            items: chunks.rows.map((chunk) => ({
              chunkId: databaseInteger(chunk.id, 'chunk id'),
              ordinal: chunk.ordinal,
              text: chunk.text,
              locator: {
                pageStart: chunk.page_start,
                pageEnd: chunk.page_end,
                characterStart: chunk.character_start,
                characterEnd: chunk.character_end,
                characterUnit: 'utf16',
                byteStart: chunk.byte_start,
                byteEnd: chunk.byte_end,
                byteUnit: 'utf8',
              },
            })),
          };
        });
        return reply.send(
          response(message.id, value === null ? toolFailure('not_found') : toolResult(value)),
        );
      }
      if (call.data.name === 'get_document_page') {
        if (principal.searchOnly) return reply.send(response(message.id, toolFailure('not_found')));
        const args = pageArguments.safeParse(call.data.arguments ?? {});
        if (!args.success)
          return reply.send(response(message.id, toolFailure('invalid_arguments')));
        const scope = await SiloScope.resolve(
          options.pool,
          principal.principalId,
          'read_markdown',
          {
            ...(gatewayId === undefined ? {} : { gatewayId }),
          },
        );
        const value = await withSiloScope(options.pool, scope, async (database) => {
          const found = await database.query<{
            silo_id: number;
            page_start: number | null;
            page_end: number | null;
            character_start: number;
            character_end: number;
            page_character_start: number;
            page_character_end: number;
          }>(
            `SELECT c.silo_id,c.page_start,c.page_end,c.character_start,c.character_end,p.character_start AS page_character_start,p.character_end AS page_character_end FROM noderag.chunk c JOIN noderag.document_page p ON p.document_id=c.document_id AND p.silo_id=c.silo_id AND p.ordinal=$3 WHERE c.id=$1 AND c.document_id=$2 AND c.silo_id=ANY($4::smallint[])`,
            [
              args.data.highlightChunkId,
              args.data.documentId,
              args.data.pageOrdinal,
              scope.siloIds,
            ],
          );
          const row = found.rows[0];
          if (row === undefined) return null;
          const markdown = await readFile(
            options.files.paths(args.data.documentId).markdownAbsolute,
            'utf8',
          );
          const page = markdown.slice(row.page_character_start, row.page_character_end);
          const start =
            Math.max(row.page_character_start, row.character_start) - row.page_character_start;
          const end =
            Math.min(row.page_character_end, row.character_end) - row.page_character_start;
          await writeAuditEvent(database, {
            principalId: principal.principalId,
            ...(gatewayId === undefined ? {} : { gatewayId }),
            siloId: row.silo_id,
            action: 'mcp.get_document_page',
            result: 'ok',
            rowCount: 1,
            requestId: request.id,
            sourceIp: request.ip,
            detail: {
              scope: scope.siloIds,
              documentId: args.data.documentId,
              pageOrdinal: args.data.pageOrdinal,
              outcome: 'ok',
            },
          });
          return {
            documentId: args.data.documentId,
            pageOrdinal: args.data.pageOrdinal,
            context: {
              before: page.slice(0, start),
              match: page.slice(start, end),
              after: page.slice(end),
            },
          };
        });
        return reply.send(
          response(message.id, value === null ? toolFailure('not_found') : toolResult(value)),
        );
      }
      return reply.code(404).send(protocolError(message.id, -32601, 'Unknown tool'));
    } catch (error) {
      request.log.error(
        { error: error instanceof Error ? error.name : 'unknown' },
        'MCP tool failed',
      );
      return reply.send(response(message.id, toolFailure('tool_failed')));
    }
  });
};
