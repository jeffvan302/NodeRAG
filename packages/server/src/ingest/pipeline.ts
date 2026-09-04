import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chunkCanonicalMarkdown, type Embedder } from '@noderag/shared';
import type { Pool } from 'pg';
import { extractDocument, type DocumentFormat, type InjectedVision } from '../extract/index.js';
import { enforceTokenGuard, type GuardedChunk } from './token-guard.js';
import { runIntegrityJob } from './integrity.js';
import { crawlSource } from './sources.js';
import type { DocumentFileStore } from '../storage/document-files.js';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';
import { coordinatedEmbedder } from '../store/resources.js';
import {
  claimNextJob,
  completeJob,
  ClassifiedJobError,
  failJob,
  heartbeatJob,
  type ClaimedJob,
} from '../store/jobs.js';

const setWorkerScope = async (database: SqlClient, siloId: number): Promise<void> => {
  await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [`{${String(siloId)}}`]);
};

const supportedFormats = new Set<DocumentFormat>(['md', 'txt', 'pdf', 'docx', 'xlsx']);

const documentFormat = (value: string): DocumentFormat => {
  if (!supportedFormats.has(value as DocumentFormat))
    throw new Error('unsupported-document-format');
  return value as DocumentFormat;
};

const extractCanonicalDocument = async (
  pool: Pool,
  files: DocumentFileStore,
  job: ClaimedJob,
  vision?: InjectedVision,
): Promise<void> => {
  if (job.documentId === null || job.siloId === null) throw new Error('extract-job-missing-scope');
  await heartbeatJob(pool, job, 60_000, { stage: 'read-original' }, { stage: 'extract' });
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
  const format = documentFormat(document.extension);
  const original = await readFile(files.paths(job.documentId, format).originalAbsolute);
  const actualOriginalHash = createHash('sha256').update(original).digest();
  if (!actualOriginalHash.equals(document.original_sha256))
    throw new Error('original-hash-mismatch');
  const extracted = await extractDocument(original, format, {}, vision);
  const awaitingVision =
    extracted.pages.some((page) =>
      page.images.some((image) => image.disposition === 'pending_vision'),
    ) ||
    (extracted.markdown.length === 0 &&
      extracted.pages.some((page) => page.extraction === 'vision'));
  if (extracted.markdown.length === 0 && !awaitingVision)
    throw new Error('empty-canonical-markdown');
  const canonical = await files.writeCanonicalMarkdown(job.documentId, extracted.markdown);
  const imagePaths = new Map<string, string>();
  await files.resetExtractedImages(job.documentId);
  for (const page of extracted.pages) {
    for (const image of page.images) {
      const storagePath = await files.writeExtractedImage(
        job.documentId,
        image.id,
        page.ordinal * 10_000 + image.sequence,
        image.mediaType,
        image.bytes,
      );
      imagePaths.set(`${String(page.ordinal)}:${String(image.sequence)}`, storagePath);
    }
  }
  await heartbeatJob(pool, job, 60_000, { stage: 'commit-canonical' });

  let retryVision = false;
  await withTransaction(pool, async (database) => {
    await setWorkerScope(database, job.siloId ?? 0);
    await database.query(
      `UPDATE noderag.document
       SET markdown_sha256 = $3, normalized_sha256 = $3,
           character_count = $4, page_count = $5, page_basis = $6,
           offsets_match_original = $7, encoding = $8, encoding_confidence = $9,
           normalization = 'nfc', normalization_version = 1,
           state = $10, error_code = NULL, error_detail = NULL,
           metadata = metadata || jsonb_build_object(
             'canonicalBytes', $11::bigint, 'extractionWarnings', $12::jsonb,
             'extractionMetadata', $13::jsonb)
       WHERE id = $1 AND silo_id = $2`,
      [
        job.documentId,
        job.siloId,
        canonical.sha256,
        extracted.markdown.length,
        extracted.pages.length,
        extracted.pageBasis,
        extracted.offsetsMatchOriginal,
        extracted.encoding,
        extracted.encodingConfidence,
        awaitingVision ? 'awaiting_vision' : 'extracting',
        canonical.bytes,
        JSON.stringify(extracted.warnings),
        JSON.stringify(extracted.metadata),
      ],
    );
    await database.query('DELETE FROM noderag.document_page WHERE document_id = $1', [
      job.documentId,
    ]);
    await database.query(
      `WITH vision_refs AS (
         SELECT cache_key, count(*)::integer AS uses
         FROM noderag.document_image
         WHERE document_id = $1 AND cache_key IS NOT NULL
         GROUP BY cache_key
       )
       UPDATE noderag.vision_cache cache
       SET refcount = GREATEST(0, cache.refcount - vision_refs.uses)
       FROM vision_refs WHERE cache.cache_key = vision_refs.cache_key`,
      [job.documentId],
    );
    await database.query('DELETE FROM noderag.document_image WHERE document_id = $1', [
      job.documentId,
    ]);
    for (const page of extracted.pages) {
      await database.query(
        `INSERT INTO noderag.document_page
           (document_id, silo_id, ordinal, page_number, label, character_start, character_end,
            byte_start, byte_end, extraction, extraction_confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          job.documentId,
          job.siloId,
          page.ordinal,
          page.pageNumber,
          page.label,
          page.characterStart,
          page.characterEnd,
          page.byteStart,
          page.byteEnd,
          page.extraction,
          page.confidence,
        ],
      );
      for (const image of page.images) {
        await database.query(
          `INSERT INTO noderag.document_image
             (document_id, silo_id, page_ordinal, sequence, image_sha256, width, height,
              byte_count, state, skip_reason, vision_model, external_id, media_type,
              storage_path, cache_key, preprocessed_sha256, vision_provider, vision_kind,
              vision_markdown, vision_alt, vision_confidence, provider_revision,
              model_revision, prompt_revision, schema_revision, preprocessing_revision,
              analysed_at, last_error_code, attempt_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
                   $26, $27, $28, $29)`,
          [
            job.documentId,
            job.siloId,
            page.ordinal,
            image.sequence,
            createHash('sha256').update(image.bytes).digest(),
            image.width ?? null,
            image.height ?? null,
            image.bytes.byteLength,
            image.disposition,
            image.skipReason ?? null,
            image.visionModel ?? null,
            image.id,
            image.mediaType,
            imagePaths.get(`${String(page.ordinal)}:${String(image.sequence)}`) ?? null,
            image.disposition === 'analysed' && image.visionCacheKey !== undefined
              ? Buffer.from(image.visionCacheKey, 'hex')
              : null,
            image.preprocessedSha256 === undefined
              ? null
              : Buffer.from(image.preprocessedSha256, 'hex'),
            image.visionProvider ?? null,
            image.visionKind ?? null,
            image.visionMarkdown ?? null,
            image.visionAlt ?? null,
            image.visionConfidence ?? null,
            image.visionRevisions?.provider ?? null,
            image.visionRevisions?.model ?? null,
            image.visionRevisions?.prompt ?? null,
            image.visionRevisions?.schema ?? null,
            image.visionRevisions?.preprocessing ?? null,
            image.disposition === 'analysed' ? new Date() : null,
            image.lastErrorCode ?? null,
            image.disposition === 'skipped' ? 0 : 1,
          ],
        );
        if (image.disposition === 'analysed' && image.visionCacheKey !== undefined) {
          await database.query(
            `UPDATE noderag.vision_cache
             SET refcount = refcount + 1, last_used_at = now()
             WHERE cache_key = $1`,
            [Buffer.from(image.visionCacheKey, 'hex')],
          );
        }
      }
    }
    const build = await database.query<{ id: unknown }>(
      `SELECT build.id
       FROM noderag.silo_build_state state
       JOIN noderag.build build ON build.id=state.build_id
       WHERE state.silo_id=$1 AND state.state='active'`,
      [job.siloId],
    );
    const buildId = databaseInteger(build.rows[0]?.id, 'active build id');
    if ((job.kind === 'vision' && !awaitingVision) || job.kind === 'extract') {
      const removed = await database.query<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM noderag.chunk
           WHERE silo_id = $1 AND document_id = $2 AND build_id = $3
           RETURNING chunk_sha256
         ), decremented AS (
           UPDATE noderag.embedding_cache cache
           SET refcount = GREATEST(0, cache.refcount - grouped.uses)
           FROM (
             SELECT chunk_sha256, count(*)::integer AS uses
             FROM deleted GROUP BY chunk_sha256
           ) grouped
           WHERE cache.chunk_sha256 = grouped.chunk_sha256
             AND cache.model_manifest_id = (
               SELECT model_manifest_id FROM noderag.build WHERE id = $3
             )
         )
         SELECT count(*)::text AS count FROM deleted`,
        [job.siloId, job.documentId, buildId],
      );
      const removedChunks = Number(removed.rows[0]?.count ?? 0);
      if (removedChunks > 0) {
        await database.query(
          `UPDATE noderag.build
           SET chunk_count = GREATEST(0, COALESCE(chunk_count, 0) - $2)
           WHERE id = $1`,
          [buildId, removedChunks],
        );
      }
    }
    if (extracted.markdown.length > 0 && (!awaitingVision || job.kind === 'extract')) {
      await database.query(
        `INSERT INTO noderag.job (kind, document_id, silo_id, build_id, priority, payload)
         VALUES ('embed', $1, $2, $3, 4, jsonb_build_object('format', $4::text))
         ON CONFLICT (document_id, kind)
           WHERE document_id IS NOT NULL
             AND state IN ('pending', 'leased', 'retry_wait', 'paused')
         DO NOTHING`,
        [job.documentId, job.siloId, buildId, format],
      );
    }
    if (awaitingVision && job.kind === 'extract' && vision !== undefined) {
      await database.query(
        `INSERT INTO noderag.job
           (kind, document_id, silo_id, build_id, priority, max_attempts, payload)
         VALUES ('vision', $1, $2, $3, 3, 5,
                 jsonb_build_object('format', $4::text, 'reason', 'pending-vision'))
         ON CONFLICT (document_id, kind)
           WHERE document_id IS NOT NULL
             AND state IN ('pending', 'leased', 'retry_wait', 'paused')
         DO NOTHING`,
        [job.documentId, job.siloId, buildId, format],
      );
    }
    if (job.kind === 'vision' && awaitingVision) {
      retryVision = true;
      return;
    }
    if (awaitingVision) {
      await completeJob(database, job, {
        characters: extracted.markdown.length,
        canonicalBytes: canonical.bytes,
        pages: extracted.pages.length,
        awaitingVision: true,
      });
      return;
    }
    await completeJob(database, job, {
      characters: extracted.markdown.length,
      canonicalBytes: canonical.bytes,
      pages: extracted.pages.length,
      warnings: extracted.warnings,
      visionRecovered: job.kind === 'vision',
    });
  });
  if (retryVision) {
    throw new ClassifiedJobError(
      'vision-analysis-pending',
      'transient',
      'Vision analysis remains pending after this attempt.',
    );
  }
};

