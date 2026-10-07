import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';
import { ChatArtifactService } from './artifacts.js';
import {
  CHAT_EXPORT_FORMAT_POLICY_REVISION,
  CHAT_EXPORT_GENERATOR_REVISION,
  parseChatMarkdown,
} from './export-document.js';
import {
  ChatExportGenerationError,
  generateChatExport,
  type ChatExportFormat,
} from './export-generator.js';

const exportIdSchema = z.string().uuid();
const LEASE_MILLISECONDS = 60_000;
const MAX_SAFE_ERROR_DETAIL = 2_000;

export class ChatExportError extends Error {
  constructor(
    readonly code:
      | 'chat_export_not_found'
      | 'chat_export_source_changed'
      | 'chat_export_cancelled'
      | 'chat_export_lease_lost'
      | 'chat_export_timed_out'
      | 'chat_export_storage_unsafe'
      | 'chat_export_storage_unavailable'
      | 'chat_export_disk_full'
      | 'chat_export_output_too_large',
    readonly status: 404 | 409 | 413 | 422 | 507 = 422,
  ) {
    super(code);
    this.name = 'ChatExportError';
  }
}

interface ExportRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly artifact_id: string;
  readonly artifact_revision_id: string;
  readonly source_revision: number;
  readonly source_sha256: Buffer;
  readonly requested_by_principal_id: unknown;
  readonly output_format: ChatExportFormat;
  readonly state: 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled';
  readonly progress_percent: number;
  readonly phase: 'queued' | 'parsing' | 'rendering' | 'validating' | 'publishing' | 'complete';
  readonly attempt_count: number;
  readonly maximum_attempts: number;
  readonly timeout_ms: number;
  readonly maximum_output_bytes: unknown;
  readonly lease_owner: string | null;
  readonly lease_epoch: unknown;
  readonly leased_until: Date | null;
  readonly heartbeat_at: Date | null;
  readonly run_after: Date;
  readonly cancel_requested_at: Date | null;
  readonly normalized_model_sha256: Buffer | null;
  readonly generator_revision: string;
  readonly format_policy_revision: string;
  readonly output_relative_path: string | null;
  readonly output_filename: string | null;
  readonly output_mime_type: string | null;
  readonly output_sha256: Buffer | null;
  readonly output_bytes: unknown | null;
  readonly warnings: unknown;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly created_at: Date;
  readonly started_at: Date | null;
  readonly finished_at: Date | null;
  readonly updated_at: Date;
}

interface ClaimedExport extends ExportRow {
  readonly lease_owner: string;
  readonly lease_epoch: unknown;
}

const serialize = (row: ExportRow) => ({
  id: row.id,
  chatId: row.conversation_id,
  artifactId: row.artifact_id,
  artifactRevisionId: row.artifact_revision_id,
  sourceRevision: row.source_revision,
  sourceSha256: row.source_sha256.toString('hex'),
  requestedByPrincipalId: databaseInteger(row.requested_by_principal_id, 'export principal id'),
  format: row.output_format,
  state: row.state,
  progressPercent: row.progress_percent,
  phase: row.phase,
  attempts: row.attempt_count,
  maximumAttempts: row.maximum_attempts,
  timeoutMilliseconds: row.timeout_ms,
  maximumOutputBytes: databaseInteger(row.maximum_output_bytes, 'export maximum output bytes'),
  normalizedModelSha256: row.normalized_model_sha256?.toString('hex') ?? null,
  generatorRevision: row.generator_revision,
  formatPolicyRevision: row.format_policy_revision,
  filename: row.output_filename,
  mimeType: row.output_mime_type,
  outputSha256: row.output_sha256?.toString('hex') ?? null,
  outputBytes:
    row.output_bytes === null ? null : databaseInteger(row.output_bytes, 'export output bytes'),
  warnings: Array.isArray(row.warnings) ? row.warnings.map(String) : [],
  errorCode: row.error_code,
  errorDetail: row.error_detail,
  cancelRequested: row.cancel_requested_at !== null,
  canCancel: ['queued', 'running', 'retry_wait'].includes(row.state),
  createdAt: row.created_at.toISOString(),
  startedAt: row.started_at?.toISOString() ?? null,
  finishedAt: row.finished_at?.toISOString() ?? null,
  updatedAt: row.updated_at.toISOString(),
});

