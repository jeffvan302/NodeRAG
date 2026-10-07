import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withTransaction } from '../store/database.js';
import { CHAT_CORE_CONTRACT_VERSION, hashChatEvent } from './core.js';

const MAX_ACTIVE_LOG_BYTES = 64 * 1024 * 1024;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
};

const eventLineSchema = z
  .object({
    contract: z.literal(CHAT_CORE_CONTRACT_VERSION),
    databaseEventId: z.number().int().positive(),
    eventId: z.string().uuid(),
    conversationId: z.string().uuid(),
    runId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    type: z.string().min(1).max(120),
    payload: z.record(z.string(), z.unknown()),
    occurredAt: z.string().datetime({ offset: true }),
    previousSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type ChatEventLogRecord = z.infer<typeof eventLineSchema>;

export interface ChatEventLogInspection {
  readonly exists: boolean;
  readonly relativePath: string;
  readonly eventCount: number;
  readonly byteLength: number;
  readonly contentSha256: string | null;
  readonly firstDatabaseEventId: number | null;
  readonly lastDatabaseEventId: number | null;
  readonly firstEventId: string | null;
  readonly lastEventId: string | null;
}

interface SealedCheckpoint {
  readonly segmentNumber: number;
  readonly lastEventId: number;
  readonly lastEventSha256: string;
  readonly contentSha256: string;
  readonly uncompressedSha256: string;
  readonly uncompressedByteLength: number;
  readonly storageRelativePath: string;
}

const isContained = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const safeConversationLog = async (chatRoot: string, conversationId: string): Promise<string> => {
  z.string().uuid().parse(conversationId);
  const root = await realpath(chatRoot);
  const conversations = resolve(root, 'conversations');
  if (!isContained(root, conversations)) throw new Error('chat_storage_containment_failed');
  await mkdir(conversations, { recursive: true, mode: 0o700 });
  const folder = resolve(conversations, conversationId);
  if (!isContained(conversations, folder)) throw new Error('chat_storage_containment_failed');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const folderInfo = await lstat(folder);
  if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) {
    throw new Error('chat_storage_path_invalid');
  }
  await chmod(folder, 0o700);
  return resolve(folder, 'events.ndjson');
};

const verifyRecord = (candidate: unknown, previous: string | null): ChatEventLogRecord => {
  const record = eventLineSchema.parse(candidate);
  if (record.previousSha256 !== previous) throw new Error('chat_log_corrupt');
  const expected = hashChatEvent({
    eventId: record.eventId,
    conversationId: record.conversationId,
    runId: record.runId,
    sequence: record.sequence,
    type: record.type,
    payload: record.payload,
    occurredAt: record.occurredAt,
    previousSha256: record.previousSha256,
  }).toString('hex');
  if (record.sha256 !== expected) throw new Error('chat_log_corrupt');
  return record;
};

export const verifyChatEventLogContent = (
  content: Buffer,
  initialPrevious: string | null = null,
): readonly ChatEventLogRecord[] => {
  if (content.byteLength > MAX_ACTIVE_LOG_BYTES) throw new Error('chat_log_corrupt');
  if (content.byteLength === 0) return [];
  const text = content.toString('utf8');
  if (!text.endsWith('\n')) throw new Error('chat_log_partial_segment');
  const lines = text.split('\n');
  lines.pop();
  const records: ChatEventLogRecord[] = [];
  let previous = initialPrevious;
  for (const line of lines) {
    if (line.length === 0) throw new Error('chat_log_corrupt');
    const record = verifyRecord(JSON.parse(line), previous);
    if (records[0] !== undefined && record.conversationId !== records[0].conversationId) {
      throw new Error('chat_log_corrupt');
    }
    records.push(record);
    previous = record.sha256;
  }
  return records;
};

const readVerifiedRecords = async (
  path: string,
  recoverInterruptedAppend: boolean,
  initialPrevious: string | null = null,
): Promise<readonly ChatEventLogRecord[]> => {
  const information = await lstat(path).catch(() => null);
  if (information === null) return [];
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.size > MAX_ACTIVE_LOG_BYTES
  ) {
    throw new Error('chat_log_corrupt');
  }
  const text = await readFile(path, 'utf8');
  if (text.length === 0) return [];
  const hasTerminalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (hasTerminalNewline) lines.pop();
  const records: ChatEventLogRecord[] = [];
  let previous: string | null = initialPrevious;
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) throw new Error('chat_log_corrupt');
    try {
      const record = verifyRecord(JSON.parse(line), previous);
      if (records[0] !== undefined && record.conversationId !== records[0].conversationId) {
        throw new Error('chat_log_corrupt');
      }
      records.push(record);
      previous = record.sha256;
    } catch (error) {
      const interruptedTail =
        recoverInterruptedAppend && !hasTerminalNewline && index === lines.length - 1;
      if (!interruptedTail) throw new Error('chat_log_corrupt', { cause: error });
      const retained = records.length === 0 ? '' : `${lines.slice(0, -1).join('\n')}\n`;
      await truncate(path, Buffer.byteLength(retained, 'utf8'));
      return records;
    }
  }
  if (!hasTerminalNewline && text.length > 0) await appendFile(path, '\n', { encoding: 'utf8' });
  return records;
};