interface BuildProfileRow {
  readonly build_id: unknown;
  readonly model_manifest_id: unknown;
  readonly model_digest: string;
  readonly dimensions: number;
  readonly target_chars: number;
  readonly overlap_chars: number;
  readonly max_tokens: number;
  readonly snap_window: string | number;
  readonly heading_prefix: boolean;
  readonly markdown_sha256: Buffer;
}

interface DocumentPageRangeRow {
  readonly page_number: number | null;
  readonly character_start: number;
  readonly character_end: number;
}

const vectorLiteral = (vector: readonly number[], dimensions: number): string => {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('invalid-embedding-vector');
  }
  return `[${vector.map((value) => String(value)).join(',')}]`;
};

const parseVector = (literal: string, dimensions: number): readonly number[] => {
  if (!literal.startsWith('[') || !literal.endsWith(']')) throw new Error('invalid-cached-vector');
  const values = literal.slice(1, -1).split(',').map(Number);
  if (values.length !== dimensions || values.some((value) => !Number.isFinite(value))) {
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
): Promise<void> => {
  if (job.documentId === null || job.siloId === null || job.buildId === null) {
    throw new Error('embed-job-missing-scope');
  }
  const configuredTarget = job.frozenConfig['stagingTable'];
  const targetTable =
    typeof configuredTarget === 'string' && /^chunk_stage_b\d+_s\d+$/u.test(configuredTarget)
      ? configuredTarget
      : null;
  const chunkRelation = targetTable === null ? 'noderag.chunk' : `noderag.${targetTable}`;
  await heartbeatJob(pool, job, 60_000, { stage: 'prepare-embedding' }, { stage: 'embed' });
  const profile = await withTransaction(pool, async (database) => {
    await setWorkerScope(database, job.siloId ?? 0);
    const found = await database.query<BuildProfileRow>(
      `SELECT b.id AS build_id, b.model_manifest_id, b.model_digest, b.dimensions,
              b.target_chars, b.overlap_chars,
              b.max_tokens, b.snap_window, b.heading_prefix, d.markdown_sha256
       FROM noderag.build b
       JOIN noderag.document d ON d.id = $1 AND d.silo_id = $2
       JOIN noderag.document_page p ON p.document_id = $1 AND p.silo_id = $2 AND p.ordinal = 0
       WHERE b.id = $3 AND b.state IN ('active','building')`,
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
  const pageRanges = await withTransaction(pool, async (database) => {
    await setWorkerScope(database, job.siloId ?? 0);
    const result = await database.query<DocumentPageRangeRow>(
      `SELECT page_number, character_start, character_end
       FROM noderag.document_page
       WHERE document_id = $1 AND silo_id = $2
       ORDER BY ordinal`,
      [job.documentId, job.siloId],
    );
    return result.rows;
  });
  const activeEmbedder = coordinatedEmbedder(
    pool,
    `job:${String(job.id)}:${String(job.leaseEpoch)}`,
    embedder,
  );
  const selectedModel = {
    manifestDigest: profile.model_digest,
    dimensions: profile.dimensions,
  };
  const buildEmbedder: Embedder = {
    countTokens: (texts, priority) => activeEmbedder.countTokens(texts, priority, selectedModel),
    embed: (texts, maximumTokens, priority) =>
      activeEmbedder.embed(texts, maximumTokens, priority, selectedModel),
  };
  const candidates = chunkCanonicalMarkdown(markdown, {
    targetCharacters: profile.target_chars,
    overlapCharacters: profile.overlap_chars,
    snapWindow: Number(profile.snap_window),
    headingPrefix: profile.heading_prefix,
  });
  const guarded = await enforceTokenGuard(markdown, candidates, profile.max_tokens, buildEmbedder);
  if (guarded.length === 0) throw new Error('no-chunks-produced');

  const prepared: PreparedChunk[] = [];
  const misses: Array<{ readonly chunk: GuardedChunk; readonly sha256: Buffer }> = [];
  for (const chunk of guarded) {
    const sha256 = createHash('sha256').update(chunk.embeddingText, 'utf8').digest();
    const cached = await pool.query<{ embedding: string }>(
      `SELECT embedding::text AS embedding FROM noderag.embedding_cache
       WHERE chunk_sha256 = $1 AND model_manifest_id = $2 AND dimensions = $3`,
      [sha256, modelManifestId, profile.dimensions],
    );
    const row = cached.rows[0];
    if (row === undefined) misses.push({ chunk, sha256 });
    else
      prepared.push({
        ...chunk,
        sha256,
        vector: parseVector(row.embedding, profile.dimensions),
      });
  }
  for (let offset = 0; offset < misses.length; offset += 16) {
    const batch = misses.slice(offset, offset + 16);
    const result = await buildEmbedder.embed(
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
    await heartbeatJob(pool, job, 60_000, {
      stage: 'embedding',
      embedded: Math.min(offset + batch.length, misses.length),
      total: misses.length,
    });
  }
  prepared.sort((left, right) => left.ordinal - right.ordinal);

  await withTransaction(pool, async (database) => {
    await setWorkerScope(database, job.siloId ?? 0);
    const existing = await database.query(
      `SELECT 1 FROM ${chunkRelation}
       WHERE silo_id = $1 AND document_id = $2 AND build_id = $3 LIMIT 1`,
      [job.siloId, job.documentId, buildId],
    );
    if ((existing.rowCount ?? 0) > 0) throw new Error('document-build-already-indexed');
    const activeReferenceIncrement = targetTable === null ? 1 : 0;
    for (const chunk of prepared) {
      const embedding = vectorLiteral(chunk.vector, profile.dimensions);
      const pages = pageRanges
        .filter(
          (page) =>
            page.page_number !== null &&
            page.character_end > chunk.characterStart &&
            page.character_start < chunk.characterEnd,
        )
        .map((page) => page.page_number as number);
      const pageStart = pages.length === 0 ? null : Math.min(...pages);
      const pageEnd = pages.length === 0 ? null : Math.max(...pages);
      await database.query(
        `INSERT INTO noderag.embedding_cache
           (chunk_sha256, model_manifest_id, dimensions, embedding, refcount)
         VALUES ($1, $2, $3, $4::halfvec, $5)
         ON CONFLICT (chunk_sha256, model_manifest_id)
         DO UPDATE SET refcount = noderag.embedding_cache.refcount + $5,
                       last_used_at = now()`,
        [chunk.sha256, modelManifestId, profile.dimensions, embedding, activeReferenceIncrement],
      );
      await database.query(
        `INSERT INTO ${chunkRelation}
           (silo_id, document_id, build_id, ordinal, text, page_start, page_end,
            character_start, character_end, byte_start, byte_end, embedding,
            token_count, heading_path, chunk_sha256, part_of, structure_kind,
            structure_kinds, continuation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12::halfvec, $13, $14, $15, 'document', $16, $17, $18)`,
        [
          job.siloId,
          job.documentId,
          buildId,
          chunk.ordinal,
          chunk.text,
          pageStart,
          pageEnd,
          chunk.characterStart,
          chunk.characterEnd,
          chunk.byteStart,
          chunk.byteEnd,
          embedding,
          chunk.tokenCount,
          chunk.headingPath,
          chunk.sha256,
          chunk.structureKind,
          chunk.structureKinds,
          chunk.continuation,
        ],
      );
    }
    if (targetTable === null) {
      await database.query(
        `UPDATE noderag.document
         SET state = CASE WHEN EXISTS (
               SELECT 1 FROM noderag.document_image image
               WHERE image.document_id = $1 AND image.state = 'pending_vision'
             ) THEN 'awaiting_vision' ELSE 'ready' END,
             indexed_at = now()
         WHERE id = $1 AND silo_id = $2`,
        [job.documentId, job.siloId],
      );
    } else {
      const embeddedTextDigest = createHash('sha256')
        .update(prepared.map((chunk) => chunk.embeddingText).join('\u0000'), 'utf8')
        .digest();
      await database.query(
        `INSERT INTO noderag.build_document_checkpoint
           (build_id,silo_id,document_id,markdown_sha256,embedded_text_digest,
            model_manifest_digest,chunk_count,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,'complete')
         ON CONFLICT(build_id,silo_id,document_id) DO UPDATE
         SET markdown_sha256=EXCLUDED.markdown_sha256,
             embedded_text_digest=EXCLUDED.embedded_text_digest,
             model_manifest_digest=EXCLUDED.model_manifest_digest,
             chunk_count=EXCLUDED.chunk_count,state='complete',completed_at=now()`,
        [
          buildId,
          job.siloId,
          job.documentId,
          markdownSha256,
          embeddedTextDigest,
          profile.model_digest,
          prepared.length,
        ],
      );
      await database.query(
        `UPDATE noderag.silo_build_state state
         SET processed_documents=checkpoint.count,
             checkpoint_documents=checkpoint.count,updated_at=now()
         FROM (SELECT count(*)::bigint AS count
               FROM noderag.build_document_checkpoint
               WHERE build_id=$1 AND silo_id=$2 AND state='complete') checkpoint
         WHERE state.build_id=$1 AND state.silo_id=$2`,
        [buildId, job.siloId],
      );
    }
    await database.query(
      `UPDATE noderag.build
       SET chunk_count = COALESCE(chunk_count, 0) + $2
       WHERE id = $1`,
      [buildId, prepared.length],
    );
    await completeJob(database, job, { chunks: prepared.length, buildId });
    await database.query(
      `INSERT INTO noderag.audit_log (silo_id, action, result, row_count, detail)
       VALUES ($1, $5, 'ok', $2,
               jsonb_build_object('documentId', $3::bigint, 'buildId', $4::int))`,
      [
        job.siloId,
        prepared.length,
        job.documentId,
        buildId,
        targetTable === null ? 'document.index' : 'build.document_checkpoint',
      ],
    );
  });
};

export interface DocumentWorkerOptions {
  readonly pool: Pool;
  readonly files: DocumentFileStore;
  readonly embedder: Embedder;
  readonly leaseOwner: string;
  readonly sourceRoots?: readonly string[];
  readonly vision?: InjectedVision;
  readonly visionFactory?: () => Promise<InjectedVision | undefined>;
}

export const processOneDocumentJob = async (options: DocumentWorkerOptions): Promise<boolean> => {
  const job = await claimNextJob(options.pool, options.leaseOwner);
  if (job === null) return false;
  try {
    if (job.kind === 'extract' || job.kind === 'vision') {
      const vision = options.vision ?? (await options.visionFactory?.());
      await extractCanonicalDocument(options.pool, options.files, job, vision);
    } else if (job.kind === 'embed')
      await embedMarkdown(options.pool, options.files, options.embedder, job);
    else if (job.kind === 'crawl')
      await crawlSource({
        pool: options.pool,
        files: options.files,
        job,
        allowedRoots: options.sourceRoots ?? [],
      });
    else if (job.kind === 'verify') await runIntegrityJob(options.pool, options.files, job);
    else throw new Error(`unsupported-worker-job:${job.kind}`);
  } catch (error) {
    await failJob(options.pool, job, error);
  }
  return true;
};

export const drainDocumentJobs = async (
  options: DocumentWorkerOptions,
  maximumJobs = 100,
): Promise<number> => {
  let processed = 0;
  while (processed < maximumJobs && (await processOneDocumentJob(options))) processed += 1;
  return processed;
};

export type MarkdownWorkerOptions = DocumentWorkerOptions;
export const processOneMarkdownJob = processOneDocumentJob;
export const drainMarkdownJobs = drainDocumentJobs;
