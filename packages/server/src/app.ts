import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  healthResponseSchema,
  readinessResponseSchema,
  type ReadinessResponse,
} from '@noderag/shared';
import { loggerOptions } from './logging.js';
import { registerContentRoutes, type ContentRoutesOptions } from './api/content-routes.js';
import { registerIdentityRoutes, type IdentityRoutesOptions } from './api/identity-routes.js';
import { registerDurabilityRoutes } from './api/durability-routes.js';
import { registerVisionRoutes } from './api/vision-routes.js';
import { registerRetrievalRoutes } from './api/retrieval-routes.js';
import { registerAdminRoutes, type GatewayControl } from './api/admin-routes.js';
import { registerMcpRoutes } from './api/mcp-routes.js';
import { RequestAuthenticationError } from './api/authentication.js';
import { sendProblem } from './api/problem.js';
import { ZodError } from 'zod';
import { captureRegisteredRoutes, assertRouteParity } from './api/route-contract.js';
import { loadAuthorizationInventory } from './api/authorization.js';
import type { ReadinessProbe } from './store/readiness.js';

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const isProblemPayload = (payload: unknown): payload is Record<string, unknown> =>
  typeof payload === 'object' &&
  payload !== null &&
  typeof (payload as Record<string, unknown>)['type'] === 'string' &&
  String((payload as Record<string, unknown>)['type']).startsWith(
    'https://noderag.local/problems/',
  ) &&
  typeof (payload as Record<string, unknown>)['status'] === 'number' &&
  typeof (payload as Record<string, unknown>)['code'] === 'string' &&
  typeof (payload as Record<string, unknown>)['requestId'] === 'string';

const fallbackHtml = `<!doctype html><html><head><meta charset="utf-8"><title>NodeRag</title></head><body><main><h1>NodeRag</h1><p>The thin service is running.</p></main></body></html>`;

export interface BuildAppOptions {
  readonly version?: string;
  readonly logger?: boolean;
  readonly readiness: ReadinessProbe;
  readonly uiRoot: string;
  readonly identity?: IdentityRoutesOptions;
  readonly content?: ContentRoutesOptions;
  readonly gatewayId?: number;
  readonly gatewayControl?: GatewayControl;
  readonly gatewaySurface?: boolean;
  readonly bootstrapPhase?: 'database-initializing' | 'database-unavailable';
  readonly logRoot?: string;
}

const safeUiFile = async (root: string, requestPath: string): Promise<string | null> => {
  const absoluteRoot = resolve(root);
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const candidate = resolve(absoluteRoot, relative);
  if (candidate !== absoluteRoot && !candidate.startsWith(`${absoluteRoot}${sep}`)) return null;
  try {
    return (await stat(candidate)).isFile() ? candidate : null;
  } catch {
    return null;
  }
};

export const buildApp = (options: BuildAppOptions): FastifyInstance => {
  const app = Fastify({
    logger: options.logger === false ? false : loggerOptions,
    genReqId: (request) => request.headers['x-request-id']?.toString() ?? crypto.randomUUID(),
  });
  captureRegisteredRoutes(app);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.addHook('preSerialization', async (request, reply, payload) => {
    if (!isProblemPayload(payload)) return payload;
    reply.type('application/problem+json');
    return {
      ...payload,
      instance: payload['instance'] ?? `urn:noderag:request:${request.id}`,
    };
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RequestAuthenticationError) {
      if (error.retryAfterSeconds !== undefined)
        reply.header('retry-after', String(error.retryAfterSeconds));
      return sendProblem(reply, error.status, error.code, request.id);
    }
    if (error instanceof ZodError) return sendProblem(reply, 400, 'invalid_request', request.id);
    if (error instanceof Error && 'statusCode' in error) {
      const statusCode = error.statusCode;
      if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
        return sendProblem(reply, statusCode, 'request_rejected', request.id);
      }
    }
    request.log.error(
      { errorName: error instanceof Error ? error.name : 'unknown' },
      'request failed',
    );
    return sendProblem(reply, 500, 'internal_error', request.id);
  });
  app.setNotFoundHandler((request, reply) => sendProblem(reply, 404, 'not_found', request.id));

  app.get('/health', async (_request, reply) => {
    const response = healthResponseSchema.parse({
      service: 'noderag',
      status: 'ok',
      version: options.version ?? '1.0.0-rc.1',
    });
    return reply.code(200).send(response);
  });

  app.get('/ready', async (_request, reply) => {
    let response: ReadinessResponse;
    try {
      response = readinessResponseSchema.parse(await options.readiness());
    } catch (error) {
      response = {
        service: 'noderag',
        status: 'unavailable',
        state: 'unavailable',
        migrationHead: null,
        expectedMigrationHead: 'unknown',
        reasons: [`readiness-probe-failed:${error instanceof Error ? error.name : 'unknown'}`],
      };
    }
    return reply.code(response.status === 'ok' ? 200 : 503).send(response);
  });

  if (options.identity === undefined) {
    app.get('/v1/setup/status', async (_request, reply) =>
      reply.code(503).send({
        state: 'unconfigured',
        tokenIssued: false,
        tokenExpiresAt: null,
        step: options.bootstrapPhase ?? 'database-unavailable',
        progress: 0,
      }),
    );
  }

  if (options.identity !== undefined) registerIdentityRoutes(app, options.identity);
  if (options.content !== undefined) {
    registerRetrievalRoutes(app, options.content, options.gatewayId);
    registerMcpRoutes(app, options.content, options.gatewayId);
    if (options.gatewaySurface !== true) {
      registerContentRoutes(app, options.content);
      registerAdminRoutes(app, options.content, options.gatewayControl);
      registerDurabilityRoutes(app, {
        pool: options.content.pool,
        authenticate: options.content.authenticate,
        files: options.content.files,
        sourceRoots: options.content.sourceRoots ?? [],
        ...(options.logRoot === undefined ? {} : { logRoot: options.logRoot }),
      });
      registerVisionRoutes(app, {
        pool: options.content.pool,
        authenticate: options.content.authenticate,
        ...(options.content.visionBearerToken === undefined
          ? {}
          : { runtimeBearerToken: options.content.visionBearerToken }),
        ...(options.content.secretVault === undefined
          ? {}
          : { secretVault: options.content.secretVault }),
      });
    }
  }

  app.get('/*', async (request, reply) => {
    const requestPath = request.url.split('?', 1)[0] ?? '/';
    const file = await safeUiFile(options.uiRoot, requestPath);
    if (file === null) {
      if (requestPath === '/') return reply.type('text/html; charset=utf-8').send(fallbackHtml);
      return sendProblem(reply, 404, 'not_found', request.id);
    }
    const contentType = contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream';
    return reply.type(contentType).send(await readFile(file));
  });

  if (
    options.identity !== undefined &&
    options.content !== undefined &&
    options.gatewaySurface !== true
  ) {
    app.addHook('onReady', async () => assertRouteParity(app, await loadAuthorizationInventory()));
  }

  return app;
};
