import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import { writeAuditEvent } from '../application/audit.js';
import { ChatArtifactError, ChatArtifactService } from '../chat/artifacts.js';
import type { RequestAuthenticator } from './authentication.js';
import { sendProblem } from './problem.js';

const chatIdSchema = z.string().uuid();
const artifactIdSchema = z.string().uuid();
const pathSchema = z.string().min(1).max(1024);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export interface ChatArtifactRoutesOptions {
  readonly pool: Pool;
  readonly authenticate: RequestAuthenticator;
  readonly enabled: boolean;
}

class ChatArtifactRouteError extends Error {
  constructor(
    readonly status: 400,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ChatArtifactRouteError';
  }
}

const requireUser = async (
  request: FastifyRequest,
  reply: FastifyReply,
  options: ChatArtifactRoutesOptions,
  mutation: boolean,
) => {
  const principal = await options.authenticate(request);
  if (principal === null) {
    sendProblem(reply, 401, 'authentication_required', request.id);
    return null;
  }
  if (!options.enabled || principal.searchOnly || principal.sessionToken === null) {
    sendProblem(reply, 404, 'not_found', request.id);
    return null;
  }
  const entitlement = await options.pool.query<{ enabled: boolean }>(
    `SELECT enabled FROM noderag.chat_entitlement WHERE principal_id=$1`,
    [principal.principalId],
  );
  if (entitlement.rows[0]?.enabled !== true) {
    sendProblem(reply, 403, 'chat_access_disabled', request.id);
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

const idempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers['idempotency-key']?.toString();
  if (value === undefined) throw new ChatArtifactRouteError(400, 'idempotency_key_required');
  return value;
};

const failure = (reply: FastifyReply, request: FastifyRequest, error: unknown) => {
  if (error instanceof ChatArtifactRouteError) {
    return sendProblem(reply, error.status, error.code, request.id);
  }
  if (error instanceof ChatArtifactError) {
    return sendProblem(reply, error.status, error.code, request.id);
  }
  if (error instanceof IdempotencyConflictError) {
    return sendProblem(reply, 409, 'idempotency_conflict', request.id);
  }
  if (error instanceof Error && error.message === 'Invalid Idempotency-Key.') {
    return sendProblem(reply, 400, 'invalid_idempotency_key', request.id);
  }
  throw error;
};

const provenance = (principalId: number) => ({
  createdByKind: 'user' as const,
  principalId,
});

export const registerChatArtifactRoutes = (
  app: FastifyInstance,
  options: ChatArtifactRoutesOptions,
): void => {
  const service = new ChatArtifactService(options.pool);

  app.get('/v1/chats/:chatId/artifacts', async (request, reply) => {
    const principal = await requireUser(request, reply, options, false);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    const query = z
      .object({ directory: z.string().max(1024).default('') })
      .safeParse(request.query);
    if (!params.success || !query.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      return reply.send(
        await service.list({
          conversationId: params.data.chatId,
          principalId: principal.principalId,
          directory: query.data.directory,
        }),
      );
    } catch (error) {
      return failure(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/artifacts/directories', async (request, reply) => {
    const principal = await requireUser(request, reply, options, true);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    const body = z.object({ path: pathSchema }).strict().safeParse(request.body);
    if (!params.success || !body.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-artifact-mkdir:${params.data.chatId}`,
          key: idempotencyKey(request),
          request: JSON.stringify(body.data),
        },
        async (database) => {
          void database;
          const responseBody = await service.mkdir(
            {
              conversationId: params.data.chatId,
              principalId: principal.principalId,
              path: body.data.path,
            },
            provenance(principal.principalId),
          );
          return { status: 201, headers: {}, body: responseBody };
        },
      );
      await writeAuditEvent(options.pool, {
        principalId: principal.principalId,
        action: 'chat.artifact.directory_created',
        result: 'ok',
        requestId: request.id,
        detail: { path: body.data.path },
      });
      return reply.code(result.replayed ? 200 : result.response.status).send(result.response.body);
    } catch (error) {
      return failure(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/artifacts', async (request, reply) => {
    const principal = await requireUser(request, reply, options, true);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    const body = z
      .object({ path: pathSchema, content: z.string().max(10_485_760) })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-artifact-create:${params.data.chatId}`,
          key: idempotencyKey(request),
          request: JSON.stringify(body.data),
        },
        async (database) => {
          void database;
          const responseBody = await service.create(
            {
              ...body.data,
              conversationId: params.data.chatId,
              principalId: principal.principalId,
            },
            provenance(principal.principalId),
          );
          return { status: 201, headers: {}, body: responseBody };
        },
      );
      const created = result.response.body as { artifact: { id: string; path: string } };
      await writeAuditEvent(options.pool, {
        principalId: principal.principalId,
        action: 'chat.artifact.created',
        result: 'ok',
        requestId: request.id,
        detail: { artifactId: created.artifact.id, path: created.artifact.path },
      });
      return reply.code(result.replayed ? 200 : result.response.status).send(result.response.body);
    } catch (error) {
      return failure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/artifacts/:artifactId/content', async (request, reply) => {
    const principal = await requireUser(request, reply, options, false);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, artifactId: artifactIdSchema })
      .safeParse(request.params);
    const query = z
      .object({
        revision: z.coerce.number().int().min(1).optional(),
        offset: z.coerce.number().int().nonnegative().default(0),
        limit: z.coerce.number().int().min(1).max(64_000).default(64_000),
      })
      .safeParse(request.query);
    if (!params.success || !query.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      return reply.send(
        await service.read({
          conversationId: params.data.chatId,
          principalId: principal.principalId,
          artifactId: params.data.artifactId,
          offset: query.data.offset,
          limit: query.data.limit,
          ...(query.data.revision === undefined ? {} : { revision: query.data.revision }),
        }),
      );
    } catch (error) {
      return failure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/artifacts/:artifactId/history', async (request, reply) => {
    const principal = await requireUser(request, reply, options, false);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, artifactId: artifactIdSchema })
      .safeParse(request.params);
    if (!params.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      return reply.send({
        items: await service.history({
          conversationId: params.data.chatId,
          principalId: principal.principalId,
          artifactId: params.data.artifactId,
        }),
      });
    } catch (error) {
      return failure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/artifacts/:artifactId/download', async (request, reply) => {
    const principal = await requireUser(request, reply, options, false);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, artifactId: artifactIdSchema })
      .safeParse(request.params);
    const query = z
      .object({ revision: z.coerce.number().int().min(1).optional() })
      .safeParse(request.query);
    if (!params.success || !query.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await service.download({
        conversationId: params.data.chatId,
        principalId: principal.principalId,
        artifactId: params.data.artifactId,
        ...(query.data.revision === undefined ? {} : { revision: query.data.revision }),
      });
      const filename = result.artifact.name.replaceAll('"', '');
      return reply
        .header('content-type', 'text/markdown; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('x-content-type-options', 'nosniff')
        .send(result.content);
    } catch (error) {
      return failure(reply, request, error);
    }
  });

  app.patch('/v1/chats/:chatId/artifacts/:artifactId/content', async (request, reply) => {
    const principal = await requireUser(request, reply, options, true);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, artifactId: artifactIdSchema })
      .safeParse(request.params);
    const body = z
      .object({
        expectedSha256: sha256Schema,
        patches: z
          .array(
            z
              .object({
                startLine: z.number().int().min(1),
                deleteCount: z.number().int().min(0).max(10_000),
                expectedLines: z.array(z.string().max(20_000)).max(10_000),
                replacementLines: z.array(z.string().max(20_000)).max(10_000),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-artifact-patch:${params.data.chatId}:${params.data.artifactId}`,
          key: idempotencyKey(request),
          request: JSON.stringify(body.data),
        },
        async (database) => {
          void database;
          const responseBody = await service.patch(
            {
              ...body.data,
              conversationId: params.data.chatId,
              principalId: principal.principalId,
              artifactId: params.data.artifactId,
            },
            provenance(principal.principalId),
          );
          return { status: 200, headers: {}, body: responseBody };
        },
      );
      const patched = result.response.body as { artifact: { id: string; path: string } };
      await writeAuditEvent(options.pool, {
        principalId: principal.principalId,
        action: 'chat.artifact.revised',
        result: 'ok',
        requestId: request.id,
        detail: { artifactId: patched.artifact.id, path: patched.artifact.path },
      });
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return failure(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/artifacts/:artifactId/rename', async (request, reply) => {
    const principal = await requireUser(request, reply, options, true);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, artifactId: artifactIdSchema })
      .safeParse(request.params);
    const body = z.object({ destination: pathSchema }).strict().safeParse(request.body);
    if (!params.success || !body.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-artifact-rename:${params.data.chatId}:${params.data.artifactId}`,
          key: idempotencyKey(request),
          request: JSON.stringify(body.data),
        },
        async (database) => {
          void database;
          const responseBody = await service.rename({
            ...body.data,
            conversationId: params.data.chatId,
            principalId: principal.principalId,
            artifactId: params.data.artifactId,
          });
          return { status: 200, headers: {}, body: responseBody };
        },
      );
      const renamed = result.response.body as { id: string; path: string };
      await writeAuditEvent(options.pool, {
        principalId: principal.principalId,
        action: 'chat.artifact.renamed',
        result: 'ok',
        requestId: request.id,
        detail: { artifactId: renamed.id, path: renamed.path },
      });
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return failure(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/artifacts/:artifactId/copy', async (request, reply) => {
    const principal = await requireUser(request, reply, options, true);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, artifactId: artifactIdSchema })
      .safeParse(request.params);
    const body = z.object({ destination: pathSchema }).strict().safeParse(request.body);
    if (!params.success || !body.success)
      return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-artifact-copy:${params.data.chatId}:${params.data.artifactId}`,
          key: idempotencyKey(request),
          request: JSON.stringify(body.data),
        },
        async (database) => {
          void database;
          const responseBody = await service.copy(
            {
              ...body.data,
              conversationId: params.data.chatId,
              principalId: principal.principalId,
              artifactId: params.data.artifactId,
            },
            provenance(principal.principalId),
          );
          return { status: 201, headers: {}, body: responseBody };
        },
      );
      const copied = result.response.body as { artifact: { id: string; path: string } };
      await writeAuditEvent(options.pool, {
        principalId: principal.principalId,
        action: 'chat.artifact.copied',
        result: 'ok',
        requestId: request.id,
        detail: { artifactId: copied.artifact.id, path: copied.artifact.path },
      });
      return reply.code(result.replayed ? 200 : result.response.status).send(result.response.body);
    } catch (error) {
      return failure(reply, request, error);
    }
  });

  app.delete('/v1/chats/:chatId/artifacts/:artifactId', async (request, reply) => {
    const principal = await requireUser(request, reply, options, true);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, artifactId: artifactIdSchema })
      .safeParse(request.params);
    const body = z
      .object({ confirmation: z.literal('DELETE') })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success) {
      return sendProblem(reply, 400, 'chat_artifact_delete_confirmation_required', request.id);
    }
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-artifact-delete:${params.data.chatId}:${params.data.artifactId}`,
          key: idempotencyKey(request),
          request: 'DELETE',
        },
        async (database) => {
          void database;
          const responseBody = await service.delete({
            conversationId: params.data.chatId,
            principalId: principal.principalId,
            artifactId: params.data.artifactId,
          });
          return { status: 200, headers: {}, body: responseBody };
        },
      );
      await writeAuditEvent(options.pool, {
        principalId: principal.principalId,
        action: 'chat.artifact.deleted',
        result: 'ok',
        requestId: request.id,
        detail: { artifactId: params.data.artifactId },
      });
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return failure(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/artifacts-reconciliation', async (request, reply) => {
    const principal = await requireUser(request, reply, options, false);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    if (!params.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      return reply.send(
        await service.inventory({
          conversationId: params.data.chatId,
          principalId: principal.principalId,
        }),
      );
    } catch (error) {
      return failure(reply, request, error);
    }
  });
};
