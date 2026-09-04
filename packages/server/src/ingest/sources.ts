import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { type DocumentFileStore, type StagedUpload } from '../storage/document-files.js';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';
import { appendJobEvent, completeJob, heartbeatJob, type ClaimedJob } from '../store/jobs.js';

export interface SourceRegistration {
  readonly siloId: number;
  readonly principalId: number;
  readonly uri: string;
  readonly includeGlobs: readonly string[];
  readonly excludeGlobs: readonly string[];
  readonly scheduleIntervalMinutes: number | null;
  readonly operatorNote?: string;
}

export interface SourceRecord {
  readonly id: number;
  readonly siloId: number;
  readonly uri: string;
}

interface SourceRow {
  readonly id: unknown;
  readonly silo_id: number;
  readonly uri: string;
  readonly include_glob: string[];
  readonly exclude_glob: string[];
  readonly schedule_enabled: boolean;
  readonly schedule_interval_minutes: number | null;
  readonly created_by: unknown;
}

interface WatchedDocumentRow {
  readonly id: unknown;
  readonly relative_path: string;
  readonly byte_count: string | number;
  readonly source_mtime: Date | null;
  readonly original_sha256: Buffer;
  readonly extension: string;
  readonly source_state: string;
  readonly state: string;
}

interface ScannedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly mtime: Date;
}

const validateGlobs = (values: readonly string[]): readonly string[] => {
  if (values.length > 64) throw new Error('too-many-source-globs');
  return values.map((value) => {
    const normalized = value.replaceAll('\\', '/').trim();
    if (normalized.length < 1 || normalized.length > 256 || normalized.includes('\0')) {
      throw new Error('invalid-source-glob');
    }
    return normalized;
  });
};

