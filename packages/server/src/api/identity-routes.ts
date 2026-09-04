import type { FastifyInstance } from 'fastify';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import { authenticatePassword, changePasswordInTransaction } from '../identity/passwords.js';
import { SiloScope } from '../identity/scope.js';
import { createSession, revokeSession } from '../identity/sessions.js';
import { bootstrapFirstAdministrator, setupStatus, verifySetupToken } from '../setup/bootstrap.js';
import { createRequestAuthenticator, type RequestAuthenticator } from './authentication.js';

const loginSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(1).max(1024),
});
const setupTokenSchema = z.object({ setupToken: z.string().min(16).max(200) });
const configureSchema = setupTokenSchema.extend({
  username: z.string().regex(/^[A-Za-z0-9._-]{3,64}$/),
  password: z.string().min(12).max(1024),
  email: z.string().email().optional(),
  defaultSiloName: z.string().min(1).max(120).optional(),
});
const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  nextPassword: z.string().min(12).max(1024),
});

const problem = (status: number, code: string, requestId: string) => ({
  type: `https://noderag.local/problems/${code}`,
  title: code.replaceAll('_', ' '),
  status,
  code,
  requestId,
});

export interface IdentityRoutesOptions {
  readonly pool: Pool;
  readonly expectedOrigin: string;
  readonly secureCookie: boolean;
  readonly authenticate?: RequestAuthenticator;
}

export const registerIdentityRoutes = (
  app: FastifyInstance,
  options: IdentityRoutesOptions,
): void => {
  const principalDetails = async (
    principalId: number,
  ): Promise<{ serverAdmin: boolean; username: string | null } | null> => {
    const result = await options.pool.query<{
      server_admin: boolean | null;
      username: string | null;
    }>(
      `SELECT u.server_admin, u.username FROM noderag.principal p
       LEFT JOIN noderag.app_user u ON u.principal_id = p.id
       WHERE p.id = $1 AND NOT p.disabled AND p.deleted_at IS NULL`,
      [principalId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { serverAdmin: row.server_admin ?? false, username: row.username };
  };

  const authenticate =
    options.authenticate ?? createRequestAuthenticator(options.pool, options.expectedOrigin);

  app.get('/v1/setup/status', async (_request, reply) =>
    reply.code(200).send(await setupStatus(options.pool)),
  );

  app.post('/v1/setup/verify-token', async (request, reply) => {
    const body = setupTokenSchema.parse(request.body);
    return reply.code(200).send({ valid: await verifySetupToken(options.pool, body.setupToken) });
  });

  app.post('/v1/setup/configure', async (request, reply) => {
    const body = configureSchema.parse(request.body);
    const result = await bootstrapFirstAdministrator(options.pool, {
      setupToken: body.setupToken,
      username: body.username,
      password: body.password,
      ...(body.email === undefined ? {} : { email: body.email }),
      ...(body.defaultSiloName === undefined ? {} : { defaultSiloName: body.defaultSiloName }),
    });
    if (process.env['NODERAG_SETUP_TOKEN_FILE'] !== undefined) {
      await rm(process.env['NODERAG_SETUP_TOKEN_FILE'], { force: true });
    }
    return reply.code(201).send(result);
  });

  app.post('/v1/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const status = await setupStatus(options.pool);
    if (status.state !== 'operational') {
      return reply.code(503).send(problem(503, 'service_not_operational', request.id));
    }
    const result = await authenticatePassword(options.pool, {
      ...body,
      sourceIp: request.ip,
      requestId: request.id,
    });
    if (!result.ok) {
      const statusCode =
        result.code === 'temporarily-locked' ? 429 : result.code === 'login-disabled' ? 503 : 401;
      return reply.code(statusCode).send(problem(statusCode, result.code, request.id));
    }
    const session = await createSession(options.pool, {
      principalId: result.principalId,
      ip: request.ip,
      ...(request.headers['user-agent'] === undefined
        ? {}
        : { userAgent: request.headers['user-agent'] }),
    });
    const secure = options.secureCookie ? '; Secure' : '';
    reply.header(
      'set-cookie',
      `noderag_session=${encodeURIComponent(session.token)}; HttpOnly; SameSite=Strict; Path=/${secure}`,
    );
    return reply.code(200).send({
      principalId: result.principalId,
      serverAdmin: result.serverAdmin,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    });
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const principal = await authenticate(request);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    if (
      !principal.csrfAllowed(request.headers['x-csrf-token']?.toString(), request.headers.origin)
    ) {
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    }
    if (principal.sessionToken !== null) await revokeSession(options.pool, principal.sessionToken);
    reply.header('set-cookie', 'noderag_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return reply.code(204).send();
  });

  app.get('/v1/auth/me', async (request, reply) => {
    const principal = await authenticate(request);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    const details = await principalDetails(principal.principalId);
    return reply.code(200).send({
      principalId: principal.principalId,
      username: details?.username ?? null,
      serverAdmin: principal.serverAdmin,
      searchOnly: principal.searchOnly,
    });
  });

  app.patch('/v1/auth/password', async (request, reply) => {
    const principal = await authenticate(request);
    if (principal === null || principal.sessionToken === null) {
      return reply.code(401).send(problem(401, 'session_required', request.id));
    }
    if (
      !principal.csrfAllowed(request.headers['x-csrf-token']?.toString(), request.headers.origin)
    ) {
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    }
    if ((await setupStatus(options.pool)).state !== 'operational') {
      return reply.code(503).send(problem(503, 'mutation_not_ready', request.id));
    }
    const body = passwordSchema.parse(request.body);
    const idempotencyKey = request.headers['idempotency-key']?.toString();
    if (idempotencyKey === undefined) {
      return reply.code(400).send(problem(400, 'idempotency_key_required', request.id));
    }
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: 'change-password',
          key: idempotencyKey,
          request: JSON.stringify(body),
        },
        async (database) => {
          await changePasswordInTransaction(
            database,
            principal.principalId,
            body.currentPassword,
            body.nextPassword,
          );
          return { status: 204, headers: {}, body: null };
        },
      );
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      }
      if (error instanceof Error && error.message === 'Invalid Idempotency-Key.') {
        return reply.code(400).send(problem(400, 'invalid_idempotency_key', request.id));
      }
      throw error;
    }
  });

  app.get('/v1/silos', async (request, reply) => {
    const principal = await authenticate(request);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'list_silos');
    if (scope.siloIds.length === 0) return reply.code(200).send({ items: [] });
    const silos = await options.pool.query<{ id: number; slug: string; display_name: string }>(
      `SELECT id, slug, display_name FROM noderag.silo
       WHERE id = ANY ($1::smallint[]) ORDER BY display_name, id`,
      [scope.siloIds],
    );
    return reply.code(200).send({
      items: silos.rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        displayName: row.display_name,
      })),
    });
  });

  app.get('/v1/openapi.json', async (request, reply) => {
    const principal = await authenticate(request);
    if (principal === null)
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    const path = resolve(process.env['NODERAG_OPENAPI'] ?? 'platform/openapi.m05.json');
    return reply
      .type('application/json')
      .code(200)
      .send(await readFile(path, 'utf8'));
  });
};