const appendEvent = async (
  database: SqlClient,
  exportId: string,
  eventType: string,
  detail: Readonly<Record<string, unknown>> = {},
): Promise<void> => {
  await database.query(
    `INSERT INTO noderag.chat_export_event (export_job_id,sequence,event_type,detail)
     SELECT $1,coalesce(max(sequence)+1,0),$2,$3::jsonb
     FROM noderag.chat_export_event WHERE export_job_id=$1`,
    [exportId, eventType, JSON.stringify(detail)],
  );
};

const isContained = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const safeFilename = (name: string, revision: number, format: ChatExportFormat): string => {
  const stem = [...basename(name, extname(name)).normalize('NFC')]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 || '<>:"/\\|?*'.includes(character) ? '-' : character;
    })
    .join('')
    .replace(/[. ]+$/gu, '')
    .trim()
    .slice(0, 180);
  return `${stem.length > 0 ? stem : 'document'}-r${String(revision)}.${format}`;
};

const fsyncDirectory = async (path: string): Promise<void> => {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
};

export const classifyChatExportStorageFailure = (error: unknown): never => {
  if (error instanceof ChatExportError || error instanceof ChatExportGenerationError) throw error;
  if (error instanceof Error && 'code' in error && error.code === 'ENOSPC') {
    throw new ChatExportError('chat_export_disk_full', 507);
  }
  throw new ChatExportError('chat_export_storage_unavailable', 507);
};

export class ChatExportService {
  readonly #pool: Pool;
  readonly #artifacts: ChatArtifactService;

  constructor(pool: Pool, artifacts = new ChatArtifactService(pool)) {
    this.#pool = pool;
    this.#artifacts = artifacts;
  }

  async create(
    input: {
      conversationId: string;
      principalId: number;
      artifactId: string;
      revision?: number;
      format: ChatExportFormat;
    },
    transaction?: SqlClient,
  ) {
    const operation = async (database: SqlClient) => {
      const source = await this.#artifacts.download({
        conversationId: input.conversationId,
        principalId: input.principalId,
        artifactId: input.artifactId,
        ...(input.revision === undefined ? {} : { revision: input.revision }),
      });
      const settings = await database.query<Record<string, unknown>>(
        `SELECT settings.export_max_output_bytes,settings.export_timeout_ms,
                settings.export_maximum_attempts
         FROM noderag.chat_conversation AS conversation
         JOIN noderag.chat_conversation_configuration_revision AS configuration
           ON configuration.id=conversation.configuration_revision_id
         JOIN noderag.chat_settings_revision AS settings
           ON settings.id=configuration.settings_revision_id
         WHERE conversation.id=$1 AND conversation.owner_principal_id=$2`,
        [input.conversationId, input.principalId],
      );
      const setting = settings.rows[0];
      if (setting === undefined) throw new ChatExportError('chat_export_not_found', 404);
      const id = randomUUID();
      const inserted = await database.query<ExportRow>(
        `INSERT INTO noderag.chat_export_job
           (id,conversation_id,artifact_id,artifact_revision_id,source_revision,source_sha256,
            requested_by_principal_id,output_format,maximum_attempts,timeout_ms,
            maximum_output_bytes,generator_revision,format_policy_revision)
         SELECT $1,$2,artifact.id,revision.id,revision.revision,revision.content_sha256,
                $3,$4,$5,$6,$7,$8,$9
         FROM noderag.chat_artifact AS artifact
         JOIN noderag.chat_artifact_revision AS revision
           ON revision.artifact_id=artifact.id AND revision.id=$10
         WHERE artifact.id=$11 AND artifact.conversation_id=$2 AND artifact.state='active'
         RETURNING *`,
        [
          id,
          input.conversationId,
          input.principalId,
          input.format,
          databaseInteger(setting['export_maximum_attempts'], 'export attempts'),
          databaseInteger(setting['export_timeout_ms'], 'export timeout'),
          databaseInteger(setting['export_max_output_bytes'], 'export maximum bytes'),
          CHAT_EXPORT_GENERATOR_REVISION,
          CHAT_EXPORT_FORMAT_POLICY_REVISION,
          source.revision.id,
          input.artifactId,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new ChatExportError('chat_export_not_found', 404);
      if (!row.source_sha256.equals(Buffer.from(source.revision.sha256, 'hex'))) {
        throw new ChatExportError('chat_export_source_changed', 409);
      }
      await appendEvent(database, id, 'queued', {
        format: input.format,
        artifactRevision: source.revision.revision,
        sourceSha256: source.revision.sha256,
      });
      return serialize(row);
    };
    return transaction === undefined
      ? withTransaction(this.#pool, operation)
      : operation(transaction);
  }

  async list(input: { conversationId: string; principalId: number }) {
    const result = await this.#pool.query<ExportRow>(
      `SELECT job.* FROM noderag.chat_export_job AS job
       JOIN noderag.chat_conversation AS conversation ON conversation.id=job.conversation_id
       WHERE job.conversation_id=$1 AND conversation.owner_principal_id=$2
       ORDER BY job.created_at DESC,job.id DESC LIMIT 200`,
      [input.conversationId, input.principalId],
    );
    return result.rows.map(serialize);
  }