const globExpression = (glob: string): RegExp => {
  let expression = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? '';
    if (character === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(`${expression}$`, 'u');
};

const selectedByGlobs = (
  path: string,
  includes: readonly RegExp[],
  excludes: readonly RegExp[],
): boolean =>
  (includes.length === 0 || includes.some((expression) => expression.test(path))) &&
  !excludes.some((expression) => expression.test(path));

const resolveUriPath = (uri: string): string => {
  const path = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
  if (!isAbsolute(path)) throw new Error('source-root-must-be-absolute');
  return resolve(path);
};

export const validateSourceRoot = async (
  uri: string,
  allowedRoots: readonly string[],
): Promise<string> => {
  const configured = resolveUriPath(uri);
  const root = await realpath(configured);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('source-root-not-directory');
  if (allowedRoots.length === 0) throw new Error('source-roots-not-configured');
  const permitted = await Promise.all(
    allowedRoots.map(async (allowed) => {
      const canonical = await realpath(resolve(allowed));
      return root === canonical || root.startsWith(`${canonical}${sep}`);
    }),
  );
  if (!permitted.some(Boolean)) throw new Error('source-root-outside-allowlist');
  return root;
};

export const registerSource = async (
  database: SqlClient,
  input: SourceRegistration,
): Promise<SourceRecord> => {
  const includes = validateGlobs(input.includeGlobs);
  const excludes = validateGlobs(input.excludeGlobs);
  if (
    input.scheduleIntervalMinutes !== null &&
    (!Number.isInteger(input.scheduleIntervalMinutes) ||
      input.scheduleIntervalMinutes < 1 ||
      input.scheduleIntervalMinutes > 525_600)
  ) {
    throw new Error('invalid-source-schedule');
  }
  const created = await database.query<{ id: unknown; silo_id: number; uri: string }>(
    `INSERT INTO noderag.source
       (silo_id, uri, include_glob, exclude_glob, schedule_interval_minutes,
        schedule_enabled, operator_note, created_by)
     VALUES ($1, $2, $3, $4, $5, false, $6, $7)
     RETURNING id, silo_id, uri`,
    [
      input.siloId,
      input.uri,
      includes,
      excludes,
      input.scheduleIntervalMinutes,
      input.operatorNote ?? null,
      input.principalId,
    ],
  );
  const row = created.rows[0];
  if (row === undefined) throw new Error('source-insert-returned-no-row');
  const id = databaseInteger(row.id, 'source id');
  await database.query(
    `INSERT INTO noderag.audit_log (principal_id, silo_id, action, result, detail)
     VALUES ($1, $2, 'source.create', 'ok',
             jsonb_build_object('sourceId', $3::bigint, 'scheduleEnabled', false))`,
    [input.principalId, input.siloId, id],
  );
  return { id, siloId: row.silo_id, uri: row.uri };
};

export const enqueueSourceCrawl = async (
  database: SqlClient,
  sourceId: number,
  siloId: number,
  principalId: number,
): Promise<number> => {
  const inserted = await database.query<{ id: unknown }>(
    `INSERT INTO noderag.job (kind, source_id, silo_id, priority, payload)
     VALUES ('crawl', $1, $2, 2, jsonb_build_object('requestedBy', $3::bigint))
     ON CONFLICT (source_id, kind)
       WHERE source_id IS NOT NULL
         AND state IN ('pending', 'leased', 'retry_wait', 'paused')
     DO UPDATE SET updated_at = noderag.job.updated_at
     RETURNING id`,
    [sourceId, siloId, principalId],
  );
  const jobId = databaseInteger(inserted.rows[0]?.id, 'crawl job id');
  const existingEvents = await database.query(
    `SELECT 1 FROM noderag.job_event WHERE job_id = $1 LIMIT 1`,
    [jobId],
  );
  if ((existingEvents.rowCount ?? 0) === 0) {
    await appendJobEvent(database, jobId, 'queued', { sourceId });
  }
  return jobId;
};

export const enqueueDueSourceCrawls = async (pool: Pool): Promise<number> =>
  withTransaction(pool, async (database) => {
    const due = await database.query<{ id: unknown; silo_id: number; created_by: unknown }>(
      `SELECT source.id, source.silo_id, source.created_by
       FROM noderag.source source
       JOIN noderag.silo silo ON silo.id = source.silo_id
       WHERE source.enabled AND source.schedule_enabled
         AND source.schedule_interval_minutes IS NOT NULL
         AND source.next_crawl_at <= now()
         AND silo.lifecycle_state = 'active'
       ORDER BY source.next_crawl_at, source.id
       FOR UPDATE OF source SKIP LOCKED LIMIT 32`,
    );
    for (const row of due.rows) {
      const sourceId = databaseInteger(row.id, 'scheduled source id');
      await enqueueSourceCrawl(
        database,
        sourceId,
        row.silo_id,
        row.created_by === null ? 0 : databaseInteger(row.created_by, 'source creator'),
      );
      await database.query(
        `UPDATE noderag.source
         SET next_crawl_at = now() + (schedule_interval_minutes::bigint * interval '1 minute')
         WHERE id = $1`,
        [sourceId],
      );
    }
    return due.rows.length;
  });

const enumerateMarkdown = async (
  root: string,
  includeGlobs: readonly string[],
  excludeGlobs: readonly string[],
): Promise<readonly ScannedFile[]> => {
  const includes = validateGlobs(includeGlobs).map(globExpression);
  const excludes = validateGlobs(excludeGlobs).map(globExpression);
  const files: ScannedFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      if (
        extname(relativePath).toLowerCase() !== '.md' ||
        !selectedByGlobs(relativePath, includes, excludes)
      ) {
        continue;
      }
      const info = await lstat(absolutePath);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      files.push({ absolutePath, relativePath, bytes: info.size, mtime: info.mtime });
    }
  };
  await walk(root);
  return files;
};

const stageSourceFile = async (
  files: DocumentFileStore,
  path: string,
  maximumBytes: number,
): Promise<StagedUpload> => files.stageUpload(createReadStream(path), maximumBytes, 0);