const logRelativePath = (conversationId: string): string =>
  `conversations/${conversationId}/events.ndjson`;

const latestSealedCheckpoint = async (
  pool: Pool,
  conversationId: string,
): Promise<SealedCheckpoint | null> => {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT segment.segment_number,segment.last_event_id,event.event_sha256,
            segment.content_sha256,segment.uncompressed_sha256,
            segment.uncompressed_byte_length,segment.storage_relative_path
     FROM noderag.chat_log_segment AS segment
     JOIN noderag.chat_event AS event ON event.id=segment.last_event_id
     WHERE segment.conversation_id=$1 AND segment.state='sealed'
     ORDER BY segment.segment_number DESC LIMIT 1`,
    [conversationId],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    !Buffer.isBuffer(row['event_sha256']) ||
    !Buffer.isBuffer(row['content_sha256']) ||
    !Buffer.isBuffer(row['uncompressed_sha256'])
  ) {
    return null;
  }
  return {
    segmentNumber: Number(row['segment_number']),
    lastEventId: Number(row['last_event_id']),
    lastEventSha256: row['event_sha256'].toString('hex'),
    contentSha256: row['content_sha256'].toString('hex'),
    uncompressedSha256: row['uncompressed_sha256'].toString('hex'),
    uncompressedByteLength: Number(row['uncompressed_byte_length']),
    storageRelativePath: String(row['storage_relative_path']),
  };
};

const inspectVerifiedLog = async (
  path: string,
  conversationId: string,
  initialPrevious: string | null = null,
): Promise<ChatEventLogInspection> => {
  const information = await lstat(path).catch(() => null);
  if (information === null) {
    return {
      exists: false,
      relativePath: logRelativePath(conversationId),
      eventCount: 0,
      byteLength: 0,
      contentSha256: null,
      firstDatabaseEventId: null,
      lastDatabaseEventId: null,
      firstEventId: null,
      lastEventId: null,
    };
  }
  const records = await readVerifiedRecords(path, false, initialPrevious);
  const content = await readFile(path);
  return {
    exists: true,
    relativePath: logRelativePath(conversationId),
    eventCount: records.length,
    byteLength: content.byteLength,
    contentSha256: createHash('sha256').update(content).digest('hex'),
    firstDatabaseEventId: records[0]?.databaseEventId ?? null,
    lastDatabaseEventId: records.at(-1)?.databaseEventId ?? null,
    firstEventId: records[0]?.eventId ?? null,
    lastEventId: records.at(-1)?.eventId ?? null,
  };
};

const checkpointActiveSegment = async (
  pool: Pool,
  path: string,
  conversationId: string,
): Promise<ChatEventLogInspection> => {
  const sealed = await latestSealedCheckpoint(pool, conversationId);
  const inspection = await inspectVerifiedLog(
    path,
    conversationId,
    sealed?.lastEventSha256 ?? null,
  );
  if (!inspection.exists || inspection.contentSha256 === null) return inspection;
  const boundaryIds = [inspection.firstEventId, inspection.lastEventId].filter(
    (value): value is string => value !== null,
  );
  const boundaryEvents =
    boundaryIds.length === 0
      ? { rows: [] as { id: unknown; event_id: string }[] }
      : await pool.query<{ id: unknown; event_id: string }>(
          `SELECT id,event_id FROM noderag.chat_event
           WHERE conversation_id=$1 AND event_id=ANY($2::uuid[])`,
          [conversationId, boundaryIds],
        );
  const databaseIdByEvent = new Map(
    boundaryEvents.rows.map(({ id, event_id: eventId }) => [eventId, Number(id)]),
  );
  const firstDatabaseEventId =
    inspection.firstEventId === null ? null : databaseIdByEvent.get(inspection.firstEventId);
  const lastDatabaseEventId =
    inspection.lastEventId === null ? null : databaseIdByEvent.get(inspection.lastEventId);
  if (
    (inspection.firstEventId !== null && firstDatabaseEventId === undefined) ||
    (inspection.lastEventId !== null && lastDatabaseEventId === undefined)
  ) {
    throw new Error('chat_log_corrupt');
  }
  await pool.query(
    `INSERT INTO noderag.chat_log_segment (
       id,conversation_id,segment_number,state,storage_relative_path,first_event_id,
       last_event_id,event_count,byte_length,content_sha256,previous_segment_sha256
     ) VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,decode($9,'hex'),$10)
     ON CONFLICT (conversation_id) WHERE state='active' DO UPDATE SET
       storage_relative_path=EXCLUDED.storage_relative_path,
       first_event_id=EXCLUDED.first_event_id,last_event_id=EXCLUDED.last_event_id,
       event_count=EXCLUDED.event_count,byte_length=EXCLUDED.byte_length,
       content_sha256=EXCLUDED.content_sha256`,
    [
      randomUUID(),
      conversationId,
      (sealed?.segmentNumber ?? 0) + 1,
      inspection.relativePath,
      firstDatabaseEventId ?? null,
      lastDatabaseEventId ?? null,
      inspection.eventCount,
      inspection.byteLength,
      inspection.contentSha256,
      sealed === null ? null : Buffer.from(sealed.contentSha256, 'hex'),
    ],
  );
  return inspection;
};

interface EventRow {
  readonly id: unknown;
  readonly event_id: string;
  readonly conversation_id: string;
  readonly run_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly previous_sha256: Buffer | null;
  readonly event_sha256: Buffer;
  readonly occurred_at: Date;
}

export const synchronizeChatEventLog = async (
  pool: Pool,
  chatRoot: string,
  conversationId: string,
): Promise<number> => {
  const path = await safeConversationLog(chatRoot, conversationId);
  const sealed = await latestSealedCheckpoint(pool, conversationId);
  if (sealed !== null) {
    const activeBytes = await readFile(path).catch(() => Buffer.alloc(0));
    if (
      activeBytes.byteLength === sealed.uncompressedByteLength &&
      createHash('sha256').update(activeBytes).digest('hex') === sealed.uncompressedSha256
    ) {
      await truncate(path, 0);
    }
  }
  const records = await readVerifiedRecords(path, true, sealed?.lastEventSha256 ?? null);
  const onDisk = records.at(-1) ?? null;
  let after = sealed?.lastEventId ?? 0;
  let previous = onDisk?.sha256 ?? sealed?.lastEventSha256 ?? null;
  if (onDisk !== null) {
    const checkpoint = await pool.query<{ id: unknown; event_sha256: Buffer }>(
      `SELECT id,event_sha256 FROM noderag.chat_event
       WHERE event_id=$1 AND conversation_id=$2`,
      [onDisk.eventId, conversationId],
    );
    if (checkpoint.rows[0]?.event_sha256.toString('hex') !== onDisk.sha256) {
      throw new Error('chat_log_corrupt');
    }
    after = Number(checkpoint.rows[0].id);
  }
  const events = await pool.query<EventRow>(
    `SELECT id,event_id,conversation_id,run_id,sequence,event_type,payload,
            previous_sha256,event_sha256,occurred_at
     FROM noderag.chat_event WHERE conversation_id=$1 AND id>$2 ORDER BY id LIMIT 10000`,
    [conversationId, after],
  );
  if (events.rows.length === 0) {
    if (onDisk !== null) {
      await pool.query(
        `INSERT INTO noderag.chat_log_cursor
           (conversation_id,last_event_id,last_event_sha256,updated_at)
         VALUES($1,$2,decode($3,'hex'),now())
         ON CONFLICT (conversation_id) DO UPDATE SET
           last_event_id=EXCLUDED.last_event_id,last_event_sha256=EXCLUDED.last_event_sha256,
           updated_at=now()`,
        [conversationId, after, onDisk.sha256],
      );
      await checkpointActiveSegment(pool, path, conversationId);
    }
    return 0;
  }
  const handle = await open(path, 'a', 0o600);
  let appended = 0;
  try {
    for (const row of events.rows) {
      const id = Number(row.id);
      const databasePrevious = row.previous_sha256?.toString('hex') ?? null;
      if (databasePrevious !== previous) throw new Error('chat_log_corrupt');
      const occurredAt = row.occurred_at.toISOString();
      const expected = hashChatEvent({
        eventId: row.event_id,
        conversationId: row.conversation_id,
        runId: row.run_id,
        sequence: row.sequence,
        type: row.event_type,
        payload: row.payload,
        occurredAt,
        previousSha256: databasePrevious,
      }).toString('hex');
      const actual = row.event_sha256.toString('hex');
      if (expected !== actual) throw new Error('chat_log_corrupt');
      const record = eventLineSchema.parse({
        contract: CHAT_CORE_CONTRACT_VERSION,
        databaseEventId: id,
        eventId: row.event_id,
        conversationId: row.conversation_id,
        runId: row.run_id,
        sequence: row.sequence,
        type: row.event_type,
        payload: row.payload,
        occurredAt,
        previousSha256: databasePrevious,
        sha256: actual,
      });
      await handle.write(`${JSON.stringify(record)}\n`, undefined, 'utf8');
      after = id;
      previous = actual;
      appended += 1;
    }
    await handle.sync();
    await chmod(path, 0o600);
  } finally {
    await handle.close();
  }
  await withTransaction(pool, async (database) => {
    await database.query(
      `INSERT INTO noderag.chat_log_cursor
         (conversation_id,last_event_id,last_event_sha256,updated_at)
       VALUES($1,$2,decode($3,'hex'),now())
       ON CONFLICT (conversation_id) DO UPDATE SET
         last_event_id=EXCLUDED.last_event_id,last_event_sha256=EXCLUDED.last_event_sha256,
         updated_at=now()`,
      [conversationId, after, previous],
    );
  });
  await checkpointActiveSegment(pool, path, conversationId);
  return appended;
};

export interface SealedChatLogSegment {
  readonly id: string;
  readonly segmentNumber: number;
  readonly relativePath: string;
  readonly eventCount: number;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  readonly compressedSha256: string;
  readonly uncompressedSha256: string;
  readonly manifestRevisionId: string;
}

const syncFile = async (path: string): Promise<void> => {
  // Windows requires a writable file descriptor for FlushFileBuffers even when
  // the caller only needs to make an already-written file durable.
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, 'r').catch(() => null);
  if (handle === null) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
};

export const sealChatEventLog = async (
  pool: Pool,
  chatRoot: string,
  conversationId: string,
): Promise<SealedChatLogSegment | null> => {
  await synchronizeChatEventLog(pool, chatRoot, conversationId);
  const path = await safeConversationLog(chatRoot, conversationId);
  const sealed = await latestSealedCheckpoint(pool, conversationId);
  const records = await readVerifiedRecords(path, false, sealed?.lastEventSha256 ?? null);
  if (records.length === 0) return null;
  const uncompressed = await readFile(path);
  const uncompressedSha256 = createHash('sha256').update(uncompressed).digest('hex');
  const compressed = gzipSync(uncompressed, { level: 9 });
  const compressedSha256 = createHash('sha256').update(compressed).digest('hex');
  const root = await realpath(chatRoot);
  const conversationRoot = resolve(root, 'conversations', conversationId);
  const archiveRoot = resolve(conversationRoot, 'archives');
  if (!isContained(root, archiveRoot)) throw new Error('chat_storage_containment_failed');
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  const archiveInfo = await lstat(archiveRoot);
  if (!archiveInfo.isDirectory() || archiveInfo.isSymbolicLink()) {
    throw new Error('chat_storage_path_invalid');
  }
  const active = await pool.query<{ id: string; segment_number: number; content_sha256: Buffer }>(
    `SELECT id,segment_number,content_sha256 FROM noderag.chat_log_segment
     WHERE conversation_id=$1 AND state='active'`,
    [conversationId],
  );
  const segment = active.rows[0];
  if (segment === undefined || segment.content_sha256.toString('hex') !== uncompressedSha256) {
    throw new Error('chat_log_checkpoint_changed');
  }
  const filename = `events.${String(segment.segment_number).padStart(6, '0')}.ndjson.gz`;
  const destination = resolve(archiveRoot, filename);
  const temporary = resolve(archiveRoot, `.${filename}.${randomUUID()}.tmp`);
  const relativePath = `conversations/${conversationId}/archives/${filename}`;
  await writeFile(temporary, compressed, { flag: 'wx', mode: 0o600 });
  await syncFile(temporary);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
  await syncDirectory(archiveRoot);
  let manifestRevisionId = '';
  try {
    await withTransaction(pool, async (database) => {
      await database.query(`SELECT id FROM noderag.chat_conversation WHERE id=$1 FOR UPDATE`, [
        conversationId,
      ]);
      const locked = await database.query<{
        id: string;
        segment_number: number;
        first_event_id: string;
        last_event_id: string;
        event_count: number;
        content_sha256: Buffer;
      }>(
        `SELECT id,segment_number,first_event_id,last_event_id,event_count,content_sha256
         FROM noderag.chat_log_segment
         WHERE id=$1 AND conversation_id=$2 AND state='active' FOR UPDATE`,
        [segment.id, conversationId],
      );
      const row = locked.rows[0];
      if (
        row === undefined ||
        row.content_sha256.toString('hex') !== uncompressedSha256 ||
        Number(row.event_count) !== records.length
      ) {
        throw new Error('chat_log_checkpoint_changed');
      }
      const previousManifest = await database.query<{ id: string }>(
        `SELECT id FROM noderag.chat_archive_manifest_revision
         WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
        [conversationId],
      );
      const previousSegments = await database.query<Record<string, unknown>>(
        `SELECT segment_number,storage_relative_path,event_count,byte_length,
                content_sha256,uncompressed_byte_length,uncompressed_sha256
         FROM noderag.chat_log_segment
         WHERE conversation_id=$1 AND state='sealed' ORDER BY segment_number`,
        [conversationId],
      );
      const manifest = {
        contract: 'chat-archive-manifest.v1',
        conversationId,
        segments: [
          ...previousSegments.rows.map((prior) => ({
            segmentNumber: Number(prior['segment_number']),
            relativePath: String(prior['storage_relative_path']),
            eventCount: Number(prior['event_count']),
            compressedBytes: Number(prior['byte_length']),
            compressedSha256: (prior['content_sha256'] as Buffer).toString('hex'),
            uncompressedBytes: Number(prior['uncompressed_byte_length']),
            uncompressedSha256: (prior['uncompressed_sha256'] as Buffer).toString('hex'),
          })),
          {
            segmentNumber: Number(row.segment_number),
            relativePath,
            eventCount: records.length,
            compressedBytes: compressed.byteLength,
            compressedSha256,
            uncompressedBytes: uncompressed.byteLength,
            uncompressedSha256,
          },
        ],
      };
      const manifestSha256 = createHash('sha256').update(canonicalJson(manifest)).digest();
      manifestRevisionId = randomUUID();
      await database.query(
        `INSERT INTO noderag.chat_archive_manifest_revision
           (id,conversation_id,prior_revision_id,manifest,manifest_sha256)
         VALUES($1,$2,$3,$4::jsonb,$5)`,
        [
          manifestRevisionId,
          conversationId,
          previousManifest.rows[0]?.id ?? null,
          JSON.stringify(manifest),
          manifestSha256,
        ],
      );
      await database.query(
        `UPDATE noderag.chat_log_segment
         SET state='sealed',storage_relative_path=$2,storage_encoding='gzip',
             byte_length=$3,content_sha256=decode($4,'hex'),
             uncompressed_byte_length=$5,uncompressed_sha256=decode($6,'hex'),
             manifest_revision_id=$7,sealed_at=now()
         WHERE id=$1`,
        [
          segment.id,
          relativePath,
          compressed.byteLength,
          compressedSha256,
          uncompressed.byteLength,
          uncompressedSha256,
          manifestRevisionId,
        ],
      );
    });
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
  const empty = resolve(archiveRoot, `.events.${randomUUID()}.tmp`);
  await writeFile(empty, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
  await syncFile(empty);
  await rename(empty, path);
  await chmod(path, 0o600);
  await syncDirectory(conversationRoot);
  return {
    id: segment.id,
    segmentNumber: segment.segment_number,
    relativePath,
    eventCount: records.length,
    compressedBytes: compressed.byteLength,
    uncompressedBytes: uncompressed.byteLength,
    compressedSha256,
    uncompressedSha256,
    manifestRevisionId,
  };
};