  async get(input: { conversationId: string; principalId: number; exportId: string }) {
    exportIdSchema.parse(input.exportId);
    const result = await this.#pool.query<ExportRow>(
      `SELECT job.* FROM noderag.chat_export_job AS job
       JOIN noderag.chat_conversation AS conversation ON conversation.id=job.conversation_id
       WHERE job.id=$1 AND job.conversation_id=$2 AND conversation.owner_principal_id=$3`,
      [input.exportId, input.conversationId, input.principalId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ChatExportError('chat_export_not_found', 404);
    const events = await this.#pool.query<{
      sequence: number;
      event_type: string;
      detail: unknown;
      created_at: Date;
    }>(
      `SELECT sequence,event_type,detail,created_at FROM noderag.chat_export_event
       WHERE export_job_id=$1 ORDER BY sequence`,
      [input.exportId],
    );
    return {
      ...serialize(row),
      events: events.rows.map((event) => ({
        sequence: event.sequence,
        type: event.event_type,
        detail: event.detail,
        createdAt: event.created_at.toISOString(),
      })),
    };
  }

  async cancel(
    input: { conversationId: string; principalId: number; exportId: string },
    transaction?: SqlClient,
  ) {
    exportIdSchema.parse(input.exportId);
    const operation = async (database: SqlClient) => {
      const result = await database.query<ExportRow>(
        `SELECT job.* FROM noderag.chat_export_job AS job
         JOIN noderag.chat_conversation AS conversation ON conversation.id=job.conversation_id
         WHERE job.id=$1 AND job.conversation_id=$2 AND conversation.owner_principal_id=$3
         FOR UPDATE OF job`,
        [input.exportId, input.conversationId, input.principalId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ChatExportError('chat_export_not_found', 404);
      if (!['queued', 'running', 'retry_wait'].includes(row.state)) return serialize(row);
      const updated = await database.query<ExportRow>(
        `UPDATE noderag.chat_export_job
         SET cancel_requested_at=coalesce(cancel_requested_at,now()),
             state=CASE WHEN state IN ('queued','retry_wait') THEN 'cancelled' ELSE state END,
             finished_at=CASE WHEN state IN ('queued','retry_wait') THEN now() ELSE finished_at END,
             error_code=CASE WHEN state IN ('queued','retry_wait') THEN 'chat_export_cancelled' ELSE error_code END,
             error_detail=CASE WHEN state IN ('queued','retry_wait') THEN 'Cancelled before conversion began.' ELSE error_detail END,
             updated_at=now()
         WHERE id=$1 RETURNING *`,
        [input.exportId],
      );
      await appendEvent(database, input.exportId, 'cancellation_requested');
      return serialize(updated.rows[0] as ExportRow);
    };
    return transaction === undefined
      ? withTransaction(this.#pool, operation)
      : operation(transaction);
  }

  async download(input: { conversationId: string; principalId: number; exportId: string }) {
    const result = await this.#pool.query<ExportRow>(
      `SELECT job.* FROM noderag.chat_export_job AS job
       JOIN noderag.chat_conversation AS conversation ON conversation.id=job.conversation_id
       WHERE job.id=$1 AND job.conversation_id=$2 AND conversation.owner_principal_id=$3
         AND job.state='succeeded'`,
      [input.exportId, input.conversationId, input.principalId],
    );
    const row = result.rows[0];
    if (
      row === undefined ||
      row.output_relative_path === null ||
      row.output_sha256 === null ||
      row.output_filename === null ||
      row.output_mime_type === null
    ) {
      throw new ChatExportError('chat_export_not_found', 404);
    }
    const context = await this.#artifacts.storageContext(input);
    const absolute = resolve(context.chatRoot, row.output_relative_path);
    if (!isContained(context.exportsRoot, absolute)) {
      throw new ChatExportError('chat_export_storage_unsafe', 422);
    }
    try {
      const information = await lstat(absolute);
      if (!information.isFile() || information.isSymbolicLink()) {
        throw new ChatExportError('chat_export_storage_unsafe', 422);
      }
      const resolved = await realpath(absolute);
      if (!isContained(context.exportsRoot, resolved)) {
        throw new ChatExportError('chat_export_storage_unsafe', 422);
      }
      const bytes = await readFile(resolved);
      if (
        bytes.byteLength !== databaseInteger(row.output_bytes, 'export output bytes') ||
        !createHash('sha256').update(bytes).digest().equals(row.output_sha256)
      ) {
        throw new ChatExportError('chat_export_storage_unsafe', 422);
      }
      return {
        export: serialize(row),
        bytes,
        filename: row.output_filename,
        mimeType: row.output_mime_type,
      };
    } catch (error) {
      return classifyChatExportStorageFailure(error);
    }
  }

  async claim(leaseOwner: string): Promise<ClaimedExport | null> {
    if (leaseOwner.length < 1 || leaseOwner.length > 200)
      throw new Error('Invalid export lease owner.');
    return withTransaction(this.#pool, async (database) => {
      await database.query(
        `UPDATE noderag.chat_export_job
         SET state='cancelled',finished_at=now(),error_code='chat_export_cancelled',
             error_detail='Cancelled while waiting for a worker.',updated_at=now()
         WHERE state IN ('queued','retry_wait') AND cancel_requested_at IS NOT NULL`,
      );
      const exhausted = await database.query<{ id: string; attempt_count: number }>(
        `UPDATE noderag.chat_export_job
         SET state='failed',finished_at=now(),error_code='chat_export_attempts_exhausted',
             error_detail='No safe retry attempts remain.',updated_at=now()
         WHERE state='running' AND leased_until<=now() AND attempt_count>=maximum_attempts
         RETURNING id,attempt_count`,
      );
      for (const row of exhausted.rows) {
        await appendEvent(database, row.id, 'failed', {
          code: 'chat_export_attempts_exhausted',
          attempt: row.attempt_count,
        });
      }
      const claimed = await database.query<ClaimedExport & { reclaimed: boolean }>(
        `WITH candidate AS (
           SELECT id,state='running' AS reclaimed
           FROM noderag.chat_export_job
           WHERE ((state IN ('queued','retry_wait') AND run_after<=now()) OR
                  (state='running' AND leased_until<=now()))
             AND cancel_requested_at IS NULL AND attempt_count<maximum_attempts
           ORDER BY run_after,created_at,id
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE noderag.chat_export_job AS job
         SET state='running',attempt_count=attempt_count+1,lease_owner=$1,
             lease_epoch=lease_epoch+1,
             leased_until=now()+($2::bigint*interval '1 millisecond'),heartbeat_at=now(),
             started_at=coalesce(started_at,now()),error_code=NULL,error_detail=NULL,updated_at=now()
         FROM candidate WHERE job.id=candidate.id
         RETURNING job.*,candidate.reclaimed`,
        [leaseOwner, LEASE_MILLISECONDS],
      );
      const row = claimed.rows[0];
      if (row === undefined) return null;
      await appendEvent(database, row.id, row.reclaimed ? 'lease_reclaimed' : 'leased', {
        attempt: row.attempt_count,
        leaseEpoch: databaseInteger(row.lease_epoch, 'export lease epoch'),
      });
      return row;
    });
  }

  async heartbeat(job: ClaimedExport, phase: ExportRow['phase'], progress: number): Promise<void> {
    await withTransaction(this.#pool, async (database) => {
      const updated = await database.query<{ cancel_requested_at: Date | null }>(
        `UPDATE noderag.chat_export_job
         SET phase=$4,progress_percent=$5,heartbeat_at=now(),
             leased_until=now()+($6::bigint*interval '1 millisecond'),updated_at=now()
         WHERE id=$1 AND state='running' AND lease_owner=$2 AND lease_epoch=$3
         RETURNING cancel_requested_at`,
        [job.id, job.lease_owner, job.lease_epoch, phase, progress, LEASE_MILLISECONDS],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new ChatExportError('chat_export_lease_lost', 409);
      if (row.cancel_requested_at !== null) throw new ChatExportError('chat_export_cancelled', 409);
      await appendEvent(database, job.id, 'progress', { phase, progressPercent: progress });
    });
  }

  async publish(
    job: ClaimedExport,
    artifactName: string,
    bytes: Buffer,
  ): Promise<{
    readonly relativePath: string;
    readonly filename: string;
    readonly sha256: Buffer;
  }> {
    const maximumBytes = databaseInteger(job.maximum_output_bytes, 'export maximum output bytes');
    if (bytes.byteLength > maximumBytes) {
      throw new ChatExportError('chat_export_output_too_large', 413);
    }
    const principalId = databaseInteger(job.requested_by_principal_id, 'export principal id');
    const context = await this.#artifacts.storageContext({
      conversationId: job.conversation_id,
      principalId,
    });
    let temporary: string | null = null;
    try {
      const folder = resolve(context.exportsRoot, job.id);
      if (!isContained(context.exportsRoot, folder)) {
        throw new ChatExportError('chat_export_storage_unsafe', 422);
      }
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const folderInfo = await lstat(folder);
      if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) {
        throw new ChatExportError('chat_export_storage_unsafe', 422);
      }
      if (!isContained(context.exportsRoot, await realpath(folder))) {
        throw new ChatExportError('chat_export_storage_unsafe', 422);
      }
      const filename = safeFilename(artifactName, job.source_revision, job.output_format);
      const destination = resolve(folder, filename);
      if (!isContained(folder, destination)) {
        throw new ChatExportError('chat_export_storage_unsafe', 422);
      }
      const sha256 = createHash('sha256').update(bytes).digest();
      const existing = await readFile(destination).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      });
      if (existing !== null) {
        if (!createHash('sha256').update(existing).digest().equals(sha256)) {
          throw new ChatExportError('chat_export_storage_unsafe', 422);
        }
      } else {
        temporary = resolve(context.temporaryRoot, `${job.id}.${String(job.lease_epoch)}.export`);
        if (!isContained(context.temporaryRoot, temporary)) {
          throw new ChatExportError('chat_export_storage_unsafe', 422);
        }
        const handle = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        try {
          await handle.write(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, destination);
        temporary = null;
        await chmod(destination, 0o600).catch(() => undefined);
        await fsyncDirectory(folder);
      }
      const relativePath = relative(context.chatRoot, destination).split(sep).join('/');
      if (relativePath.startsWith('../') || relativePath.includes('/../')) {
        throw new ChatExportError('chat_export_storage_unsafe', 422);
      }
      return { relativePath, filename, sha256 };
    } catch (error) {
      if (temporary !== null) await rm(temporary, { force: true }).catch(() => undefined);
      return classifyChatExportStorageFailure(error);
    }
  }

  async succeed(
    job: ClaimedExport,
    input: {
      readonly normalizedModelSha256: string;
      readonly relativePath: string;
      readonly filename: string;
      readonly mimeType: string;
      readonly sha256: Buffer;
      readonly bytes: number;
      readonly warnings: readonly string[];
    },
  ): Promise<void> {
    await withTransaction(this.#pool, async (database) => {
      const completed = await database.query(
        `UPDATE noderag.chat_export_job
         SET state='succeeded',phase='complete',progress_percent=100,
             normalized_model_sha256=$4,output_relative_path=$5,output_filename=$6,
             output_mime_type=$7,output_sha256=$8,output_bytes=$9,warnings=$10::jsonb,
             lease_owner=NULL,leased_until=NULL,heartbeat_at=now(),finished_at=now(),updated_at=now()
         WHERE id=$1 AND state='running' AND lease_owner=$2 AND lease_epoch=$3
           AND cancel_requested_at IS NULL`,
        [
          job.id,
          job.lease_owner,
          job.lease_epoch,
          Buffer.from(input.normalizedModelSha256, 'hex'),
          input.relativePath,
          input.filename,
          input.mimeType,
          input.sha256,
          input.bytes,
          JSON.stringify(input.warnings),
        ],
      );
      if (completed.rowCount !== 1) throw new ChatExportError('chat_export_lease_lost', 409);
      await appendEvent(database, job.id, 'succeeded', {
        outputSha256: input.sha256.toString('hex'),
        bytes: input.bytes,
        warnings: input.warnings.length,
      });
    });
  }

  async discardPublished(job: ClaimedExport, relativePath: string): Promise<void> {
    const context = await this.#artifacts.storageContext({
      conversationId: job.conversation_id,
      principalId: databaseInteger(job.requested_by_principal_id, 'export principal id'),
    });
    const absolute = resolve(context.chatRoot, relativePath);
    if (!isContained(context.exportsRoot, absolute)) return;
    try {
      const information = await lstat(absolute);
      if (!information.isFile() || information.isSymbolicLink()) return;
      const resolved = await realpath(absolute);
      if (!isContained(context.exportsRoot, resolved)) return;
      await rm(resolved, { force: true });
      await fsyncDirectory(resolve(resolved, '..'));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }

  async fail(job: ClaimedExport, error: unknown): Promise<void> {
    const code =
      error instanceof ChatExportError || error instanceof ChatExportGenerationError
        ? error.code
        : 'chat_export_generation_failed';
    const permanent = new Set([
      'chat_export_source_changed',
      'chat_export_cancelled',
      'chat_export_timed_out',
      'chat_export_storage_unsafe',
      'chat_export_output_too_large',
      'chat_export_docx_invalid',
      'chat_export_docx_active_content',
      'chat_export_pdf_invalid',
      'chat_export_pdf_active_content',
    ]).has(code);
    await withTransaction(this.#pool, async (database) => {
      const state =
        code === 'chat_export_cancelled'
          ? 'cancelled'
          : !permanent && job.attempt_count < job.maximum_attempts
            ? 'retry_wait'
            : 'failed';
      const detail = `Export stopped safely (${code}).`.slice(0, MAX_SAFE_ERROR_DETAIL);
      const updated = await database.query(
        `UPDATE noderag.chat_export_job
         SET state=$4,error_code=$5,error_detail=$6,
             run_after=CASE WHEN $4='retry_wait' THEN now()+($7::bigint*interval '1 second') ELSE run_after END,
             finished_at=CASE WHEN $4 IN ('failed','cancelled') THEN now() ELSE NULL END,
             lease_owner=NULL,leased_until=NULL,heartbeat_at=now(),updated_at=now()
         WHERE id=$1 AND state='running' AND lease_owner=$2 AND lease_epoch=$3`,
        [
          job.id,
          job.lease_owner,
          job.lease_epoch,
          state,
          code,
          detail,
          Math.min(30, job.attempt_count * 2),
        ],
      );
      if (updated.rowCount !== 1) return;
      await appendEvent(database, job.id, state === 'retry_wait' ? 'retry_scheduled' : state, {
        code,
        attempt: job.attempt_count,
      });
    });
  }
}

