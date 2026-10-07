import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Pool } from 'pg';
import { z } from 'zod';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';
import { verifyChatEventLogContent, type ChatEventLogRecord } from './log-store.js';

export const CHAT_BACKUP_MANIFEST_CONTRACT = 'noderag-chat-backup.v1' as const;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

const timestampSchema = z.string().datetime({ offset: true });
const nullableTimestampSchema = timestampSchema.nullable();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const portableMessageSchema = z
  .object({
    id: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().max(2_000_000),
    state: z.enum(['committed', 'streaming', 'failed', 'cancelled']),
    reasoningSummary: z.string().max(1_000_000).nullable(),
    metadata: z.record(z.string(), z.unknown()),
    contextState: z.enum(['active', 'folded']),
    pinned: z.boolean(),
    pinnedAt: nullableTimestampSchema,
    createdAt: timestampSchema,
    completedAt: nullableTimestampSchema,
  })
  .strict();

const portableRunSchema = z
  .object({
    id: z.string().uuid(),
    requestMessageId: z.string().uuid(),
    responseMessageId: z.string().uuid(),
    retryOfRunId: z.string().uuid().nullable(),
    status: z.enum(['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled']),
    provider: z.enum(['ollama_cloud', 'openai_oauth']),
    model: z.string().min(1).max(180),
    reasoningEffort: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
    contextMode: z.enum(['rolling', 'managed']),
    providerRequestId: z.string().max(300).nullable(),
    safeErrorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,119}$/u)
      .nullable(),
    errorRetryable: z.boolean().nullable(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    attempts: z.number().int().min(0).max(20),
    maximumAttempts: z.number().int().min(1).max(20),
    queuedAt: timestampSchema,
    startedAt: nullableTimestampSchema,
    finishedAt: nullableTimestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const portableSegmentSchema = z
  .object({
    segmentNumber: z.number().int().min(1).max(1_000_000),
    state: z.enum(['active', 'sealed']),
    encoding: z.enum(['identity', 'gzip']),
    relativePath: z.string().min(1).max(1024),
    firstDatabaseEventId: z.number().int().positive(),
    lastDatabaseEventId: z.number().int().positive(),
    eventCount: z.number().int().positive().max(10_000_000),
    byteLength: z.number().int().positive().max(MAX_SEGMENT_BYTES),
    contentSha256: sha256Schema,
    uncompressedByteLength: z.number().int().positive().max(MAX_SEGMENT_BYTES),
    uncompressedSha256: sha256Schema,
    previousSegmentSha256: sha256Schema.nullable(),
    previousEventSha256: sha256Schema.nullable(),
  })
  .strict();

export const portableChatManifestSchema = z
  .object({
    contract: z.literal(CHAT_BACKUP_MANIFEST_CONTRACT),
    schemaVersion: z.literal(1),
    createdAt: timestampSchema,
    rootManifestId: z.string().uuid(),
    conversation: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1).max(200),
        state: z.enum(['active', 'archived']),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
        archivedAt: nullableTimestampSchema,
        owner: z
          .object({ sourcePrincipalId: z.number().int().positive(), label: z.string().min(1) })
          .strict(),
        configuration: z
          .object({
            provider: z.enum(['ollama_cloud', 'openai_oauth']),
            model: z.string().min(1).max(180),
            reasoningEffort: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
            contextMode: z.enum(['rolling', 'managed']),
            allowResearch: z.boolean(),
            allowRag: z.boolean(),
            allowInternet: z.boolean(),
            maximumOutputTokens: z.number().int().min(128).max(1_000_000).nullable(),
          })
          .strict(),
      })
      .strict(),
    messages: z.array(portableMessageSchema).max(1_000_000),
    runs: z.array(portableRunSchema).max(500_000),
    segments: z.array(portableSegmentSchema).max(1_000_000),
  })
  .strict();

export type PortableChatManifest = z.infer<typeof portableChatManifestSchema>;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
};

const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

const contained = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const iso = (value: unknown): string => {
  if (!(value instanceof Date)) throw new Error('chat_import_manifest_invalid');
  return value.toISOString();
};

const nullableIso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : null;

const integer = (value: unknown, label: string): number => databaseInteger(value, label);

const safeDirectory = async (root: string, segments: readonly string[]): Promise<string> => {
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    if (!contained(root, current)) throw new Error('chat_storage_containment_failed');
    await mkdir(current, { recursive: true, mode: 0o700 });
    const information = await lstat(current);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error('chat_storage_path_invalid');
    }
  }
  return current;
};