const decrementDocumentEmbeddingReferences = async (
  database: SqlClient,
  siloId: number,
  documentId: number,
): Promise<number> => {
  const count = await database.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM noderag.chunk
     WHERE silo_id = $1 AND document_id = $2`,
    [siloId, documentId],
  );
  await database.query(
    `WITH refs AS (
       SELECT chunk_sha256, b.model_manifest_id, count(*)::integer AS used
       FROM noderag.chunk c JOIN noderag.build b ON b.id = c.build_id
       WHERE c.silo_id = $1 AND c.document_id = $2
       GROUP BY chunk_sha256, b.model_manifest_id
     )
     UPDATE noderag.embedding_cache cache
     SET refcount = GREATEST(0, cache.refcount - refs.used), last_used_at = now()
     FROM refs
     WHERE cache.chunk_sha256 = refs.chunk_sha256
       AND cache.model_manifest_id = refs.model_manifest_id`,
    [siloId, documentId],
  );
  await database.query('DELETE FROM noderag.embedding_cache WHERE refcount = 0');
  return Number(count.rows[0]?.count ?? 0);
};

const insertWatchedDocument = async (
  database: SqlClient,
  files: DocumentFileStore,
  source: SourceRow,
  item: ScannedFile,
  staged: StagedUpload,
): Promise<number> => {
  const sequence = await database.query<{ id: unknown }>(
    `SELECT nextval(pg_get_serial_sequence('noderag.document', 'id')) AS id`,
  );
  const documentId = databaseInteger(sequence.rows[0]?.id, 'watched document id');
  const paths = await files.promoteOriginal(staged, documentId, 'md');
  try {
    await database.query(
      `INSERT INTO noderag.document
         (id, silo_id, source_id, name, title, extension, mime_type, relative_path,
          byte_count, source_mtime, original_sha256, uploaded_by, metadata)
       VALUES ($1, $2, $3, $4, $5, 'md', 'text/markdown', $6,
               $7, $8, $9, $10,
               jsonb_build_object('managedOriginal', $11::text,
                                  'managedMarkdown', $12::text))`,
      [
        documentId,
        source.silo_id,
        databaseInteger(source.id, 'source id'),
        basename(item.relativePath),
        basename(item.relativePath, extname(item.relativePath)),
        item.relativePath,
        staged.bytes,
        item.mtime,
        staged.sha256,
        source.created_by === null ? null : databaseInteger(source.created_by, 'source creator'),
        paths.originalRelative,
        paths.markdownRelative,
      ],
    );
    const job = await database.query<{ id: unknown }>(
      `INSERT INTO noderag.job (kind, document_id, silo_id, priority, payload)
       VALUES ('extract', $1, $2, 3,
               jsonb_build_object('format', 'md', 'sourceId', $3::bigint))
       RETURNING id`,
      [documentId, source.silo_id, source.id],
    );
    await appendJobEvent(database, databaseInteger(job.rows[0]?.id, 'extract job id'), 'queued', {
      documentId,
      sourceId: databaseInteger(source.id, 'source id'),
    });
    return documentId;
  } catch (error) {
    await files.removeDocument(documentId);
    throw error;
  }
};

const updateWatchedDocument = async (
  pool: Pool,
  files: DocumentFileStore,
  source: SourceRow,
  document: WatchedDocumentRow,
  item: ScannedFile,
  staged: StagedUpload,
): Promise<'unchanged' | 'changed'> => {
  const documentId = databaseInteger(document.id, 'watched document id');
  if (staged.sha256.equals(document.original_sha256)) {
    await withTransaction(pool, async (database) => {
      await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
        `{${String(source.silo_id)}}`,
      ]);
      await database.query(
        `UPDATE noderag.document
         SET source_mtime = $3, byte_count = $4, source_state = 'present',
             missing_since = NULL, source_note = NULL,
             state = CASE WHEN state = 'source_missing' THEN 'ready' ELSE state END
         WHERE id = $1 AND silo_id = $2`,
        [documentId, source.silo_id, item.mtime, staged.bytes],
      );
    });
    await import('node:fs/promises').then(({ rm }) => rm(staged.temporaryPath, { force: true }));
    return 'unchanged';
  }

  await files.replaceOriginal(staged, documentId, document.extension);
  await withTransaction(pool, async (database) => {
    await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
      `{${String(source.silo_id)}}`,
    ]);
    const removedChunks = await decrementDocumentEmbeddingReferences(
      database,
      source.silo_id,
      documentId,
    );
    await database.query(
      `UPDATE noderag.build
       SET chunk_count = GREATEST(0, COALESCE(chunk_count, 0) - $1)
       WHERE state = 'active'`,
      [removedChunks],
    );
    await database.query(`DELETE FROM noderag.chunk WHERE silo_id = $1 AND document_id = $2`, [
      source.silo_id,
      documentId,
    ]);
    await database.query('DELETE FROM noderag.document_page WHERE document_id = $1', [documentId]);
    await database.query(
      `UPDATE noderag.job
       SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
           state = CASE WHEN state IN ('pending', 'retry_wait', 'paused')
             THEN 'cancelled' ELSE state END,
           finished_at = CASE WHEN state IN ('pending', 'retry_wait', 'paused')
             THEN now() ELSE finished_at END,
           updated_at = now()
       WHERE document_id = $1 AND state NOT IN ('succeeded', 'failed', 'cancelled')`,
      [documentId],
    );
    await database.query(
      `UPDATE noderag.document
       SET byte_count = $3, source_mtime = $4, original_sha256 = $5,
           markdown_sha256 = NULL, normalized_sha256 = NULL,
           character_count = NULL, page_count = NULL, offsets_match_original = false,
           source_state = 'present', missing_since = NULL, source_note = NULL,
           state = 'pending', error_code = NULL, error_detail = NULL, indexed_at = NULL
       WHERE id = $1 AND silo_id = $2`,
      [documentId, source.silo_id, staged.bytes, item.mtime, staged.sha256],
    );
    const job = await database.query<{ id: unknown }>(
      `INSERT INTO noderag.job (kind, document_id, silo_id, priority, payload)
       VALUES ('extract', $1, $2, 3,
               jsonb_build_object('format', 'md', 'sourceId', $3::bigint, 'changed', true))
       RETURNING id`,
      [documentId, source.silo_id, source.id],
    );
    await appendJobEvent(database, databaseInteger(job.rows[0]?.id, 'extract job id'), 'queued', {
      documentId,
      changed: true,
    });
  });
  return 'changed';
};

export interface CrawlSourceOptions {
  readonly pool: Pool;
  readonly files: DocumentFileStore;
  readonly job: ClaimedJob;
  readonly allowedRoots: readonly string[];
  readonly maximumBytes?: number;
}

export const crawlSource = async (options: CrawlSourceOptions): Promise<void> => {
  const { job } = options;
  if (job.sourceId === null || job.siloId === null) throw new Error('crawl-job-missing-scope');
  const source = await withTransaction(options.pool, async (database) => {
    await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
      `{${String(job.siloId)}}`,
    ]);
    const found = await database.query<SourceRow>(
      `SELECT id, silo_id, uri, include_glob, exclude_glob, schedule_enabled,
              schedule_interval_minutes, created_by
       FROM noderag.source WHERE id = $1 AND silo_id = $2 FOR UPDATE`,
      [job.sourceId, job.siloId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new Error('source-not-found');
    return row;
  });

  let root: string;
  let scanned: readonly ScannedFile[];
  try {
    root = await validateSourceRoot(source.uri, options.allowedRoots);
    scanned = await enumerateMarkdown(root, source.include_glob, source.exclude_glob);
  } catch (error) {
    await withTransaction(options.pool, async (database) => {
      await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
        `{${String(job.siloId)}}`,
      ]);
      await database.query(
        `UPDATE noderag.source
         SET health_state = 'unavailable', health_checked_at = now(),
             health_error = $2, last_failure_at = now(), failure_count = failure_count + 1
         WHERE id = $1`,
        [job.sourceId, error instanceof Error ? error.message.slice(0, 1000) : 'unavailable'],
      );
      await completeJob(database, job, {
        rootHealthy: false,
        missingTransitions: 0,
      });
    });
    return;
  }

  const known = await withTransaction(options.pool, async (database) => {
    await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
      `{${String(job.siloId)}}`,
    ]);
    return database.query<WatchedDocumentRow>(
      `SELECT id, relative_path, byte_count, source_mtime, original_sha256,
              extension, source_state, state
       FROM noderag.document
       WHERE source_id = $1 AND relative_path IS NOT NULL
       ORDER BY relative_path`,
      [job.sourceId],
    );
  });
  const byPath = new Map(known.rows.map((row) => [row.relative_path, row]));
  const seen = new Set<string>();
  let created = 0;
  let changed = 0;
  let restored = 0;
  let fastGate = 0;
  const maximumBytes = options.maximumBytes ?? 2 * 1024 ** 3 - 1;

  for (const [index, item] of scanned.entries()) {
    seen.add(item.relativePath);
    const existing = byPath.get(item.relativePath);
    if (
      existing !== undefined &&
      Number(existing.byte_count) === item.bytes &&
      existing.source_mtime?.getTime() === item.mtime.getTime() &&
      existing.source_state === 'present'
    ) {
      fastGate += 1;
    } else {
      const staged = await stageSourceFile(options.files, item.absolutePath, maximumBytes);
      if (existing === undefined) {
        await withTransaction(options.pool, async (database) => {
          await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
            `{${String(job.siloId)}}`,
          ]);
          await insertWatchedDocument(database, options.files, source, item, staged);
        });
        created += 1;
      } else {
        const wasMissing = existing.source_state === 'missing';
        const disposition = await updateWatchedDocument(
          options.pool,
          options.files,
          source,
          existing,
          item,
          staged,
        );
        if (disposition === 'changed') changed += 1;
        else if (wasMissing) restored += 1;
      }
    }
    await heartbeatJob(
      options.pool,
      job,
      60_000,
      { filesSeen: index + 1, filesTotal: scanned.length },
      { lastRelativePath: item.relativePath },
    );
  }

  const missingIds = known.rows
    .filter((row) => !seen.has(row.relative_path) && row.source_state !== 'missing')
    .map((row) => databaseInteger(row.id, 'missing document id'));
  await withTransaction(options.pool, async (database) => {
    await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
      `{${String(job.siloId)}}`,
    ]);
    if (missingIds.length > 0) {
      await database.query(
        `UPDATE noderag.document
         SET source_state = 'missing', missing_since = now(), state = 'source_missing',
             source_note = 'healthy crawl did not find the source file'
         WHERE source_id = $1 AND id = ANY ($2::bigint[])`,
        [job.sourceId, missingIds],
      );
    }
    await database.query(
      `UPDATE noderag.source
       SET health_state = 'healthy', health_checked_at = now(), health_error = NULL,
           last_crawl_at = now(), last_success_at = now(), failure_count = 0,
           crawl_generation = crawl_generation + 1,
           next_crawl_at = CASE
             WHEN schedule_enabled AND schedule_interval_minutes IS NOT NULL
             THEN now() + (schedule_interval_minutes::bigint * interval '1 minute')
             ELSE NULL END
       WHERE id = $1`,
      [job.sourceId],
    );
    await completeJob(database, job, {
      rootHealthy: true,
      filesSeen: scanned.length,
      fastGate,
      created,
      changed,
      restored,
      missing: missingIds.length,
    });
    await database.query(
      `INSERT INTO noderag.audit_log (silo_id, action, result, row_count, detail)
       VALUES ($1, 'source.crawl', 'ok', $2,
               jsonb_build_object('sourceId', $3::bigint, 'created', $4::int,
                                  'changed', $5::int, 'restored', $6::int,
                                  'missing', $7::int))`,
      [job.siloId, scanned.length, job.sourceId, created, changed, restored, missingIds.length],
    );
  });
};

export const detachSource = async (
  database: SqlClient,
  sourceId: number,
  siloId: number,
  principalId: number,
): Promise<boolean> => {
  const found = await database.query(
    `SELECT 1 FROM noderag.source WHERE id = $1 AND silo_id = $2 FOR UPDATE`,
    [sourceId, siloId],
  );
  if (found.rowCount !== 1) return false;
  await database.query(
    `UPDATE noderag.document
     SET source_state = 'detached', missing_since = NULL,
         source_note = 'source registration removed', source_id = NULL,
         state = CASE WHEN state = 'source_missing' THEN 'ready' ELSE state END
     WHERE source_id = $1`,
    [sourceId],
  );
  await database.query('DELETE FROM noderag.source WHERE id = $1', [sourceId]);
  await database.query(
    `INSERT INTO noderag.audit_log (principal_id, silo_id, action, result, detail)
     VALUES ($1, $2, 'source.detach', 'ok', jsonb_build_object('sourceId', $3::bigint))`,
    [principalId, siloId, sourceId],
  );
  return true;
};

export const sourceDigest = (input: SourceRegistration): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        siloId: input.siloId,
        uri: input.uri,
        includeGlobs: [...input.includeGlobs],
        excludeGlobs: [...input.excludeGlobs],
        scheduleIntervalMinutes: input.scheduleIntervalMinutes,
        operatorNote: input.operatorNote ?? null,
      }),
    )
    .digest('hex');
