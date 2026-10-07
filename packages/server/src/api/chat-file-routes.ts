import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import { writeAuditEvent } from '../application/audit.js';
import { ChatArtifactError } from '../chat/artifacts.js';
import { ChatFileError, ChatFileService } from '../chat/chat-files.js';
import type { RequestAuthenticator } from './authentication.js';
import { sendProblem } from './problem.js';

const chatIdSchema = z.string().uuid();
const fileIdSchema = z.string().uuid();
const fileNameSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/u,
  );
const maximumSupportedFileBytes = 100 * 1024 * 1024;

export interface ChatFileRoutesOptions {
  readonly pool: Pool;
  readonly authenticate: RequestAuthenticator;
  readonly enabled: boolean;
}

const requireUser = async (
  request: FastifyRequest,
  reply: FastifyReply,
  options: ChatFileRoutesOptions,
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
  if (value === undefined) throw new Error('Idempotency-Key is required.');
  return value;
};

const failure = (reply: FastifyReply, request: FastifyRequest, error: unknown) => {
  if (error instanceof ChatFileError || error instanceof ChatArtifactError) {
    return sendProblem(reply, error.status, error.code, request.id);
  }
  if (error instanceof IdempotencyConflictError) {
    return sendProblem(reply, 409, 'idempotency_conflict', request.id);
  }
  if (error instanceof Error && error.message === 'Invalid Idempotency-Key.') {
    return sendProblem(reply, 400, 'invalid_idempotency_key', request.id);
  }
  if (error instanceof Error && error.message === 'Idempotency-Key is required.') {
    return sendProblem(reply, 400, 'idempotency_key_required', request.id);
  }
  throw error;
};

const readBoundedUpload = async (source: AsyncIterable<unknown>): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of source) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes += chunk.byteLength;
    if (bytes > maximumSupportedFileBytes) {
      throw new ChatFileError('chat_file_too_large', 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
};

const inlineFilename = (filename: string): string => {
  const fallback = filename
    .replace(/[^a-z0-9._ -]/giu, '_')
    .replaceAll('"', '')
    .slice(0, 180);
  return `inline; filename="${fallback || 'chat-file'}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

export const registerChatFileRoutes = (
  app: FastifyInstance,
  options: ChatFileRoutesOptions,
): void => {
  const service = new ChatFileService(options.pool);

  app.get('/v1/chats/:chatId/files', async (request, reply) => {
    const principal = await requireUser(request, reply, options, false);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    if (!params.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      return reply.send(
        await service.list({
          conversationId: params.data.chatId,
          principalId: principal.principalId,
        }),
      );
    } catch (error) {
      return failure(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/files', async (request, reply) => {
    const principal = await requireUser(request, reply, options, true);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    if (!params.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    let part: Awaited<ReturnType<typeof request.file>>;
    try {
      part = await request.file();
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE') {
        return sendProblem(reply, 413, 'chat_file_too_large', request.id);
      }
      throw error;
    }
    if (part === undefined) return sendProblem(reply, 400, 'chat_file_required', request.id);
    try {
      const content = await readBoundedUpload(part.file);
      const digest = createHash('sha256').update(content).digest('hex');
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-file-upload:${params.data.chatId}`,
          key: idempotencyKey(request),
          request: JSON.stringify({
            filename: part.filename,
            mimeType: part.mimetype,
            bytes: content.byteLength,
            sha256: digest,
          }),
        },
        async () => ({
          status: 201,
          headers: {},
          body: await service.upload({
            conversationId: params.data.chatId,
            principalId: principal.principalId,
            filename: part.filename,
            mimeType: part.mimetype,
            content,
          }),
        }),
      );
      const uploaded = result.response.body as { id: string; originalFilename: string };
      await writeAuditEvent(options.pool, {
        principalId: principal.principalId,
        action: 'chat.file.uploaded',
        result: 'ok',
        requestId: request.id,
        detail: { fileId: uploaded.id, originalFilename: uploaded.originalFilename },
      });
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.replayed ? 200 : result.response.status).send(result.response.body);
    } catch (error) {
      return failure(reply, request, error);
    }
  });

  app.get('/chat/:chatId/file/:fileName', async (request, reply) => {
    const principal = await requireUser(request, reply, options, false);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, fileName: fileNameSchema })
      .safeParse(request.params);
    if (!params.success) return sendProblem(reply, 404, 'not_found', request.id);
    const separator = params.data.fileName.lastIndexOf('.');
    const fileId = params.data.fileName.slice(0, separator);
    const extension = params.data.fileName.slice(separator + 1);
    try {
      const result = await service.download({
        conversationId: params.data.chatId,
        principalId: principal.principalId,
        fileId,
        extension,
      });
      const etag = `"${result.file.sha256}"`;
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply
        .header('content-type', result.file.mimeType)
        .header('content-length', String(result.content.byteLength))
        .header('content-disposition', inlineFilename(result.file.originalFilename))
        .header('cache-control', 'private, no-cache')
        .header('etag', etag)
        .header('x-content-type-options', 'nosniff')
        .header('cross-origin-resource-policy', 'same-origin')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .send(result.content);
    } catch (error) {
      return failure(reply, request, error);
    }
  });

  app.delete('/v1/chats/:chatId/files/:fileId', async (request, reply) => {
    const principal = await requireUser(request, reply, options, true);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, fileId: fileIdSchema })
      .safeParse(request.params);
    const body = z
      .object({ confirmation: z.literal('DELETE') })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success) {
      return sendProblem(reply, 400, 'chat_file_delete_confirmation_required', request.id);
    }
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-file-delete:${params.data.chatId}:${params.data.fileId}`,
          key: idempotencyKey(request),
          request: 'DELETE',
        },
        async () => ({
          status: 200,
          headers: {},
          body: await service.delete({
            conversationId: params.data.chatId,
            principalId: principal.principalId,
            fileId: params.data.fileId,
          }),
        }),
      );
      await writeAuditEvent(options.pool, {
        principalId: principal.principalId,
        action: 'chat.file.deleted',
        result: 'ok',
        requestId: request.id,
        detail: { fileId: params.data.fileId },
      });
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      return failure(reply, request, error);
    }
  });
};