export const writePortableChatManifest = async (
  pool: Pool,
  chatRoot: string,
  conversationId: string,
): Promise<{ readonly relativePath: string; readonly sha256: string }> => {
  z.string().uuid().parse(conversationId);
  const root = await realpath(chatRoot);
  const rootManifest = z
    .object({ manifestId: z.string().uuid() })
    .passthrough()
    .parse(JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')));
  const conversation = await pool.query<Record<string, unknown>>(
    `SELECT conversation.id,conversation.name,conversation.state,conversation.created_at,
            conversation.updated_at,conversation.archived_at,conversation.owner_principal_id,
            principal.label,revision.provider_kind,revision.model,revision.reasoning_effort,
            revision.context_mode,revision.allow_research,revision.allow_rag,
            revision.allow_internet,revision.maximum_output_tokens
     FROM noderag.chat_conversation AS conversation
     JOIN noderag.principal AS principal ON principal.id=conversation.owner_principal_id
     JOIN noderag.chat_conversation_configuration_revision AS revision
       ON revision.id=conversation.configuration_revision_id
     WHERE conversation.id=$1`,
    [conversationId],
  );
  const row = conversation.rows[0];
  if (row === undefined) throw new Error('chat_not_found');
  const [messages, runs, segments] = await Promise.all([
    pool.query<Record<string, unknown>>(
      `SELECT id,sequence,role,content,state,reasoning_summary,metadata,context_state,pinned,
              pinned_at,created_at,completed_at
       FROM noderag.chat_message WHERE conversation_id=$1 ORDER BY sequence`,
      [conversationId],
    ),
    pool.query<Record<string, unknown>>(
      `SELECT id,request_message_id,response_message_id,retry_of_run_id,status,provider_kind,
              model,reasoning_effort,context_mode,provider_request_id,safe_error_code,
              error_retryable,input_tokens,output_tokens,cached_input_tokens,attempts,
              maximum_attempts,queued_at,started_at,finished_at,updated_at
       FROM noderag.chat_run WHERE conversation_id=$1 ORDER BY queued_at,id`,
      [conversationId],
    ),
    pool.query<Record<string, unknown>>(
      `SELECT segment.segment_number,segment.state,segment.storage_encoding,
              segment.storage_relative_path,segment.first_event_id,segment.last_event_id,
              segment.event_count,segment.byte_length,segment.content_sha256,
              segment.uncompressed_byte_length,segment.uncompressed_sha256,
              segment.previous_segment_sha256,previous_event.event_sha256 AS previous_event_sha256,
              first_event.event_id AS first_event_uuid,last_event.event_id AS last_event_uuid
       FROM noderag.chat_log_segment AS segment
       LEFT JOIN noderag.chat_event AS first_event ON first_event.id=segment.first_event_id
       LEFT JOIN noderag.chat_event AS last_event ON last_event.id=segment.last_event_id
       LEFT JOIN noderag.chat_log_segment AS previous_segment
         ON previous_segment.conversation_id=segment.conversation_id
        AND previous_segment.segment_number=segment.segment_number-1
       LEFT JOIN noderag.chat_event AS previous_event
         ON previous_event.id=previous_segment.last_event_id
       WHERE segment.conversation_id=$1 AND segment.event_count>0
         AND segment.content_sha256 IS NOT NULL
       ORDER BY segment.segment_number`,
      [conversationId],
    ),
  ]);
  const portableSegments = await Promise.all(
    segments.rows.map(async (segment) => {
      const relativePath = String(segment['storage_relative_path']);
      const path = resolve(root, relativePath);
      if (!contained(root, path)) throw new Error('chat_storage_containment_failed');
      const resolved = await realpath(path);
      if (!contained(root, resolved)) throw new Error('chat_storage_containment_failed');
      const information = await lstat(resolved);
      if (!information.isFile() || information.isSymbolicLink()) {
        throw new Error('chat_storage_path_invalid');
      }
      const stored = await readFile(resolved);
      const compressedSha = (segment['content_sha256'] as Buffer).toString('hex');
      if (
        stored.byteLength !== Number(segment['byte_length']) ||
        digest(stored) !== compressedSha
      ) {
        throw new Error('chat_log_corrupt');
      }
      const identity = segment['storage_encoding'] === 'identity';
      let uncompressed: Buffer;
      try {
        uncompressed = identity
          ? stored
          : gunzipSync(stored, { maxOutputLength: MAX_SEGMENT_BYTES });
      } catch (error) {
        throw new Error('chat_log_corrupt', { cause: error });
      }
      const uncompressedSha = identity
        ? compressedSha
        : (segment['uncompressed_sha256'] as Buffer).toString('hex');
      const previousEventSha256 = Buffer.isBuffer(segment['previous_event_sha256'])
        ? segment['previous_event_sha256'].toString('hex')
        : null;
      if (
        uncompressed.byteLength !==
          (identity
            ? Number(segment['byte_length'])
            : Number(segment['uncompressed_byte_length'])) ||
        digest(uncompressed) !== uncompressedSha
      ) {
        throw new Error('chat_log_corrupt');
      }
      const records = verifyChatEventLogContent(uncompressed, previousEventSha256);
      if (
        records.length !== Number(segment['event_count']) ||
        records[0]?.eventId !== String(segment['first_event_uuid']) ||
        records.at(-1)?.eventId !== String(segment['last_event_uuid'])
      ) {
        throw new Error('chat_log_corrupt');
      }
      return {
        segmentNumber: Number(segment['segment_number']),
        state: segment['state'],
        encoding: segment['storage_encoding'],
        relativePath,
        firstDatabaseEventId: Number(records[0]?.databaseEventId),
        lastDatabaseEventId: Number(records.at(-1)?.databaseEventId),
        eventCount: records.length,
        byteLength: stored.byteLength,
        contentSha256: compressedSha,
        uncompressedByteLength: uncompressed.byteLength,
        uncompressedSha256: uncompressedSha,
        previousSegmentSha256: Buffer.isBuffer(segment['previous_segment_sha256'])
          ? segment['previous_segment_sha256'].toString('hex')
          : null,
        previousEventSha256,
      };
    }),
  );
  const manifest = portableChatManifestSchema.parse({
    contract: CHAT_BACKUP_MANIFEST_CONTRACT,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    rootManifestId: rootManifest.manifestId,
    conversation: {
      id: String(row['id']),
      name: String(row['name']),
      state: row['state'],
      createdAt: iso(row['created_at']),
      updatedAt: iso(row['updated_at']),
      archivedAt: nullableIso(row['archived_at']),
      owner: {
        sourcePrincipalId: integer(row['owner_principal_id'], 'source owner'),
        label: String(row['label']),
      },
      configuration: {
        provider: row['provider_kind'],
        model: String(row['model']),
        reasoningEffort: String(row['reasoning_effort']),
        contextMode: row['context_mode'],
        allowResearch: row['allow_research'] === true,
        allowRag: row['allow_rag'] === true,
        allowInternet: row['allow_internet'] === true,
        maximumOutputTokens:
          row['maximum_output_tokens'] === null ? null : Number(row['maximum_output_tokens']),
      },
    },
    messages: messages.rows.map((message) => ({
      id: String(message['id']),
      sequence: integer(message['sequence'], 'message sequence'),
      role: message['role'],
      content: String(message['content']),
      state: message['state'],
      reasoningSummary:
        message['reasoning_summary'] === null ? null : String(message['reasoning_summary']),
      metadata: message['metadata'],
      contextState: message['context_state'],
      pinned: message['pinned'] === true,
      pinnedAt: nullableIso(message['pinned_at']),
      createdAt: iso(message['created_at']),
      completedAt: nullableIso(message['completed_at']),
    })),
    runs: runs.rows.map((run) => ({
      id: String(run['id']),
      requestMessageId: String(run['request_message_id']),
      responseMessageId: String(run['response_message_id']),
      retryOfRunId: run['retry_of_run_id'] === null ? null : String(run['retry_of_run_id']),
      status: run['status'],
      provider: run['provider_kind'],
      model: String(run['model']),
      reasoningEffort: String(run['reasoning_effort']),
      contextMode: run['context_mode'],
      providerRequestId:
        run['provider_request_id'] === null ? null : String(run['provider_request_id']),
      safeErrorCode: run['safe_error_code'] === null ? null : String(run['safe_error_code']),
      errorRetryable: run['error_retryable'] === null ? null : run['error_retryable'] === true,
      inputTokens: Number(run['input_tokens']),
      outputTokens: Number(run['output_tokens']),
      cachedInputTokens: Number(run['cached_input_tokens']),
      attempts: Number(run['attempts']),
      maximumAttempts: Number(run['maximum_attempts']),
      queuedAt: iso(run['queued_at']),
      startedAt: nullableIso(run['started_at']),
      finishedAt: nullableIso(run['finished_at']),
      updatedAt: iso(run['updated_at']),
    })),
    segments: portableSegments,
  });
  const content = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (content.byteLength > MAX_MANIFEST_BYTES) throw new Error('chat_import_manifest_too_large');
  const sha256 = digest(content);
  const folder = await safeDirectory(root, ['conversations', conversationId, 'backup-manifests']);
  const filename = `${sha256}.json`;
  const destination = resolve(folder, filename);
  const temporary = resolve(folder, `.${filename}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, destination);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  await chmod(destination, 0o600);
  return {
    relativePath: `conversations/${conversationId}/backup-manifests/${filename}`,
    sha256,
  };
};

export type ChatImportConflictKind =
  | 'partial_segment'
  | 'checksum_mismatch'
  | 'owner_unmapped'
  | 'owner_conflict'
  | 'future_schema'
  | 'duplicate_content'
  | 'unsafe_path';

export interface ChatImportConflict {
  readonly kind: ChatImportConflictKind;
  readonly sourceRelativePath: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

interface InventoryCandidate {
  readonly manifest: PortableChatManifest;
  readonly manifestSha256: string;
  readonly manifestRelativePath: string;
  readonly records: readonly ChatEventLogRecord[];
  readonly segmentRecords: ReadonlyMap<number, readonly ChatEventLogRecord[]>;
  readonly destinationPrincipalId: number | null;
  readonly action: 'import' | 'already_present' | 'quarantine';
}

export interface ChatReconciliationPreview {
  readonly contract: 'chat-reconciliation-preview.v1';
  readonly sourceManifestSha256: string;
  readonly rootManifestId: string;
  readonly candidates: readonly {
    readonly conversationId: string;
    readonly name: string;
    readonly sourceOwnerId: number;
    readonly sourceOwnerLabel: string;
    readonly suggestedDestinationPrincipalId: number | null;
    readonly destinationPrincipalId: number | null;
    readonly messages: number;
    readonly runs: number;
    readonly events: number;
    readonly segments: number;
    readonly action: 'import' | 'already_present' | 'quarantine';
  }[];
  readonly destinationPrincipals: readonly { readonly id: number; readonly label: string }[];
  readonly conflicts: readonly ChatImportConflict[];
  readonly canReconcile: boolean;
  readonly inventory: readonly InventoryCandidate[];
}

const loadSegment = async (
  root: string,
  conversationId: string,
  segment: z.infer<typeof portableSegmentSchema>,
): Promise<readonly ChatEventLogRecord[]> => {
  const expectedPrefix = `conversations/${conversationId}/`;
  if (!segment.relativePath.startsWith(expectedPrefix) || segment.relativePath.includes('\\')) {
    throw new Error('chat_import_unsafe_path');
  }
  const path = resolve(root, segment.relativePath);
  if (!contained(root, path)) throw new Error('chat_import_unsafe_path');
  const resolved = await realpath(path);
  if (!contained(root, resolved)) throw new Error('chat_import_unsafe_path');
  const information = await lstat(resolved);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error('chat_import_unsafe_path');
  }
  const stored = await readFile(resolved);
  if (stored.byteLength !== segment.byteLength || digest(stored) !== segment.contentSha256) {
    throw new Error('chat_import_checksum_mismatch');
  }
  let uncompressed: Buffer;
  try {
    uncompressed =
      segment.encoding === 'gzip'
        ? gunzipSync(stored, { maxOutputLength: MAX_SEGMENT_BYTES })
        : stored;
  } catch (error) {
    throw new Error('chat_import_partial_segment', { cause: error });
  }
  if (
    uncompressed.byteLength !== segment.uncompressedByteLength ||
    digest(uncompressed) !== segment.uncompressedSha256
  ) {
    throw new Error('chat_import_checksum_mismatch');
  }
  let records: readonly ChatEventLogRecord[];
  try {
    records = verifyChatEventLogContent(uncompressed, segment.previousEventSha256);
  } catch (error) {
    if (error instanceof Error && error.message === 'chat_log_partial_segment') {
      throw new Error('chat_import_partial_segment', { cause: error });
    }
    throw new Error('chat_import_checksum_mismatch', { cause: error });
  }
  if (
    records.length !== segment.eventCount ||
    records[0]?.databaseEventId !== segment.firstDatabaseEventId ||
    records.at(-1)?.databaseEventId !== segment.lastDatabaseEventId ||
    records.some(
      ({ conversationId: eventConversationId }) => eventConversationId !== conversationId,
    )
  ) {
    throw new Error('chat_import_checksum_mismatch');
  }
  return records;
};

const conflictFromError = (error: unknown): ChatImportConflictKind => {
  const code = error instanceof Error ? error.message : '';
  if (code.includes('future_schema')) return 'future_schema';
  if (code.includes('partial_segment') || code.includes('partial')) return 'partial_segment';
  if (code.includes('checksum') || code === 'chat_log_corrupt') return 'checksum_mismatch';
  return 'unsafe_path';
};

const exactExistingChat = async (
  pool: Pool,
  manifest: PortableChatManifest,
  destinationPrincipalId: number,
): Promise<'missing' | 'exact' | 'owner_conflict' | 'content_conflict'> => {
  const conversation = await pool.query<{ owner_principal_id: unknown; name: string }>(
    `SELECT owner_principal_id,name FROM noderag.chat_conversation WHERE id=$1`,
    [manifest.conversation.id],
  );
  const row = conversation.rows[0];
  if (row === undefined) return 'missing';
  if (Number(row.owner_principal_id) !== destinationPrincipalId) return 'owner_conflict';
  const messages = await pool.query<Record<string, unknown>>(
    `SELECT id,sequence,role,content,state,reasoning_summary,metadata
     FROM noderag.chat_message WHERE conversation_id=$1 ORDER BY sequence`,
    [manifest.conversation.id],
  );
  const existingDigest = digest(
    canonicalJson(
      messages.rows.map((message) => ({
        id: String(message['id']),
        sequence: Number(message['sequence']),
        role: message['role'],
        content: message['content'],
        state: message['state'],
        reasoningSummary: message['reasoning_summary'],
        metadata: message['metadata'],
      })),
    ),
  );
  const sourceDigest = digest(
    canonicalJson(
      manifest.messages.map((message) => ({
        id: message.id,
        sequence: message.sequence,
        role: message.role,
        content: message.content,
        state: message.state === 'streaming' ? 'failed' : message.state,
        reasoningSummary: message.reasoningSummary,
        metadata: message.metadata,
      })),
    ),
  );
  return existingDigest === sourceDigest ? 'exact' : 'content_conflict';
};

const hasIdentityCollision = async (
  pool: Pool,
  candidate: Pick<InventoryCandidate, 'manifest' | 'records'>,
): Promise<boolean> => {
  const conversationId = candidate.manifest.conversation.id;
  const batches = <T>(values: readonly T[]): readonly T[][] => {
    const result: T[][] = [];
    for (let index = 0; index < values.length; index += 5_000) {
      result.push(values.slice(index, index + 5_000));
    }
    return result;
  };
  const messageById = new Map(candidate.manifest.messages.map((message) => [message.id, message]));
  for (const ids of batches([...messageById.keys()])) {
    const existing = await pool.query<Record<string, unknown>>(
      `SELECT id,conversation_id,sequence,role,content FROM noderag.chat_message
       WHERE id=ANY($1::uuid[])`,
      [ids],
    );
    if (
      existing.rows.some((row) => {
        const source = messageById.get(String(row['id']));
        return (
          source === undefined ||
          row['conversation_id'] !== conversationId ||
          Number(row['sequence']) !== source.sequence ||
          row['role'] !== source.role ||
          row['content'] !== source.content
        );
      })
    ) {
      return true;
    }
  }
  const runById = new Map(candidate.manifest.runs.map((run) => [run.id, run]));
  for (const ids of batches([...runById.keys()])) {
    const existing = await pool.query<Record<string, unknown>>(
      `SELECT id,conversation_id,request_message_id,response_message_id
       FROM noderag.chat_run WHERE id=ANY($1::uuid[])`,
      [ids],
    );
    if (
      existing.rows.some((row) => {
        const source = runById.get(String(row['id']));
        return (
          source === undefined ||
          row['conversation_id'] !== conversationId ||
          row['request_message_id'] !== source.requestMessageId ||
          row['response_message_id'] !== source.responseMessageId
        );
      })
    ) {
      return true;
    }
  }
  const eventById = new Map(candidate.records.map((record) => [record.eventId, record]));
  for (const ids of batches([...eventById.keys()])) {
    const existing = await pool.query<Record<string, unknown>>(
      `SELECT event_id,conversation_id,run_id,event_sha256
       FROM noderag.chat_event WHERE event_id=ANY($1::uuid[])`,
      [ids],
    );
    if (
      existing.rows.some((row) => {
        const source = eventById.get(String(row['event_id']));
        return (
          source === undefined ||
          row['conversation_id'] !== conversationId ||
          row['run_id'] !== source.runId ||
          !Buffer.isBuffer(row['event_sha256']) ||
          row['event_sha256'].toString('hex') !== source.sha256
        );
      })
    ) {
      return true;
    }
  }
  return false;
};

export const previewChatStorageReconciliation = async (
  pool: Pool,
  chatRoot: string,
  ownerMap: Readonly<Record<string, number>>,
): Promise<ChatReconciliationPreview> => {
  const rootInfo = await lstat(chatRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('chat_storage_path_invalid');
  }
  const root = await realpath(chatRoot);
  const rootManifestBytes = await readFile(resolve(root, 'manifest.json'));
  const rootManifestUnknown = JSON.parse(rootManifestBytes.toString('utf8')) as unknown;
  const rootManifest = z
    .object({
      schemaVersion: z.number().int(),
      kind: z.literal('noderag-chat-store'),
      manifestId: z.string().uuid(),
    })
    .passthrough()
    .parse(rootManifestUnknown);
  if (rootManifest.schemaVersion > 1) throw new Error('chat_import_future_schema');
  const principals = await pool.query<{ id: unknown; label: string }>(
    `SELECT id,label FROM noderag.principal ORDER BY lower(label),id`,
  );
  const destinationPrincipals = principals.rows.map((principal) => ({
    id: Number(principal.id),
    label: principal.label,
  }));
  const conversationsRoot = resolve(root, 'conversations');
  const entries = await readdir(conversationsRoot, { withFileTypes: true }).catch(() => []);
  const conflicts: ChatImportConflict[] = [];
  const candidates: InventoryCandidate[] = [];
  const inventoryDigests: { relativePath: string; sha256: string }[] = [
    { relativePath: 'manifest.json', sha256: digest(rootManifestBytes) },
  ];
  for (const entry of entries) {
    const conversationResult = z.string().uuid().safeParse(entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !conversationResult.success) {
      conflicts.push({
        kind: 'unsafe_path',
        sourceRelativePath: `conversations/${entry.name}`,
        detail: { reason: 'unexpected_conversation_entry' },
      });
      continue;
    }
    const manifestsRoot = resolve(conversationsRoot, entry.name, 'backup-manifests');
    const files = await readdir(manifestsRoot, { withFileTypes: true }).catch(() => []);
    const parsedManifests: {
      manifest: PortableChatManifest;
      sha256: string;
      relativePath: string;
    }[] = [];
    for (const file of files) {
      const relativePath = `conversations/${entry.name}/backup-manifests/${file.name}`;
      if (!file.isFile() || file.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/u.test(file.name)) {
        conflicts.push({
          kind: 'unsafe_path',
          sourceRelativePath: relativePath,
          detail: { reason: 'unexpected_manifest_entry' },
        });
        continue;
      }
      try {
        const bytes = await readFile(resolve(manifestsRoot, file.name));
        if (bytes.byteLength > MAX_MANIFEST_BYTES)
          throw new Error('chat_import_manifest_too_large');
        const fileSha = digest(bytes);
        inventoryDigests.push({ relativePath, sha256: fileSha });
        if (file.name !== `${fileSha}.json`) throw new Error('chat_import_checksum_mismatch');
        const unknown = JSON.parse(bytes.toString('utf8')) as { schemaVersion?: unknown };
        if (typeof unknown.schemaVersion === 'number' && unknown.schemaVersion > 1) {
          throw new Error('chat_import_future_schema');
        }
        const manifest = portableChatManifestSchema.parse(unknown);
        if (
          manifest.conversation.id !== entry.name ||
          manifest.rootManifestId !== rootManifest.manifestId
        ) {
          throw new Error('chat_import_checksum_mismatch');
        }
        parsedManifests.push({ manifest, sha256: fileSha, relativePath });
      } catch (error) {
        conflicts.push({
          kind: conflictFromError(error),
          sourceRelativePath: relativePath,
          detail: { reason: error instanceof Error ? error.message : 'manifest_invalid' },
        });
      }
    }
    const selected = parsedManifests.sort((left, right) =>
      right.manifest.createdAt.localeCompare(left.manifest.createdAt),
    )[0];
    if (selected === undefined) {
      if (files.length === 0) {
        conflicts.push({
          kind: 'partial_segment',
          sourceRelativePath: `conversations/${entry.name}`,
          detail: { reason: 'portable_manifest_missing' },
        });
      }
      continue;
    }
    const segmentRecords = new Map<number, readonly ChatEventLogRecord[]>();
    let records: ChatEventLogRecord[] = [];
    let invalid = false;
    try {
      const ordered = [...selected.manifest.segments].sort(
        (left, right) => left.segmentNumber - right.segmentNumber,
      );
      for (const segment of ordered) {
        const loaded = await loadSegment(root, entry.name, segment);
        segmentRecords.set(segment.segmentNumber, loaded);
        records = [...records, ...loaded];
      }
      for (const [index, record] of records.entries()) {
        if (index > 0 && record.previousSha256 !== records[index - 1]?.sha256) {
          throw new Error('chat_import_checksum_mismatch');
        }
      }
      const runIds = new Set(selected.manifest.runs.map(({ id }) => id));
      if (records.some(({ runId }) => !runIds.has(runId))) {
        throw new Error('chat_import_checksum_mismatch');
      }
    } catch (error) {
      invalid = true;
      conflicts.push({
        kind: conflictFromError(error),
        sourceRelativePath: selected.relativePath,
        detail: {
          conversationId: entry.name,
          reason: error instanceof Error ? error.message : 'invalid',
        },
      });
    }
    const sourceOwner = selected.manifest.conversation.owner;
    const explicitOwner = ownerMap[String(sourceOwner.sourcePrincipalId)];
    const matchingLabels = destinationPrincipals.filter(({ label }) => label === sourceOwner.label);
    const suggested = matchingLabels.length === 1 ? (matchingLabels[0]?.id ?? null) : null;
    const destinationPrincipalId = explicitOwner ?? null;
    if (
      destinationPrincipalId === null ||
      !destinationPrincipals.some(({ id }) => id === destinationPrincipalId)
    ) {
      invalid = true;
      conflicts.push({
        kind: 'owner_unmapped',
        sourceRelativePath: selected.relativePath,
        detail: {
          conversationId: entry.name,
          sourceOwnerId: sourceOwner.sourcePrincipalId,
          sourceOwnerLabel: sourceOwner.label,
          suggestedDestinationPrincipalId: suggested,
        },
      });
    }
    let action: InventoryCandidate['action'] = invalid ? 'quarantine' : 'import';
    if (!invalid && destinationPrincipalId !== null) {
      const existing = await exactExistingChat(pool, selected.manifest, destinationPrincipalId);
      if (existing === 'exact') action = 'already_present';
      else if (existing === 'owner_conflict' || existing === 'content_conflict') {
        action = 'quarantine';
        conflicts.push({
          kind: existing === 'owner_conflict' ? 'owner_conflict' : 'duplicate_content',
          sourceRelativePath: selected.relativePath,
          detail: { conversationId: entry.name },
        });
      } else if (await hasIdentityCollision(pool, { manifest: selected.manifest, records })) {
        action = 'quarantine';
        conflicts.push({
          kind: 'duplicate_content',
          sourceRelativePath: selected.relativePath,
          detail: { conversationId: entry.name, reason: 'identifier_collision' },
        });
      }
    }
    candidates.push({
      manifest: selected.manifest,
      manifestSha256: selected.sha256,
      manifestRelativePath: selected.relativePath,
      records,
      segmentRecords,
      destinationPrincipalId,
      action,
    });
  }
  const sourceManifestSha256 = digest(
    canonicalJson(
      inventoryDigests.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    ),
  );
  return {
    contract: 'chat-reconciliation-preview.v1',
    sourceManifestSha256,
    rootManifestId: rootManifest.manifestId,
    candidates: candidates.map((candidate) => {
      const owner = candidate.manifest.conversation.owner;
      const matchingLabels = destinationPrincipals.filter(({ label }) => label === owner.label);
      return {
        conversationId: candidate.manifest.conversation.id,
        name: candidate.manifest.conversation.name,
        sourceOwnerId: owner.sourcePrincipalId,
        sourceOwnerLabel: owner.label,
        suggestedDestinationPrincipalId:
          matchingLabels.length === 1 ? (matchingLabels[0]?.id ?? null) : null,
        destinationPrincipalId: candidate.destinationPrincipalId,
        messages: candidate.manifest.messages.length,
        runs: candidate.manifest.runs.length,
        events: candidate.records.length,
        segments: candidate.manifest.segments.length,
        action: candidate.action,
      };
    }),
    destinationPrincipals,
    conflicts,
    canReconcile: conflicts.length === 0 && candidates.some(({ action }) => action === 'import'),
    inventory: candidates,
  };
};

const insertImportedConversation = async (
  database: SqlClient,
  candidate: InventoryCandidate,
  requestedBy: number,
): Promise<void> => {
  if (candidate.action !== 'import' || candidate.destinationPrincipalId === null) return;
  const manifest = candidate.manifest;
  const current = await database.query<Record<string, unknown>>(
    `SELECT current.settings_revision_id,current.context_revision_id,connection.id AS connection_id
     FROM noderag.chat_configuration_current AS current
     JOIN noderag.chat_provider_connection AS connection
       ON connection.provider_kind=$1
     WHERE current.singleton=true`,
    [manifest.conversation.configuration.provider],
  );
  const configurationBase = current.rows[0];
  if (configurationBase === undefined) throw new Error('chat_import_configuration_unavailable');
  const revision = await database.query<{ id: unknown }>(
    `INSERT INTO noderag.chat_conversation_configuration_revision
       (revision_id,settings_revision_id,context_revision_id,provider_connection_id,
        provider_kind,model,reasoning_effort,context_mode,allow_research,allow_rag,
        allow_internet,tool_policy,maximum_output_tokens,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,'rolling',false,false,false,$8::jsonb,$9,$10)
     RETURNING id`,
    [
      randomUUID(),
      configurationBase['settings_revision_id'],
      configurationBase['context_revision_id'],
      configurationBase['connection_id'],
      manifest.conversation.configuration.provider,
      manifest.conversation.configuration.model,
      manifest.conversation.configuration.reasoningEffort,
      JSON.stringify({
        research: false,
        rag: false,
        internet: false,
        importedSource: manifest.conversation.configuration,
      }),
      manifest.conversation.configuration.maximumOutputTokens,
      requestedBy,
    ],
  );
  const configurationId = integer(revision.rows[0]?.id, 'imported configuration id');
  await database.query(
    `INSERT INTO noderag.chat_conversation
       (id,owner_principal_id,name,configuration_revision_id,state,created_at,updated_at,archived_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      manifest.conversation.id,
      candidate.destinationPrincipalId,
      manifest.conversation.name,
      configurationId,
      manifest.conversation.state,
      manifest.conversation.createdAt,
      manifest.conversation.updatedAt,
      manifest.conversation.state === 'archived'
        ? (manifest.conversation.archivedAt ?? manifest.conversation.updatedAt)
        : null,
    ],
  );
  for (const message of manifest.messages) {
    const interrupted = message.state === 'streaming';
    await database.query(
      `INSERT INTO noderag.chat_message
         (id,conversation_id,sequence,role,content,state,reasoning_summary,metadata,
          context_state,pinned,pinned_at,pinned_by,created_at,completed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'active',$9,$10,$11,$12,$13)`,
      [
        message.id,
        manifest.conversation.id,
        message.sequence,
        message.role,
        message.content,
        interrupted ? 'failed' : message.state,
        message.reasoningSummary,
        JSON.stringify({
          ...message.metadata,
          ...(interrupted ? { safeErrorCode: 'chat_import_interrupted_run' } : {}),
        }),
        message.pinned,
        message.pinned ? (message.pinnedAt ?? message.createdAt) : null,
        message.pinned ? candidate.destinationPrincipalId : null,
        message.createdAt,
        interrupted ? (message.completedAt ?? message.createdAt) : message.completedAt,
      ],
    );
  }
  const sourceRunIds = new Set(manifest.runs.map(({ id }) => id));
  for (const run of manifest.runs) {
    const interrupted = ['queued', 'running', 'cancelling'].includes(run.status);
    await database.query(
      `INSERT INTO noderag.chat_run
         (id,conversation_id,request_message_id,response_message_id,retry_of_run_id,status,
          provider_kind,model,reasoning_effort,context_mode,configuration_revision_id,
          attempts,maximum_attempts,provider_request_id,safe_error_code,error_retryable,
          input_tokens,output_tokens,cached_input_tokens,queued_at,started_at,finished_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'rolling',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        run.id,
        manifest.conversation.id,
        run.requestMessageId,
        run.responseMessageId,
        run.retryOfRunId !== null && sourceRunIds.has(run.retryOfRunId) ? run.retryOfRunId : null,
        interrupted ? 'failed' : run.status,
        run.provider,
        run.model,
        run.reasoningEffort,
        configurationId,
        run.attempts,
        run.maximumAttempts,
        run.providerRequestId,
        interrupted ? 'chat_import_interrupted_run' : run.safeErrorCode,
        interrupted ? false : run.errorRetryable,
        run.inputTokens,
        run.outputTokens,
        run.cachedInputTokens,
        run.queuedAt,
        run.startedAt,
        interrupted ? (run.finishedAt ?? run.updatedAt) : run.finishedAt,
        run.updatedAt,
      ],
    );
  }
  const eventDatabaseIds = new Map<string, number>();
  for (const record of candidate.records) {
    const inserted = await database.query<{ id: unknown }>(
      `INSERT INTO noderag.chat_event
         (event_id,conversation_id,run_id,sequence,event_type,payload,previous_sha256,
          event_sha256,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING id`,
      [
        record.eventId,
        manifest.conversation.id,
        record.runId,
        record.sequence,
        record.type,
        JSON.stringify(record.payload),
        record.previousSha256 === null ? null : Buffer.from(record.previousSha256, 'hex'),
        Buffer.from(record.sha256, 'hex'),
        record.occurredAt,
      ],
    );
    eventDatabaseIds.set(record.eventId, integer(inserted.rows[0]?.id, 'imported event id'));
  }
  for (const segment of manifest.segments) {
    const records = candidate.segmentRecords.get(segment.segmentNumber) ?? [];
    const first = records[0];
    const last = records.at(-1);
    if (first === undefined || last === undefined) throw new Error('chat_import_partial_segment');
    const segmentId = randomUUID();
    await database.query(
      `INSERT INTO noderag.chat_log_segment
         (id,conversation_id,segment_number,state,storage_relative_path,first_event_id,
          last_event_id,event_count,byte_length,content_sha256,previous_segment_sha256,
          created_at,sealed_at,storage_encoding,uncompressed_byte_length,uncompressed_sha256)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),
              CASE WHEN $4='sealed' THEN now() ELSE NULL END,$12,$13,$14)`,
      [
        segmentId,
        manifest.conversation.id,
        segment.segmentNumber,
        segment.state,
        segment.relativePath,
        eventDatabaseIds.get(first.eventId),
        eventDatabaseIds.get(last.eventId),
        segment.eventCount,
        segment.byteLength,
        Buffer.from(segment.contentSha256, 'hex'),
        segment.previousSegmentSha256 === null
          ? null
          : Buffer.from(segment.previousSegmentSha256, 'hex'),
        segment.encoding,
        segment.uncompressedByteLength,
        Buffer.from(segment.uncompressedSha256, 'hex'),
      ],
    );
  }
  const sealed = manifest.segments.filter(({ state }) => state === 'sealed');
  if (sealed.length > 0) {
    const archiveManifest = {
      contract: 'chat-archive-manifest.v1',
      conversationId: manifest.conversation.id,
      importedFrom: candidate.manifestSha256,
      segments: sealed,
    };
    const archiveManifestId = randomUUID();
    await database.query(
      `INSERT INTO noderag.chat_archive_manifest_revision
         (id,conversation_id,manifest,manifest_sha256)
       VALUES($1,$2,$3::jsonb,$4)`,
      [
        archiveManifestId,
        manifest.conversation.id,
        JSON.stringify(archiveManifest),
        Buffer.from(digest(canonicalJson(archiveManifest)), 'hex'),
      ],
    );
    await database.query(
      `UPDATE noderag.chat_log_segment SET manifest_revision_id=$2
       WHERE conversation_id=$1 AND state='sealed'`,
      [manifest.conversation.id, archiveManifestId],
    );
  }
  const lastRecord = candidate.records.at(-1);
  if (lastRecord !== undefined) {
    await database.query(
      `INSERT INTO noderag.chat_log_cursor
         (conversation_id,last_event_id,last_event_sha256)
       VALUES($1,$2,$3)`,
      [
        manifest.conversation.id,
        eventDatabaseIds.get(lastRecord.eventId),
        Buffer.from(lastRecord.sha256, 'hex'),
      ],
    );
  }
};

export const reconcileChatStorage = async (
  pool: Pool,
  input: {
    readonly chatRoot: string;
    readonly requestedBy: number;
    readonly ownerMap: Readonly<Record<string, number>>;
  },
): Promise<Readonly<Record<string, unknown>>> => {
  const preview = await previewChatStorageReconciliation(pool, input.chatRoot, input.ownerMap);
  const operationId = await withTransaction(pool, async (database) => {
    const result = await database.query<{ id: string; state: string }>(
      `INSERT INTO noderag.chat_import_operation
         (id,requested_by,source_manifest_sha256,source_schema_revision,
          requested_owner_map,state,diagnostics)
       VALUES($1,$2,decode($3,'hex'),$4,$5::jsonb,'validating','{}')
       ON CONFLICT (requested_by,source_manifest_sha256) DO UPDATE SET
         requested_owner_map=EXCLUDED.requested_owner_map,
         state=CASE WHEN chat_import_operation.state='completed' THEN 'completed' ELSE 'validating' END,
         safe_error_code=NULL,finished_at=NULL
       RETURNING id,state`,
      [
        randomUUID(),
        input.requestedBy,
        preview.sourceManifestSha256,
        CHAT_BACKUP_MANIFEST_CONTRACT,
        JSON.stringify(input.ownerMap),
      ],
    );
    const operation = result.rows[0];
    if (operation === undefined) throw new Error('chat_import_operation_failed');
    if (operation.state !== 'completed') {
      await database.query(`DELETE FROM noderag.chat_import_conflict WHERE operation_id=$1`, [
        operation.id,
      ]);
    }
    return operation.id;
  });
  const existing = await pool.query<{ state: string; diagnostics: Record<string, unknown> }>(
    `SELECT state,diagnostics FROM noderag.chat_import_operation WHERE id=$1`,
    [operationId],
  );
  if (existing.rows[0]?.state === 'completed') {
    return {
      operationId,
      state: 'completed',
      idempotentReplay: true,
      ...existing.rows[0].diagnostics,
    };
  }
  if (preview.conflicts.length > 0) {
    await withTransaction(pool, async (database) => {
      for (const conflict of preview.conflicts) {
        await database.query(
          `INSERT INTO noderag.chat_import_conflict
             (id,operation_id,conflict_kind,source_relative_path,safe_detail)
           VALUES($1,$2,$3,$4,$5::jsonb)`,
          [
            randomUUID(),
            operationId,
            conflict.kind,
            conflict.sourceRelativePath,
            JSON.stringify(conflict.detail),
          ],
        );
      }
      await database.query(
        `UPDATE noderag.chat_import_operation
         SET state='quarantined',safe_error_code='chat_import_conflict',
             diagnostics=$2::jsonb,finished_at=now() WHERE id=$1`,
        [operationId, JSON.stringify({ conflictCount: preview.conflicts.length })],
      );
    });
    return {
      operationId,
      state: 'quarantined',
      importedChats: 0,
      conflicts: preview.conflicts,
    };
  }
  try {
    let importedChats = 0;
    let importedEvents = 0;
    await withTransaction(pool, async (database) => {
      for (const candidate of preview.inventory) {
        if (candidate.action === 'import') {
          await insertImportedConversation(database, candidate, input.requestedBy);
          importedChats += 1;
          importedEvents += candidate.records.length;
        }
        for (const record of candidate.records) {
          await database.query(
            `INSERT INTO noderag.chat_import_event
               (event_id,operation_id,source_event_id,event_type,payload,occurred_at)
             VALUES($1,$2,$3,'event.imported',$4::jsonb,now())
             ON CONFLICT (operation_id,source_event_id) DO NOTHING`,
            [
              randomUUID(),
              operationId,
              record.eventId,
              JSON.stringify({ conversationId: candidate.manifest.conversation.id }),
            ],
          );
        }
      }
      const diagnostics = {
        importedChats,
        importedEvents,
        alreadyPresentChats: preview.inventory.filter(({ action }) => action === 'already_present')
          .length,
      };
      await database.query(
        `UPDATE noderag.chat_import_operation
         SET state='completed',diagnostics=$2::jsonb,finished_at=now() WHERE id=$1`,
        [operationId, JSON.stringify(diagnostics)],
      );
    });
    return { operationId, state: 'completed', importedChats, importedEvents };
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z][a-z0-9_-]{0,119}$/u.test(error.message)
        ? error.message
        : 'chat_import_failed';
    await pool.query(
      `UPDATE noderag.chat_import_operation
       SET state='failed',safe_error_code=$2,diagnostics=$3::jsonb,finished_at=now()
       WHERE id=$1`,
      [operationId, code, JSON.stringify({ retryable: false })],
    );
    throw error;
  }
};

export const getChatReconciliationStatus = async (
  pool: Pool,
  operationId: string,
): Promise<Readonly<Record<string, unknown>> | null> => {
  const operation = await pool.query<Record<string, unknown>>(
    `SELECT id,state,safe_error_code,source_schema_revision,requested_owner_map,diagnostics,
            created_at,finished_at
     FROM noderag.chat_import_operation WHERE id=$1`,
    [operationId],
  );
  const row = operation.rows[0];
  if (row === undefined) return null;
  const conflicts = await pool.query<Record<string, unknown>>(
    `SELECT conflict_kind,source_relative_path,safe_detail,quarantined_at
     FROM noderag.chat_import_conflict WHERE operation_id=$1 ORDER BY quarantined_at,id`,
    [operationId],
  );
  return {
    ...row,
    created_at: iso(row['created_at']),
    finished_at: nullableIso(row['finished_at']),
    conflicts: conflicts.rows.map((conflict) => ({
      ...conflict,
      quarantined_at: iso(conflict['quarantined_at']),
    })),
  };
};