export const processOneChatExport = async (options: {
  readonly pool: Pool;
  readonly leaseOwner: string;
  readonly service?: ChatExportService;
}): Promise<boolean> => {
  const service = options.service ?? new ChatExportService(options.pool);
  const job = await service.claim(options.leaseOwner);
  if (job === null) return false;
  const deadline = Date.now() + job.timeout_ms;
  const checkDeadline = (): void => {
    if (Date.now() > deadline) throw new ChatExportError('chat_export_timed_out', 409);
  };
  let published: Awaited<ReturnType<ChatExportService['publish']>> | null = null;
  try {
    await service.heartbeat(job, 'parsing', 10);
    const source = await new ChatArtifactService(options.pool).download({
      conversationId: job.conversation_id,
      principalId: databaseInteger(job.requested_by_principal_id, 'export principal id'),
      artifactId: job.artifact_id,
      revision: job.source_revision,
    });
    if (!Buffer.from(source.revision.sha256, 'hex').equals(job.source_sha256)) {
      throw new ChatExportError('chat_export_source_changed', 409);
    }
    checkDeadline();
    const parsed = parseChatMarkdown(source.content.toString('utf8'), source.artifact.name);
    await service.heartbeat(job, 'rendering', 35);
    checkDeadline();
    const generated = await generateChatExport(
      parsed.document,
      job.output_format,
      {
        artifactId: job.artifact_id,
        revision: job.source_revision,
        sourceSha256: job.source_sha256.toString('hex'),
      },
      databaseInteger(job.maximum_output_bytes, 'export maximum output bytes'),
    );
    checkDeadline();
    await service.heartbeat(job, 'validating', 75);
    await service.heartbeat(job, 'publishing', 90);
    published = await service.publish(job, source.artifact.name, generated.bytes);
    checkDeadline();
    try {
      await service.heartbeat(job, 'publishing', 95);
    } catch (error) {
      await service.discardPublished(job, published.relativePath).catch(() => undefined);
      published = null;
      throw error;
    }
    await service.succeed(job, {
      normalizedModelSha256: parsed.sha256,
      ...published,
      mimeType: generated.mimeType,
      bytes: generated.bytes.byteLength,
      warnings: generated.warnings,
    });
  } catch (error) {
    if (published !== null) {
      await service.discardPublished(job, published.relativePath).catch(() => undefined);
    }
    await service.fail(job, error);
  }
  return true;
};

