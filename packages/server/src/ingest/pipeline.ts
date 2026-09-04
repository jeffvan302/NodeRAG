import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chunkCanonicalMarkdown, type Embedder } from '@noderag/shared';
import type { Pool } from 'pg';
import { normalizeMarkdown } from './normalization.js';
import { enforceTokenGuard, type GuardedChunk } from './token-guard.js';
import type { DocumentFileStore } from '../storage/document-files.js';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';
import { claimNextJob, completeJob, failJob, type ClaimedJob } from '../store/jobs.js';

const setWorkerScope = async (database: SqlClient, siloId: number): Promise<void> => {
  await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [`{${String(siloId)}}`]);
};

const extractMarkdown = async (
  pool: Pool,
  files: DocumentFileStore,
  job: ClaimedJob,
  leaseOwner: string,
): Promise<void> => {
  if (job.documentId === null || job.siloId === null) throw new Error('extract-job-missing-scope');
  const document = await withTransaction(pool, async (database) => {
    await setWorkerScope(database, job.siloId ?? 0);
    const found = await database.query<{
      extension: string;
      original_sha256: Buffer;
    }>(
      `SELECT extension, original_sha256 FROM noderag.document
       WHERE id = $1 AND silo_id = $2 FOR UPDATE`,
      [job.documentId, job.siloId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new Error('document-not-found');
    return row;
  });
  const original = await readFile(files.paths(job.documentId, document.extension).originalAbsolute);
  const actualOriginalHash = createHash('sha256').update(original).digest();
  if (!actualOriginalHash.equals(document.original_sha256))
    throw new Error('original-hash-mismatch');
  const normalized = normalizeMarkdown(original);
  if (normalized.markdown.length === 0) throw new Error('empty-canonical-markdown');
  const canonical = await files.writeCanonicalMarkdown(job.documentId, normalized.markdown);

  await withTransaction(pool, async (database) => {
    await setWorkerScope(database, job.siloId ?? 0);
    await database.query(
      `UPDATE noderag.document
       SET markdown_sha256 = $3, normalized_sha256 = $3,
           character_count = $4, page_count = 1, page_basis = 'none',
           offsets_match_original = $5, encoding = 'utf-8', encoding_confidence = 1,
           normalization = 'nfc', normalization_version = 1,
           state = 'extracting', error_code = NULL, error_detail = NULL,
           metadata = metadata || jsonb_build_object(
             'canonicalBytes', $6::bigint, 'bomRemoved', $7::boolean,
             'lineEndingsChanged', $8::boolean, 'unicodeChanged', $9::boolean)
       WHERE id = $1 AND silo_id = $2`,
      [
        job.documentId,
        job.siloId,
        canonical.sha256,
        normalized.markdown.length,
        normalized.offsetsMatchOriginal,
        canonical.bytes,
        normalized.bomRemoved,
        normalized.lineEndingsChanged,
        normalized.unicodeChanged,
      ],
    );
    await database.query('DELETE FROM noderag.document_page WHERE document_id = $1', [
      job.documentId,
    ]);
    await database.query(
      `INSERT INTO noderag.document_page
         (document_id, silo_id, ordinal, character_start, character_end,
          byte_start, byte_end, extraction, extraction_confidence)
       VALUES ($1, $2, 0, 0, $3, 0, $4, 'text', 1)`,
      [job.documentId, job.siloId, normalized.markdown.length, canonical.bytes],
    );
    const build = await database.query<{ id: unknown }>(
      `SELECT id FROM noderag.build WHERE state = 'active'`,
    );
    const buildId = databaseInteger(build.rows[0]?.id, 'active build id');
    await database.query(
      `INSERT INTO noderag.job (kind, document_id, silo_id, build_id, priority, payload)
       VALUES ('embed', $1, $2, $3, 4, jsonb_build_object('format', 'md'))
       ON CONFLICT (document_id, kind)
         WHERE document_id IS NOT NULL
           AND state IN ('pending', 'leased', 'retry_wait', 'paused')
       DO NOTHING`,
      [job.documentId, job.siloId, buildId],
    );
    await completeJob(database, job.id, leaseOwner, {
      characters: normalized.markdown.length,
      canonicalBytes: canonical.bytes,
    });
  });
};

interface BuildProfileRow {
  readonly build_id: unknown;
  readonly model_manifest_id: unknown;
  readonly target_chars: number;
  readonly overlap_chars: number;
  readonly max_tokens: number;
  readonly snap_window: string | number;
  readonly heading_prefix: boolean;
  readonly markdown_sha256: Buffer;
}

const vectorLiteral = (vector: readonly number[]): string => {
  if (vector.length !== 1024 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('invalid-embedding-vector');
  }
  return `[${vector.map((value) => String(value)).join(',')}]`;
};

const parseVector = (literal: string): readonly number[] => {
  if (!literal.startsWith('[') || !literal.endsWith(']')) throw new Error('invalid-cached-vector');
  const values = literal.slice(1, -1).split(',').map(Number);
  if (values.length !== 1024 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('invalid-cached-vector');
  }
  return values;
};

interface PreparedChunk extends GuardedChunk {
  readonly sha256: Buffer;
  readonly vector: readonly number[];
}

const embedMarkdown = async (
  pool: Pool,
  files: DocumentFileStore,
  embedder: Embedder,
  job: ClaimedJob,
  leaseOwner: string,
): Promise<void> => {
  if (job.documentId === null || job.siloId === null || job.buildId === null) {
    throw new Error('embed-job-missing-scope');
  }
  const profile = await withTransaction(pool, async (database) => {
    await setWorkerScope(database, job.siloId ?? 0);
    const found = await database.query<BuildProfileRow>(
      `SELECT b.id AS build_id, b.model_manifest_id, b.target_chars, b.overlap_chars,
              b.max_tokens, b.snap_window, b.heading_prefix, d.markdown_sha256
       FROM noderag.build b
       JOIN noderag.document d ON d.id = $1 AND d.silo_id = $2
       JOIN noderag.document_page p ON p.document_id = $1 AND p.silo_id = $2 AND p.ordinal = 0
       WHERE b.id = $3 AND b.state = 'active'`,
      [job.documentId, job.siloId, job.buildId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new Error('active-build-or-markdown-missing');
    return row;
  });
  const markdown = await readFile(files.paths(job.documentId).markdownAbsolute, 'utf8');
  const markdownSha256 = createHash('sha256').update(markdown, 'utf8').digest();
  if (!markdownSha256.equals(profile.markdown_sha256)) throw new Error('markdown-hash-mismatch');
  const buildId = databaseInteger(profile.build_id, 'build id');
  const modelManifestId = databaseInteger(profile.model_manifest_id, 'model manifest id');
  const candidates = chunkCanonicalMarkdown(markdown, {
    targetCharacters: profile.target_chars,
    overlapCharacters: profile.overlap_chars,
    snapWindow: Number(profile.snap_window),
    headingPrefix: profile.heading_prefix,
  });
  const guarded = await enforceTokenGuard(markdown, candidates, profile.max_tokens, embedder);
  if (guarded.length === 0) throw new Error('no-chunks-produced');

  const prepared: PreparedChunk[] = [];
  const misses: Array<{ readonly chunk: GuardedChunk; readonly sha256: Buffer }> = [];
  for (const chunk of guarded) {
    const sha256 = createHash('sha256').update(chunk.embeddingText, 'utf8').digest();
    const cached = await pool.query<{ embedding: string }>(
      `SELECT embedding::text AS embedding FROM noderag.embedding_cache
       WHERE chunk_sha256 = $1 AND model_manifest_id = $2 AND dimensions = 1024`,
      [sha256, modelManifestId],
    );
    const row = cached.rows[0];
    if (row === undefined) misses.push({ chunk, sha256 });
    else prepared.push({ ...chunk, sha256, vector: parseVector(row.embedding) });
  }
  for (let offset = 0; offset < misses.length; offset += 16) {
    const batch = misses.slice(offset, offset + 16);
    const result = await embedder.embed(
      batch.map((item) => item.chunk.embeddingText),
      profile.max_tokens,
      4,
    );
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      const vector = result.vectors[index];
      const tokenCount = result.tokenCounts[index];
      if (item === undefined || vector === undefined || tokenCount === undefined) {
        throw new Error('embedder-batch-cardinality-mismatch');
      }
      if (tokenCount > profile.max_tokens) throw new Error('TOKEN_LIMIT');
      prepared.push({ ...item.chunk, tokenCount, sha256: item.sha256, vector });
    }
  }
  prepared.sort((left, right) => left.ordinal - right.ordinal);

  await withTransaction(pool, async (database) => {
    await setWorkerScope(database, job.siloId ?? 0);
    const existing = await database.query(
      `SELECT 1 FROM noderag.chunk
       WHERE silo_id = $1 AND document_id = $2 AND build_id = $3 LIMIT 1`,
      [job.siloId, job.documentId, buildId],
    );
    if ((existing.rowCount ?? 0) > 0) throw new Error('document-build-already-indexed');
    for (const chunk of prepared) {
      const embedding = vectorLiteral(chunk.vector);
      await database.query(
        `INSERT INTO noderag.embedding_cache
           (chunk_sha256, model_manifest_id, dimensions, embedding, refcount)
         VALUES ($1, $2, 1024, $3::halfvec, 1)
         ON CONFLICT (chunk_sha256, model_manifest_id)
         DO UPDATE SET refcount = noderag.embedding_cache.refcount + 1,
                       last_used_at = now()`,
        [chunk.sha256, modelManifestId, embedding],
      );
      await database.query(
        `INSERT INTO noderag.chunk
           (silo_id, document_id, build_id, ordinal, text, page_start, page_end,
            character_start, character_end, byte_start, byte_end, embedding,
            token_count, heading_path, chunk_sha256, part_of)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7, $8, $9,
                 $10::halfvec, $11, $12, $13, 'document')`,
        [
          job.siloId,
          job.documentId,
          buildId,
          chunk.ordinal,
          chunk.text,
          chunk.characterStart,
          chunk.characterEnd,
          chunk.byteStart,
          chunk.byteEnd,
          embedding,
          chunk.tokenCount,
          chunk.headingPath,
          chunk.sha256,
        ],
      );
    }
    await database.query(
      `UPDATE noderag.document SET state = 'ready', indexed_at = now() WHERE id = $1 AND silo_id = $2`,
      [job.documentId, job.siloId],
    );
    await database.query(
      `UPDATE noderag.build
       SET chunk_count = COALESCE(chunk_count, 0) + $2
       WHERE id = $1`,
      [buildId, prepared.length],
    );
    await completeJob(database, job.id, leaseOwner, { chunks: prepared.length, buildId });
    await database.query(
      `INSERT INTO noderag.audit_log (silo_id, action, result, row_count, detail)
       VALUES ($1, 'document.index', 'ok', $2,
               jsonb_build_object('documentId', $3::bigint, 'buildId', $4::int))`,
      [job.siloId, prepared.length, job.documentId, buildId],
    );
  });
};

export interface MarkdownWorkerOptions {
  readonly pool: Pool;
  readonly files: DocumentFileStore;
  readonly embedder: Embedder;
  readonly leaseOwner: string;
}

export const processOneMarkdownJob = async (options: MarkdownWorkerOptions): Promise<boolean> => {
  const job = await claimNextJob(options.pool, options.leaseOwner);
  if (job === null) return false;
  try {
    if (job.kind === 'extract')
      await extractMarkdown(options.pool, options.files, job, options.leaseOwner);
    else if (job.kind === 'embed')
      await embedMarkdown(options.pool, options.files, options.embedder, job, options.leaseOwner);
    else throw new Error(`unsupported-worker-job:${job.kind}`);
  } catch (error) {
    await failJob(options.pool, job, options.leaseOwner, error);
  }
  return true;
};

export const drainMarkdownJobs = async (
  options: MarkdownWorkerOptions,
  maximumJobs = 100,
): Promise<number> => {
  let processed = 0;
  while (processed < maximumJobs && (await processOneMarkdownJob(options))) processed += 1;
  return processed;
};