export const readSealedChatEventLog = async (
  pool: Pool,
  chatRoot: string,
  conversationId: string,
  segmentNumber: number,
): Promise<readonly ChatEventLogRecord[]> => {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT segment.storage_relative_path,segment.event_count,segment.byte_length,
            segment.content_sha256,segment.uncompressed_byte_length,
            segment.uncompressed_sha256,segment.first_event_id,segment.last_event_id,
            first_event.event_id AS first_event_uuid,last_event.event_id AS last_event_uuid,
            previous_event.event_sha256 AS previous_event_sha256
     FROM noderag.chat_log_segment AS segment
     LEFT JOIN noderag.chat_event AS first_event ON first_event.id=segment.first_event_id
     LEFT JOIN noderag.chat_event AS last_event ON last_event.id=segment.last_event_id
     LEFT JOIN noderag.chat_log_segment AS previous_segment
       ON previous_segment.conversation_id=segment.conversation_id
      AND previous_segment.segment_number=segment.segment_number-1
     LEFT JOIN noderag.chat_event AS previous_event ON previous_event.id=previous_segment.last_event_id
     WHERE segment.conversation_id=$1 AND segment.segment_number=$2
       AND segment.state='sealed' AND segment.storage_encoding='gzip'`,
    [conversationId, segmentNumber],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('chat_log_segment_not_found');
  const root = await realpath(chatRoot);
  const path = resolve(root, String(row['storage_relative_path']));
  if (!isContained(root, path)) throw new Error('chat_storage_containment_failed');
  const resolved = await realpath(path);
  if (!isContained(root, resolved)) throw new Error('chat_storage_containment_failed');
  const information = await lstat(resolved);
  if (!information.isFile() || information.isSymbolicLink()) throw new Error('chat_log_corrupt');
  const compressed = await readFile(resolved);
  if (
    compressed.byteLength !== Number(row['byte_length']) ||
    createHash('sha256').update(compressed).digest('hex') !==
      (row['content_sha256'] as Buffer).toString('hex')
  ) {
    throw new Error('chat_log_corrupt');
  }
  const uncompressed = gunzipSync(compressed, {
    maxOutputLength: MAX_ACTIVE_LOG_BYTES,
  });
  if (
    uncompressed.byteLength !== Number(row['uncompressed_byte_length']) ||
    createHash('sha256').update(uncompressed).digest('hex') !==
      (row['uncompressed_sha256'] as Buffer).toString('hex')
  ) {
    throw new Error('chat_log_corrupt');
  }
  const previous = Buffer.isBuffer(row['previous_event_sha256'])
    ? row['previous_event_sha256'].toString('hex')
    : null;
  const records = verifyChatEventLogContent(uncompressed, previous);
  if (
    records.length !== Number(row['event_count']) ||
    records[0]?.eventId !== String(row['first_event_uuid']) ||
    records.at(-1)?.eventId !== String(row['last_event_uuid'])
  ) {
    throw new Error('chat_log_corrupt');
  }
  return records;
};

export const inspectChatEventLog = async (
  chatRoot: string,
  conversationId: string,
): Promise<ChatEventLogInspection> => {
  const path = await safeConversationLog(chatRoot, conversationId);
  return inspectVerifiedLog(path, conversationId);
};

export const readChatEventLog = async (
  chatRoot: string,
  conversationId: string,
): Promise<readonly ChatEventLogRecord[]> => {
  const path = await safeConversationLog(chatRoot, conversationId);
  const information = await lstat(path).catch(() => null);
  if (information === null) return [];
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.size > MAX_ACTIVE_LOG_BYTES
  ) {
    throw new Error('chat_log_corrupt');
  }
  return readVerifiedRecords(path, false);
};
