import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chunkCanonicalMarkdown, type Embedder } from '@noderag/shared';
import type { Pool } from 'pg';
import {
  extractDocument,
  type DocumentFormat,
  type ExtractionProgress,
  type InjectedVision,
} from '../extract/index.js';
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

const payloadRecord = (payload: unknown): Readonly<Record<string, unknown>> =>
  typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Readonly<Record<string, unknown>>)
    : {};

const replacesSearchableDocument = (job: ClaimedJob): boolean =>
  payloadRecord(job.payload)['replaceExisting'] === true;

const initialEmbeddingBatchSize = 2;
const maximumEmbeddingBatchSize = 16;
const targetEmbeddingBatchMilliseconds = 20_000;
const activeEmbeddingHeartbeatMilliseconds = 20_000;

const waitWithProgress = async <Value>(
  operation: Promise<Value>,
  onProgress: () => Promise<void>,
): Promise<Value> => {
  type Outcome =
    | { readonly state: 'resolved'; readonly value: Value }
    | { readonly state: 'rejected'; readonly error: unknown };
  const settled: Promise<Outcome> = operation.then(
    (value) => ({ state: 'resolved', value }),
    (error: unknown) => ({ state: 'rejected', error }),
  );
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      settled,
      new Promise<null>((resolve) => {
        timer = setTimeout(resolve, activeEmbeddingHeartbeatMilliseconds, null);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === null) {
      await onProgress();
      continue;
    }
    if (outcome.state === 'rejected') throw outcome.error;
    return outcome.value;
  }
};

export const nextEmbeddingBatchSize = (
  currentSize: number,
  elapsedMilliseconds: number,
  remainingPassages: number,
): number => {
  if (remainingPassages <= 0) return 0;
  const current = Math.max(1, Math.min(maximumEmbeddingBatchSize, Math.round(currentSize)));
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds <= 0) {
    return Math.min(current, remainingPassages);
  }
  const projected = Math.max(
    1,
    Math.min(
      maximumEmbeddingBatchSize,
      Math.round((current * targetEmbeddingBatchMilliseconds) / elapsedMilliseconds),
    ),
  );
  const next =
    elapsedMilliseconds > targetEmbeddingBatchMilliseconds * 1.25
      ? Math.min(current - 1, projected)
      : elapsedMilliseconds < targetEmbeddingBatchMilliseconds * 0.6
        ? Math.max(current + 1, projected)
        : current;
  return Math.max(1, Math.min(maximumEmbeddingBatchSize, remainingPassages, next));
};

export interface MarkdownQualityAssessment {
  readonly replacementCharacters: number;
  readonly controlCharacters: number;
  readonly mojibakeIndicators: number;
  readonly noisyLines: number;
  readonly repeatedLinePatterns: number;
  readonly warningCodes: readonly string[];
}

