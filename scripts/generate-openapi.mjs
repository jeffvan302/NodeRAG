import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';

const root = resolve(import.meta.dirname, '..');
const inventoryPath = resolve(root, 'platform/route-authorization.v1.json');
const outputPath = resolve(root, 'platform/openapi.m14.json');
const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));

const pathParameters = (path) =>
  [...path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
const openapiPath = (path) => path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');
const operationId = (method, path) =>
  `${method.toLowerCase()}_${path.replace(/^\//, '').replace(/[:/{}-]+/g, '_')}`;

const paths = {};
for (const route of inventory.routes) {
  const path = openapiPath(route.path);
  const method = route.method.toLowerCase();
  const operation = {
    operationId: operationId(route.method, route.path),
    tags: [
      route.path.startsWith('/v1/admin/')
        ? 'administration'
        : route.path === '/mcp'
          ? 'mcp'
          : (route.path.split('/').filter(Boolean)[1] ?? 'service'),
    ],
    'x-noderag-authorization': {
      scope: route.scope,
      ...(route.action === undefined ? {} : { action: route.action }),
      searchOnlyAllowed: route.searchOnlyAllowed,
      routeClass: route.routeClass,
      csrfBrowser: route.csrfBrowser,
      idempotency: route.idempotency,
    },
    ...(route.scope === 'public'
      ? { security: [] }
      : route.scope === 'server_admin'
        ? { security: [{ sessionCookie: [] }] }
        : { security: [{ bearerAuth: [] }, { sessionCookie: [] }] }),
    ...(pathParameters(route.path).length === 0 ? {} : { parameters: pathParameters(route.path) }),
    ...(route.method === 'GET'
      ? {}
      : {
          requestBody: {
            required: route.path !== '/v1/admin/backups',
            content: {
              'application/json': {
                schema:
                  route.path === '/v1/search'
                    ? { $ref: '#/components/schemas/SearchRequest' }
                    : route.path === '/v1/admin/evaluation'
                      ? { $ref: '#/components/schemas/EvaluationAdminRequest' }
                      : route.path === '/mcp'
                        ? { $ref: '#/components/schemas/JsonRpcRequest' }
                        : { type: 'object', additionalProperties: true },
              },
            },
          },
        }),
    responses: {
      200: {
        description: 'Successful response',
        content: {
          'application/json': {
            schema:
              route.path === '/v1/search'
                ? { $ref: '#/components/schemas/SearchResponse' }
                : { type: ['object', 'array', 'null'] },
          },
        },
      },
      ...(route.method === 'GET'
        ? {}
        : {
            201: {
              description: 'Resource created',
              content: {
                'application/json': { schema: { type: ['object', 'array', 'null'] } },
              },
            },
            202: {
              description: 'Operation accepted',
              content: {
                'application/json': { schema: { type: ['object', 'array', 'null'] } },
              },
            },
            204: { description: 'Operation completed without a response body' },
          }),
      400: { $ref: '#/components/responses/Problem' },
      401: { $ref: '#/components/responses/Problem' },
      403: { $ref: '#/components/responses/Problem' },
      404: { $ref: '#/components/responses/Problem' },
      409: { $ref: '#/components/responses/Problem' },
      413: { $ref: '#/components/responses/Problem' },
      415: { $ref: '#/components/responses/Problem' },
      422: { $ref: '#/components/responses/Problem' },
      429: { $ref: '#/components/responses/RateLimited' },
      500: { $ref: '#/components/responses/Problem' },
      503: { $ref: '#/components/responses/Problem' },
    },
  };
  paths[path] ??= {};
  paths[path][method] = operation;
}

const document = {
  openapi: '3.1.1',
  info: {
    title: 'NodeRag API',
    version: '1.0.0-rc.1',
    description:
      'M14 release-candidate contract for encrypted backup, staged restore, upgrade recovery, security hardening, reproducible evaluation, production package lifecycle, and scoped retrieval and ingestion operations.',
  },
  servers: [{ url: '/', description: 'Control or narrowed gateway listener' }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'nrag API key' },
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'noderag_session' },
    },
    schemas: {
      Problem: {
        type: 'object',
        required: ['type', 'title', 'status', 'instance', 'code', 'requestId'],
        properties: {
          type: { type: 'string', format: 'uri-reference' },
          title: { type: 'string' },
          status: { type: 'integer', minimum: 400, maximum: 599 },
          detail: { type: 'string' },
          instance: { type: 'string', format: 'uri-reference' },
          code: { type: 'string' },
          requestId: { type: 'string' },
        },
        additionalProperties: false,
      },
      SearchRequest: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 4000 },
          mode: { type: 'string', enum: ['vector', 'keyword', 'hybrid'], default: 'vector' },
          silos: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: { type: 'integer', minimum: 1, maximum: 32767 },
          },
          siloIds: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: { type: 'integer', minimum: 1, maximum: 32767 },
            deprecated: true,
          },
          filters: { $ref: '#/components/schemas/SearchFilters' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          cursor: { type: 'string', maxLength: 2048 },
          rerank: { const: false },
        },
        additionalProperties: false,
      },
      SearchFilters: {
        type: 'object',
        properties: {
          sourceIds: { type: 'array', maxItems: 64, items: { type: 'integer', minimum: 1 } },
          pathPrefix: { type: 'string', maxLength: 1024 },
          formats: {
            type: 'array',
            maxItems: 5,
            items: { enum: ['pdf', 'docx', 'xlsx', 'txt', 'md'] },
          },
          createdFrom: { type: 'string', format: 'date-time' },
          createdTo: { type: 'string', format: 'date-time' },
          modifiedFrom: { type: 'string', format: 'date-time' },
          modifiedTo: { type: 'string', format: 'date-time' },
          pageFrom: { type: 'integer', minimum: 0 },
          pageTo: { type: 'integer', minimum: 0 },
          hasImages: { type: 'boolean' },
          hasTables: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      SearchResponse: {
        type: 'object',
        required: ['items', 'mode', 'elapsedMs', 'nextCursor'],
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/SearchHit' } },
          mode: { enum: ['vector', 'keyword', 'hybrid'] },
          elapsedMs: { type: 'number', minimum: 0 },
          nextCursor: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
      SearchHit: {
        type: 'object',
        required: [
          'chunkId',
          'chunkIds',
          'siloId',
          'silo',
          'documentId',
          'text',
          'score',
          'locator',
          'document',
        ],
        properties: {
          chunkId: { type: 'integer' },
          chunkIds: { type: 'array', items: { type: 'integer' } },
          siloId: { type: 'integer' },
          silo: { type: 'string' },
          documentId: { type: 'integer' },
          text: { type: 'string' },
          score: { type: 'number' },
          locator: {
            type: 'object',
            description:
              'Character offsets are UTF-16 code units; byte offsets are UTF-8 bytes. Clients normally use the returned text/context and do not slice.',
          },
          document: { type: 'object' },
        },
      },
      EvaluationAdminRequest: {
        oneOf: [
          {
            type: 'object',
            required: ['action', 'externalId', 'siloId', 'query', 'relevant'],
            properties: {
              action: { const: 'add_case' },
              externalId: { type: 'string', minLength: 1, maxLength: 120 },
              siloId: { type: 'integer', minimum: 1, maximum: 32767 },
              query: { type: 'string', minLength: 1, maxLength: 4000 },
              queryClass: {
                enum: [
                  'semantic',
                  'exact_identifier',
                  'exact_name',
                  'error_code',
                  'quoted_phrase',
                  'cross_page',
                  'table',
                  'vision',
                  'multilingual',
                  'unicode',
                ],
              },
              expectedFormat: { enum: ['pdf', 'docx', 'xlsx', 'txt', 'md'] },
              answerable: { type: 'boolean', default: true },
              relevant: { type: 'array', minItems: 1, items: { type: 'object' } },
              notes: { type: 'string', maxLength: 4000 },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['action'],
            properties: {
              action: { const: 'queue_run' },
              modes: {
                type: 'array',
                minItems: 1,
                maxItems: 3,
                uniqueItems: true,
                items: { enum: ['vector', 'keyword', 'hybrid'] },
              },
              workload: { enum: ['idle', 'ingest'], default: 'idle' },
              environment: { type: 'object' },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['action', 'caseId', 'state'],
            properties: {
              action: { const: 'set_case_state' },
              caseId: { type: 'integer', minimum: 1 },
              state: { enum: ['draft', 'approved', 'rejected'] },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['action', 'runId'],
            properties: {
              action: { const: 'accept_baseline' },
              runId: { type: 'integer', minimum: 1 },
            },
            additionalProperties: false,
          },
        ],
      },
      JsonRpcRequest: {
        type: 'object',
        required: ['jsonrpc', 'method'],
        properties: {
          jsonrpc: { const: '2.0' },
          id: { type: ['string', 'number', 'null'] },
          method: { type: 'string' },
          params: { type: 'object' },
        },
        additionalProperties: false,
      },
    },
    responses: {
      Problem: {
        description: 'RFC 9457 problem detail',
        content: {
          'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
        },
      },
      RateLimited: {
        description: 'Rate limit exceeded; Retry-After is present.',
        headers: { 'Retry-After': { schema: { type: 'integer', minimum: 1 } } },
        content: {
          'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
        },
      },
    },
  },
};

const rendered = await format(JSON.stringify(document), {
  ...(await resolveConfig(outputPath)),
  parser: 'json',
});
if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch(() => '');
  if (current !== rendered) {
    console.error('platform/openapi.m14.json is out of date; run pnpm openapi:generate');
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, rendered, 'utf8');
}