let capabilityProbe: Promise<Readonly<Record<string, unknown>>> | null = null;

export const probeChatExportCapabilities = (): Promise<Readonly<Record<string, unknown>>> => {
  capabilityProbe ??= (async () => {
    const parsed = parseChatMarkdown('# Capability probe\n\nSelectable text.', 'probe.md');
    const provenance = {
      artifactId: '00000000-0000-4000-8000-000000000027',
      revision: 1,
      sourceSha256: createHash('sha256').update('capability-probe').digest('hex'),
    };
    const [docx, pdf] = await Promise.all([
      generateChatExport(parsed.document, 'docx', provenance, 8 * 1024 * 1024),
      generateChatExport(parsed.document, 'pdf', provenance, 8 * 1024 * 1024),
    ]);
    return {
      status: 'healthy',
      documentModel: parsed.document.version,
      generatorRevision: CHAT_EXPORT_GENERATOR_REVISION,
      formatPolicyRevision: CHAT_EXPORT_FORMAT_POLICY_REVISION,
      formats: {
        docx: { available: true, passive: true, bytes: docx.bytes.byteLength },
        pdf: { available: true, passive: true, embeddedFonts: true, bytes: pdf.bytes.byteLength },
      },
      externalRelationships: false,
      macros: false,
      shellConversion: false,
      networkConversion: false,
    };
  })();
  return capabilityProbe;
};
