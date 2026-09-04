import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  healthResponseSchema,
  readinessResponseSchema,
  type ReadinessResponse,
} from '@noderag/shared';
import { loggerOptions } from './logging.js';
import { registerIdentityRoutes, type IdentityRoutesOptions } from './api/identity-routes.js';
import type { ReadinessProbe } from './store/readiness.js';

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const fallbackHtml = `<!doctype html><html><head><meta charset="utf-8"><title>NodeRag</title></head><body><main><h1>NodeRag</h1><p>The thin service is running.</p></main></body></html>`;

export interface BuildAppOptions {
  readonly version?: string;
  readonly logger?: boolean;
  readonly readiness: ReadinessProbe;
  readonly uiRoot: string;
  readonly identity?: IdentityRoutesOptions;
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

  app.get('/health', async (_request, reply) => {
    const response = healthResponseSchema.parse({
      service: 'noderag',
      status: 'ok',
      version: options.version ?? '0.2.0',
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

  if (options.identity !== undefined) registerIdentityRoutes(app, options.identity);

  app.get('/*', async (request, reply) => {
    const requestPath = request.url.split('?', 1)[0] ?? '/';
    const file = await safeUiFile(options.uiRoot, requestPath);
    if (file === null) {
      if (requestPath === '/') return reply.type('text/html; charset=utf-8').send(fallbackHtml);
      return reply.code(404).send({ code: 'not_found', requestId: request.id });
    }
    const contentType = contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream';
    return reply.type(contentType).send(await readFile(file));
  });

  return app;
};
