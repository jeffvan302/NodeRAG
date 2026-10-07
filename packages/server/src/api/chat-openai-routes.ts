import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { writeAuditEvent } from '../application/audit.js';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import { CodexAppServerError } from '../chat/codex-app-server.js';
import type {
  OpenAiCatalogModel,
  OpenAiLoginChallenge,
  OpenAiOAuthManager,
} from '../chat/openai-oauth.js';
import { databaseInteger, type SqlClient } from '../store/database.js';
import type { AuthenticatedPrincipal, RequestAuthenticator } from './authentication.js';
import { sendProblem } from './problem.js';

const emptyBodySchema = z.object({}).strict();
const disconnectSchema = z.object({ confirmation: z.literal('DISCONNECT') }).strict();
const updateSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    generationModel: z.string().trim().min(1).max(180).nullable().optional(),
    maxParallelCalls: z.number().int().min(1).max(32).optional(),
    requestsPerMinute: z.number().int().min(1).max(60_000).nullable().optional(),
    tokensPerMinute: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  })
  .strict();

class OpenAiRouteError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 503,
    readonly code: string,
  ) {
    super(code);
    this.name = 'OpenAiRouteError';
  }
}

export interface ChatOpenAiRoutesOptions {
  readonly pool: Pool;
  readonly authenticate: RequestAuthenticator;
  readonly enabled: boolean;
  readonly manager?: OpenAiOAuthRouteManager;
}

export interface OpenAiOAuthRouteManager {
  status(refreshToken?: boolean): ReturnType<OpenAiOAuthManager['status']>;
  startLogin(principalId: number): Promise<OpenAiLoginChallenge>;
  cancelLogin(principalId: number): Promise<OpenAiLoginChallenge | null>;
  refreshModels(principalId: number): Promise<readonly OpenAiCatalogModel[]>;
  testConnection(principalId: number): ReturnType<OpenAiOAuthManager['testConnection']>;
  disconnect(principalId: number): Promise<void>;
}

const requireAdmin = async (
  request: FastifyRequest,
  reply: FastifyReply,
  options: ChatOpenAiRoutesOptions,
  mutation: boolean,
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
  if (!principal.serverAdmin) {
    sendProblem(reply, 403, 'server_admin_required', request.id);
    return null;
  }
  if (!options.enabled) {
    sendProblem(reply, 404, 'not_found', request.id);
    return null;
  }
  if (
    mutation &&
    !principal.csrfAllowed(request.headers['x-csrf-token']?.toString(), request.headers.origin)
  ) {
    sendProblem(reply, 403, 'csrf_rejected', request.id);
    return null;
  }
  return principal;
};

const manager = (options: ChatOpenAiRoutesOptions): OpenAiOAuthRouteManager => {
  if (options.manager === undefined) throw new OpenAiRouteError(503, 'openai_oauth_unavailable');
  return options.manager;
};

const idempotencyKey = (request: FastifyRequest): string => {
  const key = request.headers['idempotency-key']?.toString();
  if (key === undefined) throw new OpenAiRouteError(400, 'idempotency_key_required');
  return key;
};

const routeFailure = (reply: FastifyReply, request: FastifyRequest, error: unknown) => {
  if (error instanceof OpenAiRouteError) {
    return sendProblem(reply, error.status, error.code, request.id);
  }
  if (error instanceof IdempotencyConflictError) {
    return sendProblem(reply, 409, 'idempotency_conflict', request.id);
  }
  if (error instanceof Error && error.message === 'Invalid Idempotency-Key.') {
    return sendProblem(reply, 400, 'invalid_idempotency_key', request.id);
  }
  if (error instanceof CodexAppServerError) {
    const status = error.code.includes('owned_by_another')
      ? 409
      : error.code.includes('unavailable') ||
          error.code.includes('process_') ||
          error.code.includes('transport_') ||
          error.code.includes('timeout')
        ? 503
        : 422;
    return sendProblem(reply, status, error.code, request.id);
  }
  if (error instanceof z.ZodError)
    return sendProblem(reply, 503, 'openai_protocol_invalid', request.id);
  throw error;
};

