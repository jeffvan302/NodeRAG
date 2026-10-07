import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import { writeAuditEvent } from '../application/audit.js';
import { ChatArtifactError, ChatArtifactService } from '../chat/artifacts.js';
import {
  ChatExportError,
  ChatExportService,
  probeChatExportCapabilities,
} from '../chat/exports.js';
import { SiloScope } from '../identity/scope.js';
import { acceptDocumentUpload } from '../ingest/upload.js';
import {
  validateStagedDocumentSignature,
  type DocumentFileStore,
  type StagedUpload,
} from '../storage/document-files.js';
import type { AuthenticatedPrincipal, RequestAuthenticator } from './authentication.js';
import { sendProblem } from './problem.js';

const chatIdSchema = z.string().uuid();
const artifactIdSchema = z.string().uuid();
const exportIdSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export interface ChatExportRoutesOptions {
  readonly pool: Pool;
  readonly authenticate: RequestAuthenticator;
  readonly files: DocumentFileStore;
  readonly enabled: boolean;
  readonly maximumUploadBytes?: number;
  readonly minimumFreeBytes?: number;
}

class ChatExportRouteError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415 | 422 | 503 | 507,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ChatExportRouteError';
  }
}

const requireUser = async (
  request: FastifyRequest,
  reply: FastifyReply,
  options: ChatExportRoutesOptions,
  mutation: boolean,
): Promise<AuthenticatedPrincipal | null> => {
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
    'SELECT enabled FROM noderag.chat_entitlement WHERE principal_id=$1',
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

const requireAdmin = async (
  request: FastifyRequest,
  reply: FastifyReply,
  options: ChatExportRoutesOptions,
): Promise<AuthenticatedPrincipal | null> => {
  const principal = await options.authenticate(request);
  if (principal === null) {
    sendProblem(reply, 401, 'authentication_required', request.id);
    return null;
  }
  if (!options.enabled || principal.searchOnly) {
    sendProblem(reply, 404, 'not_found', request.id);
    return null;
  }
  if (!principal.serverAdmin) {
    sendProblem(reply, 403, 'server_admin_required', request.id);
    return null;
  }
  return principal;
};

const idempotencyKey = (request: FastifyRequest): string => {
  const key = request.headers['idempotency-key']?.toString();
  if (key === undefined) throw new ChatExportRouteError(400, 'idempotency_key_required');
  return key;
};

const fail = (reply: FastifyReply, request: FastifyRequest, error: unknown) => {
  if (error instanceof ChatExportRouteError) {
    return sendProblem(reply, error.status, error.code, request.id);
  }
  if (error instanceof ChatExportError || error instanceof ChatArtifactError) {
    return sendProblem(reply, error.status, error.code, request.id);
  }
  if (error instanceof IdempotencyConflictError) {
    return sendProblem(reply, 409, 'idempotency_conflict', request.id);
  }
  if (error instanceof Error && error.message === 'Invalid Idempotency-Key.') {
    return sendProblem(reply, 400, 'invalid_idempotency_key', request.id);
  }
  if (error instanceof Error) {
    const uploadErrors: Readonly<Record<string, { status: 400 | 413 | 415 | 507; code: string }>> =
      {
        'insufficient-disk-space': { status: 507, code: 'insufficient_disk_space' },
        'upload-too-large': { status: 413, code: 'chat_export_ingestion_too_large' },
        'empty-upload': { status: 400, code: 'chat_export_ingestion_empty' },
        'document-signature-mismatch': {
          status: 415,
          code: 'chat_export_ingestion_signature_mismatch',
        },
        'document-package-mismatch': {
          status: 415,
          code: 'chat_export_ingestion_package_mismatch',
        },
      };
    const mapped = uploadErrors[error.message];
    if (mapped !== undefined) return sendProblem(reply, mapped.status, mapped.code, request.id);
  }
  throw error;
};

export const registerChatExportRoutes = (
  app: FastifyInstance,
  options: ChatExportRoutesOptions,
): void => {
  const exports = new ChatExportService(options.pool);
  const artifacts = new ChatArtifactService(options.pool);

  app.get('/v1/admin/chat/exports/capabilities', async (request, reply) => {
    const principal = await requireAdmin(request, reply, options);
    if (principal === null) return;
    try {
      return reply.send(await probeChatExportCapabilities());
    } catch {
      return sendProblem(reply, 503, 'chat_export_capability_unavailable', request.id);
    }
  });

  app.post('/v1/chats/:chatId/artifacts/:artifactId/exports', async (request, reply) => {
    const principal = await requireUser(request, reply, options, true);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, artifactId: artifactIdSchema })
      .safeParse(request.params);
    const body = z
      .object({
        format: z.enum(['docx', 'pdf']),
        revision: z.number().int().min(1).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success) {
      return sendProblem(reply, 400, 'invalid_request', request.id);
    }
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-export-create:${params.data.chatId}:${params.data.artifactId}`,
          key: idempotencyKey(request),
          request: JSON.stringify(body.data),
        },
        async (database) => ({
          status: 202,
          headers: {},
          body: await exports.create(
            {
              conversationId: params.data.chatId,
              principalId: principal.principalId,
              artifactId: params.data.artifactId,
              format: body.data.format,
              ...(body.data.revision === undefined ? {} : { revision: body.data.revision }),
            },
            database,
          ),
        }),
      );
      const created = result.response.body as {
        id: string;
        format: string;
        sourceRevision: number;
      };
      await writeAuditEvent(options.pool, {
        principalId: principal.principalId,
        action: 'chat.export.queued',
        result: 'ok',
        requestId: request.id,
        detail: {
          exportId: created.id,
          artifactId: params.data.artifactId,
          format: created.format,
          revision: created.sourceRevision,
        },
      });
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.replayed ? 200 : 202).send(result.response.body);
    } catch (error) {
      return fail(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/exports', async (request, reply) => {
    const principal = await requireUser(request, reply, options, false);
    if (principal === null) return;
    const params = z.object({ chatId: chatIdSchema }).safeParse(request.params);
    if (!params.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      return reply.send({
        items: await exports.list({
          conversationId: params.data.chatId,
          principalId: principal.principalId,
        }),
      });
    } catch (error) {
      return fail(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/exports/:exportId', async (request, reply) => {
    const principal = await requireUser(request, reply, options, false);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, exportId: exportIdSchema })
      .safeParse(request.params);
    if (!params.success) return sendProblem(reply, 400, 'invalid_request', request.id);
    try {
      return reply.send(
        await exports.get({
          conversationId: params.data.chatId,
          principalId: principal.principalId,
          exportId: params.data.exportId,
        }),
      );
    } catch (error) {
      return fail(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/exports/:exportId/cancel', async (request, reply) => {
    const principal = await requireUser(request, reply, options, true);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, exportId: exportIdSchema })
      .safeParse(request.params);
    const body = z.object({}).strict().safeParse(request.body);
    if (!params.success || !body.success) {
      return sendProblem(reply, 400, 'invalid_request', request.id);
    }
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-export-cancel:${params.data.exportId}`,
          key: idempotencyKey(request),
          request: '{}',
        },
        async (database) => ({
          status: 200,
          headers: {},
          body: await exports.cancel(
            {
              conversationId: params.data.chatId,
              principalId: principal.principalId,
              exportId: params.data.exportId,
            },
            database,
          ),
        }),
      );
      await writeAuditEvent(options.pool, {
        principalId: principal.principalId,
        action: 'chat.export.cancellation_requested',
        result: 'ok',
        requestId: request.id,
        detail: { exportId: params.data.exportId },
      });
      return reply.send(result.response.body);
    } catch (error) {
      return fail(reply, request, error);
    }
  });

  app.get('/v1/chats/:chatId/exports/:exportId/download', async (request, reply) => {
    const principal = await requireUser(request, reply, options, false);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, exportId: exportIdSchema })
      .safeParse(request.params);
    const query = z
      .object({ disposition: z.enum(['inline', 'attachment']).default('attachment') })
      .safeParse(request.query);
    if (!params.success || !query.success) {
      return sendProblem(reply, 400, 'invalid_request', request.id);
    }
    try {
      const result = await exports.download({
        conversationId: params.data.chatId,
        principalId: principal.principalId,
        exportId: params.data.exportId,
      });
      const filename = result.filename.replaceAll('"', '');
      return reply
        .header('content-type', result.mimeType)
        .header('content-disposition', `${query.data.disposition}; filename="${filename}"`)
        .header('content-security-policy', "default-src 'none'; frame-ancestors 'self'; sandbox")
        .header('x-content-type-options', 'nosniff')
        .send(result.bytes);
    } catch (error) {
      return fail(reply, request, error);
    }
  });

  app.post('/v1/chats/:chatId/artifacts/:artifactId/ingestions', async (request, reply) => {
    const principal = await requireUser(request, reply, options, true);
    if (principal === null) return;
    const params = z
      .object({ chatId: chatIdSchema, artifactId: artifactIdSchema })
      .safeParse(request.params);
    const body = z
      .object({
        siloId: z.number().int().min(1).max(32_767),
        revision: z.number().int().min(1),
        sourceFormat: z.enum(['markdown', 'docx', 'pdf']),
        exportId: exportIdSchema.optional(),
        expectedSha256: sha256Schema,
      })
      .strict()
      .superRefine((value, context) => {
        if (value.sourceFormat === 'markdown' && value.exportId !== undefined) {
          context.addIssue({ code: 'custom', message: 'Markdown ingestion cannot use an export.' });
        }
        if (value.sourceFormat !== 'markdown' && value.exportId === undefined) {
          context.addIssue({ code: 'custom', message: 'Generated formats require an export.' });
        }
      })
      .safeParse(request.body);
    if (!params.success || !body.success) {
      return sendProblem(reply, 400, 'invalid_request', request.id);
    }
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'upload', {
      requestedSiloIds: [body.data.siloId],
    });
    if (!scope.includes(body.data.siloId)) {
      return sendProblem(reply, 404, 'silo_not_found', request.id);
    }
    let staged: StagedUpload | undefined;
    let acceptedDocumentId: number | null = null;
    let committed = false;
    try {
      const artifact = await artifacts.download({
        conversationId: params.data.chatId,
        principalId: principal.principalId,
        artifactId: params.data.artifactId,
        revision: body.data.revision,
      });
      let bytes = artifact.content;
      let filename = artifact.artifact.name;
      let mimeType = 'text/markdown';
      let exportMetadata: Readonly<Record<string, unknown>> = {};
      if (body.data.sourceFormat !== 'markdown') {
        const exported = await exports.download({
          conversationId: params.data.chatId,
          principalId: principal.principalId,
          exportId: body.data.exportId as string,
        });
        const record = exported.export as {
          artifactId: string;
          sourceRevision: number;
          sourceSha256: string;
          format: string;
          artifactRevisionId: string;
          generatorRevision: string;
          formatPolicyRevision: string;
        };
        if (
          record.artifactId !== params.data.artifactId ||
          record.sourceRevision !== body.data.revision ||
          record.sourceSha256 !== artifact.revision.sha256 ||
          record.format !== body.data.sourceFormat
        ) {
          throw new ChatExportRouteError(409, 'chat_export_source_mismatch');
        }
        bytes = exported.bytes;
        filename = exported.filename;
        mimeType = exported.mimeType;
        exportMetadata = {
          exportId: body.data.exportId,
          generatorRevision: record.generatorRevision,
          formatPolicyRevision: record.formatPolicyRevision,
        };
      }
      const digest = artifact.revision.sha256;
      const selectedSha256 =
        body.data.sourceFormat === 'markdown' ? digest : createHashForRoute(bytes);
      if (selectedSha256 !== body.data.expectedSha256) {
        throw new ChatExportRouteError(409, 'chat_export_source_changed');
      }
      staged = await options.files.stageUpload(
        Readable.from([bytes]),
        options.maximumUploadBytes ?? 512 * 1024 * 1024,
        options.minimumFreeBytes ?? 128 * 1024 * 1024,
      );
      await validateStagedDocumentSignature(
        staged,
        body.data.sourceFormat === 'markdown' ? 'md' : body.data.sourceFormat,
      );
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `chat-artifact-ingest:${params.data.chatId}:${params.data.artifactId}`,
          key: idempotencyKey(request),
          request: JSON.stringify({ ...body.data, sha256: selectedSha256 }),
        },
        async (database) => {
          await database.query(`SELECT set_config('app.silo_ids',$1,true)`, [
            scope.postgresArray(),
          ]);
          const accepted = await acceptDocumentUpload(database, options.files, {
            siloId: body.data.siloId,
            principalId: principal.principalId,
            filename,
            mimeType,
            staged: staged as StagedUpload,
            provenanceMetadata: {
              chatArtifact: {
                conversationId: params.data.chatId,
                artifactId: params.data.artifactId,
                artifactRevisionId: artifact.revision.id,
                revision: artifact.revision.revision,
                sourceSha256: artifact.revision.sha256,
                sourceFormat: body.data.sourceFormat,
                ...exportMetadata,
              },
            },
          });
          acceptedDocumentId = accepted.documentId;
          const promotionId = randomUUID();
          await database.query(
            `INSERT INTO noderag.chat_artifact_ingestion
               (id,conversation_id,artifact_id,artifact_revision_id,export_job_id,source_format,
                source_sha256,silo_id,document_id,ingestion_job_id,requested_by_principal_id)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              promotionId,
              params.data.chatId,
              params.data.artifactId,
              artifact.revision.id,
              body.data.exportId ?? null,
              body.data.sourceFormat,
              staged?.sha256,
              body.data.siloId,
              accepted.documentId,
              accepted.jobId,
              principal.principalId,
            ],
          );
          return { status: 202, headers: {}, body: { ...accepted, promotionId } };
        },
      );
      committed = true;
      if (result.replayed && staged !== undefined) await rm(staged.temporaryPath, { force: true });
      await writeAuditEvent(options.pool, {
        principalId: principal.principalId,
        siloId: body.data.siloId,
        action: 'chat.artifact.ingested',
        result: 'ok',
        requestId: request.id,
        detail: {
          artifactId: params.data.artifactId,
          revision: body.data.revision,
          sourceFormat: body.data.sourceFormat,
          documentId: (result.response.body as { documentId: number }).documentId,
        },
      });
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.replayed ? 200 : 202).send(result.response.body);
    } catch (error) {
      if (staged !== undefined)
        await rm(staged.temporaryPath, { force: true }).catch(() => undefined);
      if (!committed && acceptedDocumentId !== null) {
        await options.files.removeDocument(acceptedDocumentId).catch(() => undefined);
      }
      return fail(reply, request, error);
    }
  });
};

const createHashForRoute = (bytes: Uint8Array): string => {
  return createHash('sha256').update(bytes).digest('hex');
};
