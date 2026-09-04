import { rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { readinessStateSchema, type Embedder } from '@noderag/shared';
import type { Pool } from 'pg';
import { z } from 'zod';
import { executeIdempotent, IdempotencyConflictError } from '../application/idempotency.js';
import { readinessPermits } from '../application/readiness-policy.js';
import { SiloScope } from '../identity/scope.js';
import { setupStatus } from '../setup/bootstrap.js';
import {
  validatedDocumentMetadata,
  validateStagedDocumentSignature,
  type DocumentFileStore,
  type StagedUpload,
} from '../storage/document-files.js';
import { acceptDocumentUpload, uploadRequestDigestInput } from '../ingest/upload.js';
import type { RequestAuthenticator } from './authentication.js';
import type { SecretVault } from '../identity/secrets.js';

const uploadQuerySchema = z.object({ siloId: z.coerce.number().int().min(1).max(32_767) });

const problem = (status: number, code: string, requestId: string) => ({
  type: `https://noderag.local/problems/${code}`,
  title: code.replaceAll('_', ' '),
  status,
  code,
  requestId,
});

export interface ContentRoutesOptions {
  readonly pool: Pool;
  readonly authenticate: RequestAuthenticator;
  readonly files: DocumentFileStore;
  readonly embedder: Embedder;
  readonly maximumUploadBytes?: number;
  readonly minimumFreeBytes?: number;
  readonly sourceRoots?: readonly string[];
  readonly visionBearerToken?: string;
  readonly secretVault?: SecretVault;
}

export const registerContentRoutes = (
  app: FastifyInstance,
  options: ContentRoutesOptions,
): void => {
  const maximumUploadBytes = options.maximumUploadBytes ?? 2 * 1024 ** 3 - 1;
  app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: maximumUploadBytes },
    throwFileSizeLimit: true,
  });

  app.post('/v1/documents', async (request, reply) => {
    const principal = await options.authenticate(request);
    if (principal === null) {
      return reply.code(401).send(problem(401, 'authentication_required', request.id));
    }
    if (
      !principal.csrfAllowed(request.headers['x-csrf-token']?.toString(), request.headers.origin)
    ) {
      return reply.code(403).send(problem(403, 'csrf_rejected', request.id));
    }
    const state = readinessStateSchema.parse((await setupStatus(options.pool)).state);
    if (!readinessPermits(state, 'mutation')) {
      return reply.code(503).send(problem(503, 'mutation_not_ready', request.id));
    }
    const parsedQuery = uploadQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send(problem(400, 'invalid_request', request.id));
    }
    const { siloId } = parsedQuery.data;
    const scope = await SiloScope.resolve(options.pool, principal.principalId, 'upload', {
      requestedSiloIds: [siloId],
    });
    if (!scope.includes(siloId)) {
      return reply.code(404).send(problem(404, 'silo_not_found', request.id));
    }
    const idempotencyKey = request.headers['idempotency-key']?.toString();
    if (idempotencyKey === undefined) {
      return reply.code(400).send(problem(400, 'idempotency_key_required', request.id));
    }
    let part: Awaited<ReturnType<typeof request.file>>;
    try {
      part = await request.file();
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send(problem(413, 'upload-too-large', request.id));
      }
      throw error;
    }
    if (part === undefined) return reply.code(400).send(problem(400, 'file_required', request.id));
    try {
      validatedDocumentMetadata(part.filename, part.mimetype);
    } catch (error) {
      part.file.resume();
      const code = error instanceof Error ? error.message : 'invalid-upload';
      return reply.code(415).send(problem(415, code, request.id));
    }
    let staged: StagedUpload | undefined;
    try {
      staged = await options.files.stageUpload(
        part.file,
        maximumUploadBytes,
        options.minimumFreeBytes ?? 128 * 1024 * 1024,
      );
      if (part.file.truncated) {
        await rm(staged.temporaryPath, { force: true });
        return reply.code(413).send(problem(413, 'upload-too-large', request.id));
      }
      const metadata = validatedDocumentMetadata(part.filename, part.mimetype);
      await validateStagedDocumentSignature(staged, metadata.extension);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'upload-failed';
      const status =
        code === 'insufficient-disk-space'
          ? 507
          : code === 'upload-too-large' ||
              (error instanceof Error && 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE')
            ? 413
            : code === 'document-signature-mismatch' || code === 'document-package-mismatch'
              ? 415
              : 400;
      if (staged !== undefined) await rm(staged.temporaryPath, { force: true });
      return reply.code(status).send(problem(status, code, request.id));
    }
    try {
      const result = await executeIdempotent(
        options.pool,
        {
          principalId: principal.principalId,
          operation: `document-upload:${String(siloId)}`,
          key: idempotencyKey,
          request: uploadRequestDigestInput({
            siloId,
            filename: part.filename,
            mimeType: part.mimetype,
            sha256: staged.sha256,
            bytes: staged.bytes,
          }),
        },
        async (database) => {
          await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
            scope.postgresArray(),
          ]);
          const accepted = await acceptDocumentUpload(database, options.files, {
            siloId,
            principalId: principal.principalId,
            filename: part.filename,
            mimeType: part.mimetype,
            staged,
          });
          return { status: 202, headers: {}, body: accepted };
        },
      );
      if (result.replayed) await rm(staged.temporaryPath, { force: true });
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.response.status).send(result.response.body);
    } catch (error) {
      await rm(staged.temporaryPath, { force: true });
      if (error instanceof IdempotencyConflictError) {
        return reply.code(409).send(problem(409, 'idempotency_conflict', request.id));
      }
      if (error instanceof Error && error.message === 'Invalid Idempotency-Key.') {
        return reply.code(400).send(problem(400, 'invalid_idempotency_key', request.id));
      }
      throw error;
    }
  });
};