const runIdempotent = async (
  request: FastifyRequest,
  options: ChatOpenAiRoutesOptions,
  principal: AuthenticatedPrincipal,
  operation: string,
  requestDigest: string,
  action: string,
  execute: () => Promise<unknown>,
) =>
  executeIdempotent(
    options.pool,
    {
      principalId: principal.principalId,
      operation,
      key: idempotencyKey(request),
      request: requestDigest,
    },
    async (database) => {
      try {
        const body = await execute();
        await writeAuditEvent(database, {
          principalId: principal.principalId,
          action,
          result: 'ok',
          requestId: request.id,
        });
        return { status: 200, headers: {}, body };
      } catch (error) {
        await writeAuditEvent(database, {
          principalId: principal.principalId,
          action,
          result: 'error',
          requestId: request.id,
          detail: {
            errorCode:
              error instanceof CodexAppServerError ? error.code : 'openai_oauth_operation_failed',
          },
        });
        throw error;
      }
    },
  );

const openAiConnection = async (database: SqlClient, lock: boolean) => {
  const result = await database.query<{
    id: unknown;
    enabled: boolean;
    credential_secret_id: unknown | null;
    generation_model: string | null;
  }>(
    `SELECT id, enabled, credential_secret_id, generation_model
     FROM noderag.chat_provider_connection
     WHERE provider_kind='openai_oauth'
     ${lock ? 'FOR UPDATE' : ''}`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new OpenAiRouteError(503, 'openai_oauth_unavailable');
  return row;
};

export const registerChatOpenAiRoutes = (
  app: FastifyInstance,
  options: ChatOpenAiRoutesOptions,
): void => {
  app.get('/v1/admin/chat/providers/openai-oauth/status', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, false);
    if (principal === null) return;
    try {
      return reply.send(await manager(options).status(false));
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  app.put('/v1/admin/chat/providers/openai-oauth', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, true);
    if (principal === null) return;
    const body = updateSchema.safeParse(request.body);
    if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: 'chat-openai-oauth-update',
          key: idempotencyKey(request),
          request: JSON.stringify(body.data),
        },
        async (database) => {
          const connection = await openAiConnection(database, true);
          const model = body.data.generationModel ?? connection.generation_model;
          const enabled = body.data.enabled ?? connection.enabled;
          if (enabled && connection.credential_secret_id === null) {
            throw new OpenAiRouteError(422, 'openai_oauth_required');
          }
          if (enabled && model === null) {
            throw new OpenAiRouteError(422, 'openai_model_required');
          }
          if (model !== null) {
            const available = await database.query(
              `SELECT 1 FROM noderag.chat_model_profile
               WHERE connection_id=$1 AND model=$2`,
              [databaseInteger(connection.id, 'OpenAI connection id'), model],
            );
            if (available.rowCount !== 1) {
              throw new OpenAiRouteError(422, 'openai_model_not_available');
            }
          }
          const enabledChanged = enabled !== connection.enabled;
          const modelChanged = model !== connection.generation_model;
          await database.query(
            `UPDATE noderag.chat_provider_connection
             SET label=COALESCE($2,label), enabled=$3, generation_model=$4,
                 max_parallel_calls=COALESCE($5,max_parallel_calls),
                 requests_per_minute=CASE WHEN $6::boolean THEN $7 ELSE requests_per_minute END,
                 tokens_per_minute=CASE WHEN $8::boolean THEN $9 ELSE tokens_per_minute END,
                 updated_at=now(), updated_by=$10
             WHERE id=$1`,
            [
              databaseInteger(connection.id, 'OpenAI connection id'),
              body.data.label ?? null,
              enabled,
              model,
              body.data.maxParallelCalls ?? null,
              body.data.requestsPerMinute !== undefined,
              body.data.requestsPerMinute ?? null,
              body.data.tokensPerMinute !== undefined,
              body.data.tokensPerMinute ?? null,
              principal.principalId,
            ],
          );
          if (enabledChanged) {
            await database.query(
              `UPDATE noderag.chat_provider_capability
               SET status=$2, latency_ms=NULL, safe_error_code=NULL,
                   metadata='{}'::jsonb, tested_at=NULL, updated_at=now()
               WHERE connection_id=$1`,
              [
                databaseInteger(connection.id, 'OpenAI connection id'),
                enabled ? 'untested' : 'disabled',
              ],
            );
          } else if (enabled && modelChanged) {
            await database.query(
              `UPDATE noderag.chat_provider_capability
               SET status='untested', latency_ms=NULL, safe_error_code=NULL,
                   metadata='{}'::jsonb, tested_at=NULL, updated_at=now()
               WHERE connection_id=$1 AND capability='generation'`,
              [databaseInteger(connection.id, 'OpenAI connection id')],
            );
          }
          await writeAuditEvent(database, {
            principalId: principal.principalId,
            action: 'chat.provider.openai_oauth.updated',
            result: 'ok',
            requestId: request.id,
            detail: { enabled, model },
          });
          return { status: 200, headers: {}, body: { ok: true, enabled, generationModel: model } };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });

  const registerEmptyMutation = (
    path: string,
    operation: string,
    action: string,
    execute: (provider: OpenAiOAuthRouteManager, principalId: number) => Promise<unknown>,
  ): void => {
    app.post(path, async (request, reply) => {
      const principal = await requireAdmin(request, reply, options, true);
      if (principal === null) return;
      const body = emptyBodySchema.safeParse(request.body ?? {});
      if (!body.success) return sendProblem(reply, 400, 'invalid_request', request.id);
      try {
        const result = await runIdempotent(
          request,
          options,
          principal,
          operation,
          '{}',
          action,
          () => execute(manager(options), principal.principalId),
        );
        return reply.code(result.response.status).send(result.response.body);
      } catch (error) {
        return routeFailure(reply, request, error);
      }
    });
  };

  registerEmptyMutation(
    '/v1/admin/chat/providers/openai-oauth/login',
    'chat-openai-oauth-login',
    'chat.provider.openai_oauth.login.started',
    (provider, principalId) => provider.startLogin(principalId),
  );
  registerEmptyMutation(
    '/v1/admin/chat/providers/openai-oauth/login/cancel',
    'chat-openai-oauth-login-cancel',
    'chat.provider.openai_oauth.login.cancelled',
    (provider, principalId) => provider.cancelLogin(principalId),
  );
  registerEmptyMutation(
    '/v1/admin/chat/providers/openai-oauth/refresh-models',
    'chat-openai-oauth-refresh-models',
    'chat.provider.openai_oauth.model_catalog.refreshed',
    async (provider, principalId) => {
      const models = await provider.refreshModels(principalId);
      return { ok: true, modelCount: models.length, models };
    },
  );
  registerEmptyMutation(
    '/v1/admin/chat/providers/openai-oauth/test',
    'chat-openai-oauth-test',
    'chat.provider.openai_oauth.tested',
    async (provider, principalId) => ({
      ok: true,
      ...(await provider.testConnection(principalId)),
    }),
  );

  app.post('/v1/admin/chat/providers/openai-oauth/disconnect', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options, true);
    if (principal === null) return;
    const body = disconnectSchema.safeParse(request.body);
    if (!body.success)
      return sendProblem(reply, 400, 'openai_disconnect_confirmation_required', request.id);
    try {
      const result = await runIdempotent(
        request,
        options,
        principal,
        'chat-openai-oauth-disconnect',
        JSON.stringify(body.data),
        'chat.provider.openai_oauth.disconnected',
        async () => {
          await manager(options).disconnect(principal.principalId);
          return { ok: true, disconnected: true };
        },
      );
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return routeFailure(reply, request, error);
    }
  });
};
