import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createLocatorMap, sliceUtf8 } from '@noderag/shared';
import type { Pool } from 'pg';
import type { DocumentFileStore } from '../storage/document-files.js';
import { databaseInteger, withTransaction, type SqlClient } from '../store/database.js';
import { appendJobEvent, completeJob, type ClaimedJob } from '../store/jobs.js';

type FindingCategory =
  | 'locator_mismatch'
  | 'page_mismatch'
  | 'invalid_unicode'
  | 'missing_original'
  | 'missing_markdown'
  | 'original_hash_mismatch'
  | 'markdown_hash_mismatch'
  | 'orphan_file'
  | 'orphan_chunk'
  | 'invalid_embedding_cache_ref'
  | 'invalid_vision_cache_ref';

interface Finding {
  readonly category: FindingCategory;
  readonly identityKey: string;
  readonly siloId?: number;
  readonly documentId?: number;
  readonly chunkId?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

const locatorCategories: readonly FindingCategory[] = [
  'locator_mismatch',
  'page_mismatch',
  'invalid_unicode',
];
const storageCategories: readonly FindingCategory[] = [
  'missing_original',
  'missing_markdown',
  'original_hash_mismatch',
  'markdown_hash_mismatch',
  'orphan_file',
  'orphan_chunk',
  'invalid_embedding_cache_ref',
  'invalid_vision_cache_ref',
];

const recordFindings = async (
  database: SqlClient,
  categories: readonly FindingCategory[],
  findings: readonly Finding[],
): Promise<void> => {
  const keys = findings.map(({ identityKey, category }) => `${category}:${identityKey}`);
  await database.query(
    `UPDATE noderag.integrity_finding
     SET resolved_at = now()
     WHERE category = ANY ($1::text[]) AND resolved_at IS NULL
       AND NOT ((category || ':' || identity_key) = ANY ($2::text[]))`,
    [categories, keys],
  );
  for (const finding of findings) {
    await database.query(
      `INSERT INTO noderag.integrity_finding
         (silo_id, document_id, chunk_id, category, identity_key, detail)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (category, identity_key) DO UPDATE
       SET silo_id = EXCLUDED.silo_id, document_id = EXCLUDED.document_id,
           chunk_id = EXCLUDED.chunk_id, detail = EXCLUDED.detail,
           last_detected_at = now(), resolved_at = NULL`,
      [
        finding.siloId ?? null,
        finding.documentId ?? null,
        finding.chunkId ?? null,
        finding.category,
        finding.identityKey,
        finding.detail ?? {},
      ],
    );
  }
};

const hashFile = async (path: string): Promise<Buffer> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest();

const isWellFormedUtf16 = (text: string): boolean => {
  for (let offset = 0; offset < text.length; offset += 1) {
    const value = text.charCodeAt(offset);
    if (value >= 0xd800 && value <= 0xdbff) {
      const next = text.charCodeAt(offset + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      offset += 1;
    } else if (value >= 0xdc00 && value <= 0xdfff) return false;
  }
  return true;
};

export const verifyChunkLocators = async (
  pool: Pool,
  files: DocumentFileStore,
  samplePerSilo = 300,
): Promise<{ readonly sampled: number; readonly findings: number }> => {
  if (!Number.isInteger(samplePerSilo) || samplePerSilo < 1 || samplePerSilo > 10_000) {
    throw new Error('invalid-locator-sample-size');
  }
  const silos = await pool.query<{ id: number }>(
    `SELECT id FROM noderag.silo WHERE lifecycle_state = 'active' ORDER BY id`,
  );
  const findings: Finding[] = [];
  let sampled = 0;
  for (const { id: siloId } of silos.rows) {
    const chunks = await withTransaction(pool, async (database) => {
      await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [`{${String(siloId)}}`]);
      return database.query<{
        id: unknown;
        document_id: unknown;
        text: string;
        character_start: number;
        character_end: number;
        byte_start: number;
        byte_end: number;
        page_start: number | null;
        page_end: number | null;
        extension: string;
        markdown_sha256: Buffer;
        character_count: number;
        page_basis: string;
      }>(
        `SELECT c.id, c.document_id, c.text, c.character_start, c.character_end,
                c.byte_start, c.byte_end, c.page_start, c.page_end,
                d.extension, d.markdown_sha256, d.character_count, d.page_basis
         FROM noderag.chunk c
         JOIN noderag.document d ON d.id = c.document_id AND d.silo_id = c.silo_id
         WHERE c.silo_id = $1
         ORDER BY md5(c.id::text || ':' || c.document_id::text)
         LIMIT $2`,
        [siloId, samplePerSilo],
      );
    });
    const markdownByDocument = new Map<number, string>();
    for (const row of chunks.rows) {
      sampled += 1;
      const chunkId = databaseInteger(row.id, 'verified chunk id');
      const documentId = databaseInteger(row.document_id, 'verified document id');
      let markdown = markdownByDocument.get(documentId);
      if (markdown === undefined) {
        try {
          markdown = await readFile(
            files.paths(documentId, row.extension).markdownAbsolute,
            'utf8',
          );
          markdownByDocument.set(documentId, markdown);
        } catch {
          findings.push({
            category: 'missing_markdown',
            identityKey: String(documentId),
            siloId,
            documentId,
          });
          continue;
        }
      }
      const base = { siloId, documentId, chunkId, identityKey: `${siloId}:${chunkId}` };
      if (!isWellFormedUtf16(markdown) || !isWellFormedUtf16(row.text)) {
        findings.push({ ...base, category: 'invalid_unicode' });
        continue;
      }
      let characterSlice: string;
      let byteSlice: string;
      try {
        const locator = createLocatorMap(markdown);
        const expected = locator.range(row.character_start, row.character_end);
        characterSlice = markdown.slice(row.character_start, row.character_end);
        byteSlice = sliceUtf8(markdown, row.byte_start, row.byte_end);
        if (expected.byteStart !== row.byte_start || expected.byteEnd !== row.byte_end) {
          throw new Error('offset-pair-disagrees');
        }
      } catch (error) {
        findings.push({
          ...base,
          category: 'locator_mismatch',
          detail: { reason: error instanceof Error ? error.message : 'invalid-offset' },
        });
        continue;
      }
      if (characterSlice !== row.text || byteSlice !== row.text) {
        findings.push({
          ...base,
          category: 'locator_mismatch',
          detail: {
            characterSliceMatches: characterSlice === row.text,
            byteSliceMatches: byteSlice === row.text,
          },
        });
      }
      const pageValid =
        row.character_start >= 0 &&
        row.character_end <= row.character_count &&
        (row.page_basis === 'none'
          ? row.page_start === null && row.page_end === null
          : row.page_start !== null && row.page_end !== null);
      if (!pageValid) findings.push({ ...base, category: 'page_mismatch' });
    }
  }
  await withTransaction(pool, (database) => recordFindings(database, locatorCategories, findings));
  return { sampled, findings: findings.length };
};

export const sweepStorageIntegrity = async (
  pool: Pool,
  files: DocumentFileStore,
): Promise<{ readonly checkedDocuments: number; readonly findings: number }> => {
  const documents = await pool.query<{
    id: unknown;
    silo_id: number;
    extension: string;
    original_sha256: Buffer;
    markdown_sha256: Buffer | null;
  }>(
    `SELECT id, silo_id, extension, original_sha256, markdown_sha256
     FROM noderag.document ORDER BY id`,
  );
  const findings: Finding[] = [];
  const knownIds = new Set<number>();
  for (const row of documents.rows) {
    const documentId = databaseInteger(row.id, 'integrity document id');
    knownIds.add(documentId);
    const paths = files.paths(documentId, row.extension);
    try {
      if (!(await hashFile(paths.originalAbsolute)).equals(row.original_sha256)) {
        findings.push({
          category: 'original_hash_mismatch',
          identityKey: String(documentId),
          siloId: row.silo_id,
          documentId,
        });
      }
    } catch {
      findings.push({
        category: 'missing_original',
        identityKey: String(documentId),
        siloId: row.silo_id,
        documentId,
      });
    }
    if (row.markdown_sha256 !== null) {
      try {
        if (!(await hashFile(paths.markdownAbsolute)).equals(row.markdown_sha256)) {
          findings.push({
            category: 'markdown_hash_mismatch',
            identityKey: String(documentId),
            siloId: row.silo_id,
            documentId,
          });
        }
      } catch {
        findings.push({
          category: 'missing_markdown',
          identityKey: String(documentId),
          siloId: row.silo_id,
          documentId,
        });
      }
    }
  }
  for (const managedId of await files.managedDocumentIds()) {
    if (!knownIds.has(managedId)) {
      findings.push({
        category: 'orphan_file',
        identityKey: String(managedId),
        documentId: managedId,
      });
    }
  }
  const orphanChunks = await pool.query<{ id: unknown; silo_id: number; document_id: unknown }>(
    `SELECT c.id, c.silo_id, c.document_id
     FROM noderag.chunk c
     LEFT JOIN noderag.document d ON d.id = c.document_id AND d.silo_id = c.silo_id
     WHERE d.id IS NULL`,
  );
  for (const row of orphanChunks.rows) {
    const chunkId = databaseInteger(row.id, 'orphan chunk id');
    findings.push({
      category: 'orphan_chunk',
      identityKey: `${row.silo_id}:${chunkId}`,
      siloId: row.silo_id,
      documentId: databaseInteger(row.document_id, 'orphan chunk document id'),
      chunkId,
    });
  }
  const invalidEmbeddingRefs = await pool.query<{
    hash: string;
    model_manifest_id: number;
    refcount: number;
    expected: string;
  }>(
    `SELECT encode(cache.chunk_sha256, 'hex') AS hash, cache.model_manifest_id,
            cache.refcount, count(c.id)::text AS expected
     FROM noderag.embedding_cache cache
     LEFT JOIN noderag.build b ON b.model_manifest_id = cache.model_manifest_id
     LEFT JOIN noderag.chunk c ON c.build_id = b.id AND c.chunk_sha256 = cache.chunk_sha256
     GROUP BY cache.chunk_sha256, cache.model_manifest_id, cache.refcount
     HAVING cache.refcount <> count(c.id)`,
  );
  for (const row of invalidEmbeddingRefs.rows) {
    findings.push({
      category: 'invalid_embedding_cache_ref',
      identityKey: `${row.hash}:${row.model_manifest_id}`,
      detail: { actual: row.refcount, expected: Number(row.expected) },
    });
  }
  const invalidVisionRefs = await pool.query<{
    cache_key: string;
    model: string;
    refcount: number;
    expected: string;
  }>(
    `SELECT encode(cache.cache_key, 'hex') AS cache_key, cache.model, cache.refcount,
            count(image.id)::text AS expected
     FROM noderag.vision_cache cache
     LEFT JOIN noderag.document_image image
       ON image.cache_key = cache.cache_key
     GROUP BY cache.cache_key, cache.model, cache.refcount
     HAVING cache.refcount <> count(image.id)`,
  );
  for (const row of invalidVisionRefs.rows) {
    findings.push({
      category: 'invalid_vision_cache_ref',
      identityKey: `${row.cache_key}:${row.model}`,
      detail: { actual: row.refcount, expected: Number(row.expected) },
    });
  }
  await withTransaction(pool, (database) => recordFindings(database, storageCategories, findings));
  return { checkedDocuments: documents.rows.length, findings: findings.length };
};

export const runIntegrityJob = async (
  pool: Pool,
  files: DocumentFileStore,
  job: ClaimedJob,
): Promise<void> => {
  const locators = await verifyChunkLocators(pool, files);
  const storage = await sweepStorageIntegrity(pool, files);
  await withTransaction(pool, async (database) => {
    await completeJob(database, job, { locators, storage });
  });
};

export const enqueueNightlyIntegrityJob = async (pool: Pool): Promise<number | null> =>
  withTransaction(pool, async (database) => {
    const existing = await database.query(
      `SELECT 1 FROM noderag.job
       WHERE kind = 'verify'
         AND (state IN ('pending', 'leased', 'retry_wait', 'paused')
              OR (state = 'succeeded' AND finished_at > now() - interval '24 hours'))
       LIMIT 1`,
    );
    if ((existing.rowCount ?? 0) > 0) return null;
    const inserted = await database.query<{ id: unknown }>(
      `INSERT INTO noderag.job (kind, priority, payload)
       VALUES ('verify', 8, jsonb_build_object('schedule', 'nightly')) RETURNING id`,
    );
    const id = databaseInteger(inserted.rows[0]?.id, 'integrity job id');
    await appendJobEvent(database, id, 'queued', { schedule: 'nightly' });
    return id;
  });