export const assessMarkdownQuality = (markdown: string): MarkdownQualityAssessment => {
  const lines = markdown.split(/\r?\n/u);
  const repeatedLines = new Map<string, number>();
  let noisyLines = 0;
  for (const line of lines) {
    const normalized = line.trim().replace(/\s+/gu, ' ');
    if (normalized.length >= 16 && normalized.length <= 240) {
      repeatedLines.set(normalized, (repeatedLines.get(normalized) ?? 0) + 1);
    }
    const nonWhitespace = normalized.match(/\S/gu)?.length ?? 0;
    const alphanumeric = normalized.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    if (nonWhitespace >= 24 && alphanumeric / nonWhitespace < 0.2) noisyLines += 1;
  }
  const replacementCharacters = markdown.match(/\uFFFD/gu)?.length ?? 0;
  const controlCharacters = [...markdown].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 && character !== '\n' && character !== '\r' && character !== '\t';
  }).length;
  const mojibakeIndicators = markdown.match(/(?:Ã.|Â.|â€|ï¿½)/gu)?.length ?? 0;
  const repeatedLinePatterns = [...repeatedLines.values()].filter((count) => count >= 5).length;
  const warningCodes: string[] = [];
  if (replacementCharacters > 0) warningCodes.push('replacement-characters');
  if (controlCharacters > 0) warningCodes.push('unexpected-control-characters');
  if (mojibakeIndicators > 0) warningCodes.push('possible-mojibake');
  if (noisyLines >= Math.max(3, Math.ceil(lines.length * 0.05)))
    warningCodes.push('symbol-heavy-lines');
  if (repeatedLinePatterns > 0) warningCodes.push('repeated-lines');
  return {
    replacementCharacters,
    controlCharacters,
    mojibakeIndicators,
    noisyLines,
    repeatedLinePatterns,
    warningCodes,
  };
};

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
  const progressStartedAt = Date.now();
  let lastProgressPercent = -1;
  let lastProgressAt = 0;
  const reportExtractionProgress = async (progress: ExtractionProgress): Promise<void> => {
    const [base, span] =
      progress.stage === 'extracting-pages'
        ? [5, 45]
        : progress.stage === 'classifying-layout'
          ? [50, 15]
          : progress.stage === 'analysing-pages'
            ? [65, 10]
            : [75, 5];
    const percent = Math.min(
      base + span,
      base + Math.round((span * progress.completed) / Math.max(1, progress.total)),
    );
    const now = Date.now();
    if (percent === lastProgressPercent && now - lastProgressAt < 2_000) return;
    lastProgressPercent = percent;
    lastProgressAt = now;
    await heartbeatJob(pool, job, 60_000, {
      stage: progress.stage,
      percent,
      pagesCompleted: progress.completed,
      pagesTotal: progress.total,
      elapsedMs: now - progressStartedAt,
      ...(progress.routing ?? {}),
    });
  };
  await heartbeatJob(
    pool,
    job,
    60_000,
    { stage: 'read-original', percent: 1, stageStartedAt: new Date().toISOString() },
    { stage: 'extract' },
  );
  const document = await withTransaction(pool, async (database) => {
    await setWorkerScope(database, job.siloId ?? 0);
    const found = await database.query<{
      extension: string;
      original_sha256: Buffer;
      state: string;
    }>(
      `SELECT extension, original_sha256, state FROM noderag.document
       WHERE id = $1 AND silo_id = $2 FOR UPDATE`,
      [job.documentId, job.siloId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new Error('document-not-found');
    return row;
  });
  const format = documentFormat(document.extension);
  const replaceExisting = replacesSearchableDocument(job);
  const original = await readFile(files.paths(job.documentId, format).originalAbsolute);
  await heartbeatJob(pool, job, 60_000, {
    stage: 'validating-original',
    percent: 5,
    bytesTotal: original.byteLength,
    elapsedMs: Date.now() - progressStartedAt,
  });
  const actualOriginalHash = createHash('sha256').update(original).digest();
  if (!actualOriginalHash.equals(document.original_sha256))
    throw new Error('original-hash-mismatch');
  const extracted = await extractDocument(
    original,
    format,
    { onProgress: reportExtractionProgress },
    vision,
  );
  await heartbeatJob(pool, job, 60_000, {
    stage: 'assembling-document',
    percent: 85,
    pagesCompleted: extracted.pages.length,
    pagesTotal: extracted.pages.length,
    elapsedMs: Date.now() - progressStartedAt,
  });
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
  await heartbeatJob(pool, job, 60_000, {
    stage: 'saving-extraction',
    percent: 90,
    pagesCompleted: extracted.pages.length,
    pagesTotal: extracted.pages.length,
    elapsedMs: Date.now() - progressStartedAt,
  });

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
        replaceExisting ? document.state : awaitingVision ? 'awaiting_vision' : 'extracting',
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
      for (const block of page.blocks) {
        await database.query(
          `INSERT INTO noderag.document_block
             (document_id, silo_id, page_ordinal, ordinal, kind, source, native_text, markdown,
              reading_order, bound_x, bound_y, bound_width, bound_height,
              character_start, character_end, byte_start, byte_end,
              text_confidence, reading_order_confidence, structure_confidence,
              combined_confidence, warning_codes, confidence_components,
              parser_revision, layout_policy_revision, confidence_policy_revision,
              vision_prompt_revision, vision_schema_revision, preprocessing_revision,
              model_revision)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb,
                   $24, $25, $26, $27, $28, $29, $30)`,
          [
            job.documentId,
            job.siloId,
            page.ordinal,
            block.ordinal,
            block.kind,
            block.source,
            block.text,
            block.markdown,
            block.readingOrder,
            block.bounds?.x ?? null,
            block.bounds?.y ?? null,
            block.bounds?.width ?? null,
            block.bounds?.height ?? null,
            block.characterStart,
            block.characterEnd,
            block.byteStart,
            block.byteEnd,
            block.confidence.text,
            block.confidence.readingOrder,
            block.confidence.structure,
            block.confidence.combined,
            block.warnings,
            JSON.stringify({
              scores: block.confidence,
              components: block.confidence.components ?? {},
              routing: block.routing ?? {
                disposition: 'native-safe',
                reasons: ['legacy-compatible-default'],
              },
            }),
            block.revisions.parser,
            block.revisions.layout,
            block.revisions.confidence,
            block.revisions.visionPrompt ?? null,
            block.revisions.visionSchema ?? null,
            block.revisions.preprocessing ?? null,
            block.revisions.model ?? null,
          ],
        );
      }
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
    if (
      !replaceExisting &&
      ((job.kind === 'vision' && !awaitingVision) || job.kind === 'extract')
    ) {
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
         VALUES ('embed', $1, $2, $3, 4,
                 jsonb_build_object(
                   'format', $4::text,
                   'replaceExisting', $5::boolean,
                   'reason', CASE WHEN $5::boolean
                                  THEN 'enhanced-pdf-reindex' ELSE 'ingestion' END,
                   'previousDocumentState', $6::text))
         ON CONFLICT (document_id, kind)
           WHERE document_id IS NOT NULL
             AND state IN ('pending', 'leased', 'retry_wait', 'paused')
         DO UPDATE SET payload = EXCLUDED.payload, state = 'pending', run_after = now(),
                       retry_at = NULL, updated_at = now()`,
        [job.documentId, job.siloId, buildId, format, replaceExisting, document.state],
      );
    }
    if (awaitingVision && job.kind === 'extract' && vision !== undefined) {
      await database.query(
        `INSERT INTO noderag.job
           (kind, document_id, silo_id, build_id, priority, max_attempts, payload)
         VALUES ('vision', $1, $2, $3, 3, 5,
                 jsonb_build_object(
                   'format', $4::text,
                   'reason', CASE WHEN $5::boolean
                                  THEN 'enhanced-pdf-reindex' ELSE 'pending-vision' END,
                   'replaceExisting', $5::boolean,
                   'previousDocumentState', $6::text))
         ON CONFLICT (document_id, kind)
           WHERE document_id IS NOT NULL
             AND state IN ('pending', 'leased', 'retry_wait', 'paused')
         DO UPDATE SET payload = EXCLUDED.payload, state = 'pending', run_after = now(),
                       retry_at = NULL, updated_at = now()`,
        [job.documentId, job.siloId, buildId, format, replaceExisting, document.state],
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
  const replaceExisting = targetTable === null && replacesSearchableDocument(job);
  const chunkRelation = targetTable === null ? 'noderag.chunk' : `noderag.${targetTable}`;
  const progressStartedAt = Date.now();
  await heartbeatJob(
    pool,
    job,
    60_000,
    { stage: 'chunking', percent: 0, stageStartedAt: new Date().toISOString() },
    { stage: 'embed' },
  );
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
  await heartbeatJob(pool, job, 60_000, {
    stage: 'chunking',
    percent: 20,
    operation: 'reading-canonical-markdown',
    elapsedMs: Date.now() - progressStartedAt,
  });
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
  const markdownQuality = assessMarkdownQuality(markdown);
  const candidates = chunkCanonicalMarkdown(markdown, {
    targetCharacters: profile.target_chars,
    overlapCharacters: profile.overlap_chars,
    snapWindow: Number(profile.snap_window),
    headingPrefix: profile.heading_prefix,
  });
  await heartbeatJob(pool, job, 60_000, {
    stage: 'chunking',
    percent: 55,
    operation: 'forming-passages',
    chunksCompleted: candidates.length,
    chunksTotal: candidates.length,
    elapsedMs: Date.now() - progressStartedAt,
  });
  const guarded = await enforceTokenGuard(markdown, candidates, profile.max_tokens, buildEmbedder);
  if (guarded.length === 0) throw new Error('no-chunks-produced');
  const suspectedNoisyPassages = guarded.filter(
    (chunk) =>
      chunk.embeddingText.length >= 100 &&
      chunk.tokenCount / Math.max(1, chunk.embeddingText.length) >= 0.65,
  ).length;
  const qualityWarningCodes = [
    ...markdownQuality.warningCodes,
    ...(suspectedNoisyPassages > 0 ? ['token-dense-passages'] : []),
  ];
  const ingestionQuality = {
    ...markdownQuality,
    suspectedNoisyPassages,
    warningCodes: [...new Set(qualityWarningCodes)],
  };
  await heartbeatJob(pool, job, 60_000, {
    stage: 'chunking',
    percent: 100,
    operation: 'passages-ready',
    chunksCompleted: guarded.length,
    chunksTotal: guarded.length,
    suspectedNoisyPassages,
    qualityWarningCodes: ingestionQuality.warningCodes,
    elapsedMs: Date.now() - progressStartedAt,
  });
  await heartbeatJob(pool, job, 60_000, {
    stage: 'embedding',
    percent: 0,
    operation: 'checking-embedding-cache',
    stageStartedAt: new Date().toISOString(),
    chunksCompleted: null,
    chunksTotal: null,
    cacheChecked: 0,
    cacheTotal: guarded.length,
    embedded: 0,
    cached: 0,
    completed: 0,
    remaining: guarded.length,
    total: guarded.length,
    estimatedRemainingMs: null,
    elapsedMs: 0,
  });
  const embeddingStartedAt = Date.now();

  const prepared: PreparedChunk[] = [];
  const misses: Array<{ readonly chunk: GuardedChunk; readonly sha256: Buffer }> = [];
  for (const [chunkIndex, chunk] of guarded.entries()) {
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
    if ((chunkIndex + 1) % 25 === 0 || chunkIndex + 1 === guarded.length) {
      await heartbeatJob(pool, job, 60_000, {
        stage: 'embedding',
        percent: Math.round((15 * (chunkIndex + 1)) / guarded.length),
        operation: 'checking-embedding-cache',
        cacheChecked: chunkIndex + 1,
        cacheTotal: guarded.length,
        cached: prepared.length,
        completed: prepared.length,
        remaining: guarded.length - prepared.length,
        total: guarded.length,
        elapsedMs: Date.now() - embeddingStartedAt,
      });
    }
  }
  const cachedPassages = prepared.length;
  if (misses.length === 0) {
    await heartbeatJob(pool, job, 60_000, {
      stage: 'embedding',
      percent: 85,
      operation: 'using-cached-embeddings',
      embedded: 0,
      cached: cachedPassages,
      completed: guarded.length,
      remaining: 0,
      total: guarded.length,
      estimatedRemainingMs: 0,
      elapsedMs: Date.now() - embeddingStartedAt,
    });
  }
  let embeddedPassages = 0;
  let embeddedTokens = 0;
  const totalEmbeddingTokens = misses.reduce((total, item) => total + item.chunk.tokenCount, 0);
  const modelEmbeddingStartedAt = Date.now();
  let adaptiveBatchSize = Math.min(initialEmbeddingBatchSize, misses.length);
  while (embeddedPassages < misses.length) {
    const batchSize = Math.min(adaptiveBatchSize, misses.length - embeddedPassages);
    const batch = misses.slice(embeddedPassages, embeddedPassages + batchSize);
    const elapsedBeforeBatch = Date.now() - modelEmbeddingStartedAt;
    const millisecondsPerToken = embeddedTokens > 0 ? elapsedBeforeBatch / embeddedTokens : null;
    const estimatedRemainingMilliseconds =
      millisecondsPerToken === null
        ? null
        : Math.ceil((totalEmbeddingTokens - embeddedTokens) * millisecondsPerToken);
    await heartbeatJob(pool, job, 60_000, {
      stage: 'embedding',
      percent: 15 + Math.round((70 * embeddedPassages) / misses.length),
      operation: 'generating-embeddings',
      chunksCompleted: null,
      chunksTotal: null,
      embedded: embeddedPassages,
      cached: cachedPassages,
      completed: cachedPassages + embeddedPassages,
      remaining: misses.length - embeddedPassages,
      total: guarded.length,
      currentBatchStart: embeddedPassages + 1,
      currentBatchEnd: embeddedPassages + batch.length,
      currentBatchTotal: misses.length,
      batchSize: batch.length,
      tokensCompleted: embeddedTokens,
      tokensTotal: totalEmbeddingTokens,
      estimatedRemainingMs: estimatedRemainingMilliseconds,
      expectedHeartbeatMs: 90_000,
      elapsedMs: Date.now() - embeddingStartedAt,
    });
    const batchStartedAt = Date.now();
    const result = await waitWithProgress(
      buildEmbedder.embed(
        batch.map((item) => item.chunk.embeddingText),
        profile.max_tokens,
        4,
      ),
      async () =>
        heartbeatJob(pool, job, 60_000, {
          stage: 'embedding',
          percent: 15 + Math.round((70 * embeddedPassages) / misses.length),
          operation: 'generating-embeddings',
          chunksCompleted: null,
          chunksTotal: null,
          embedded: embeddedPassages,
          cached: cachedPassages,
          completed: cachedPassages + embeddedPassages,
          remaining: misses.length - embeddedPassages,
          total: guarded.length,
          currentBatchStart: embeddedPassages + 1,
          currentBatchEnd: embeddedPassages + batch.length,
          currentBatchTotal: misses.length,
          batchSize: batch.length,
          tokensCompleted: embeddedTokens,
          tokensTotal: totalEmbeddingTokens,
          activeBatchElapsedMs: Date.now() - batchStartedAt,
          estimatedRemainingMs: estimatedRemainingMilliseconds,
          expectedHeartbeatMs: 90_000,
          elapsedMs: Date.now() - embeddingStartedAt,
        }),
    );
    const generated: PreparedChunk[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      const vector = result.vectors[index];
      const tokenCount = result.tokenCounts[index];
      if (item === undefined || vector === undefined || tokenCount === undefined) {
        throw new Error('embedder-batch-cardinality-mismatch');
      }
      if (tokenCount > profile.max_tokens) throw new Error('TOKEN_LIMIT');
      generated.push({ ...item.chunk, tokenCount, sha256: item.sha256, vector });
    }
    const persisted = await withTransaction(pool, async (database) => {
      const values: PreparedChunk[] = [];
      for (const item of generated) {
        const stored = await database.query<{ embedding: string }>(
          `INSERT INTO noderag.embedding_cache
             (chunk_sha256, model_manifest_id, dimensions, embedding, refcount)
           VALUES ($1, $2, $3, $4::halfvec, 0)
           ON CONFLICT (chunk_sha256, model_manifest_id)
           DO UPDATE SET last_used_at = now()
           RETURNING embedding::text AS embedding`,
          [
            item.sha256,
            modelManifestId,
            profile.dimensions,
            vectorLiteral(item.vector, profile.dimensions),
          ],
        );
        const storedVector = stored.rows[0]?.embedding;
        if (storedVector === undefined) throw new Error('embedding-cache-write-failed');
        values.push({
          ...item,
          vector: parseVector(storedVector, profile.dimensions),
        });
      }
      return values;
    });
    prepared.push(...persisted);
    const batchElapsedMilliseconds = Math.max(1, Date.now() - batchStartedAt);
    embeddedPassages += batch.length;
    embeddedTokens += generated.reduce((total, item) => total + item.tokenCount, 0);
    const modelElapsedMilliseconds = Math.max(1, Date.now() - modelEmbeddingStartedAt);
    const remainingPassages = misses.length - embeddedPassages;
    const measuredMillisecondsPerToken = modelElapsedMilliseconds / Math.max(1, embeddedTokens);
    const estimatedRemainingMs = Math.ceil(
      (totalEmbeddingTokens - embeddedTokens) * measuredMillisecondsPerToken,
    );
    adaptiveBatchSize = nextEmbeddingBatchSize(
      batch.length,
      batchElapsedMilliseconds,
      remainingPassages,
    );
    await heartbeatJob(pool, job, 60_000, {
      stage: 'embedding',
      percent: 15 + Math.round((70 * embeddedPassages) / misses.length),
      operation: 'generating-embeddings',
      embedded: embeddedPassages,
      cached: cachedPassages,
      completed: cachedPassages + embeddedPassages,
      remaining: remainingPassages,
      total: guarded.length,
      currentBatchStart: null,
      currentBatchEnd: null,
      currentBatchTotal: misses.length,
      batchSize: adaptiveBatchSize,
      lastBatchSize: batch.length,
      lastBatchElapsedMs: batchElapsedMilliseconds,
      tokensCompleted: embeddedTokens,
      tokensTotal: totalEmbeddingTokens,
      tokensPerSecond: Number((embeddedTokens / (modelElapsedMilliseconds / 1000)).toFixed(1)),
      passagesPerMinute: Number(
        ((embeddedPassages * 60_000) / modelElapsedMilliseconds).toFixed(1),
      ),
      estimatedRemainingMs,
      expectedHeartbeatMs: Math.max(
        90_000,
        Math.min(
          600_000,
          Math.ceil(
            batchElapsedMilliseconds *
              (Math.max(1, adaptiveBatchSize) / Math.max(1, batch.length)) *
              3,
          ) + 30_000,
        ),
      ),
      elapsedMs: Date.now() - embeddingStartedAt,
    });
  }
  prepared.sort((left, right) => left.ordinal - right.ordinal);

  await heartbeatJob(pool, job, 60_000, {
    stage: 'embedding',
    percent: 90,
    operation: 'saving-search-index',
    chunksCompleted: null,
    chunksTotal: null,
    embedded: embeddedPassages,
    cached: cachedPassages,
    completed: prepared.length,
    remaining: 0,
    total: prepared.length,
    currentBatchStart: null,
    currentBatchEnd: null,
    estimatedRemainingMs: 0,
    elapsedMs: Date.now() - embeddingStartedAt,
  });

  await withTransaction(pool, async (database) => {
    await setWorkerScope(database, job.siloId ?? 0);
    const existing = await database.query(
      `SELECT 1 FROM ${chunkRelation}
       WHERE silo_id = $1 AND document_id = $2 AND build_id = $3 LIMIT 1`,
      [job.siloId, job.documentId, buildId],
    );
    if ((existing.rowCount ?? 0) > 0 && !replaceExisting)
      throw new Error('document-build-already-indexed');
    let replacedChunkCount = 0;
    if (replaceExisting) {
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
             AND cache.model_manifest_id = $4
         )
         SELECT count(*)::text AS count FROM deleted`,
        [job.siloId, job.documentId, buildId, modelManifestId],
      );
      replacedChunkCount = Number(removed.rows[0]?.count ?? 0);
    }
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
             indexed_at = now(),
             metadata = metadata || jsonb_build_object(
               'ingestionQuality', $3::jsonb,
               'enhancedReindex', CASE WHEN $4::boolean
                 THEN jsonb_build_object(
                   'state', 'active',
                   'pdfExtractionVersion', metadata #>>
                     '{extractionMetadata,pdfExtractionVersion}',
                   'activatedAt', now())
                 ELSE COALESCE(metadata->'enhancedReindex', 'null'::jsonb)
               END)
         WHERE id = $1 AND silo_id = $2`,
        [job.documentId, job.siloId, JSON.stringify(ingestionQuality), replaceExisting],
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
       SET chunk_count = GREATEST(0, COALESCE(chunk_count, 0) - $3) + $2
       WHERE id = $1`,
      [buildId, prepared.length, replacedChunkCount],
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
