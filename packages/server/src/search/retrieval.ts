import { performance } from 'node:perf_hooks';
import type { Embedder } from '@noderag/shared';
import type { Pool } from 'pg';
import { hashNormalizedQuery, writeAuditEvent } from '../application/audit.js';
import { databaseInteger } from '../store/database.js';
import { coordinatedEmbedder } from '../store/resources.js';
import { withSiloScope, type SiloScope } from '../identity/scope.js';
import type { DocumentFileStore } from '../storage/document-files.js';

export type SearchMode = 'vector' | 'keyword' | 'hybrid';

export interface SearchFilters {
  readonly sourceIds?: readonly number[];
  readonly pathPrefix?: string;
  readonly formats?: readonly ('pdf' | 'docx' | 'xlsx' | 'txt' | 'md')[];
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
  readonly modifiedFrom?: Date;
  readonly modifiedTo?: Date;
  readonly pageFrom?: number;
  readonly pageTo?: number;
  readonly hasImages?: boolean;
  readonly hasTables?: boolean;
}

export interface SearchRequest {
  readonly query: string;
  readonly mode: SearchMode;
  readonly limit: number;
  readonly filters: SearchFilters;
}

export interface SearchLocator {
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly pageLabel: string;
  readonly pageBasis: string;
  readonly characterStart: number;
  readonly characterEnd: number;
  readonly characterUnit: 'utf16';
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly byteUnit: 'utf8';
  readonly offsetsMatchOriginal: boolean;
}

export interface SearchDocument {
  readonly id: number;
  readonly title: string;
  readonly format: string;
  readonly path: string;
  readonly pages: number | null;
  readonly characters: number | null;
  readonly originalAvailable: boolean;
}

export interface SearchHit {
  readonly chunkId: number;
  readonly chunkIds: readonly number[];
  readonly siloId: number;
  readonly silo: string;
  readonly documentId: number;
  readonly documentName: string;
  readonly title: string | null;
  readonly text: string;
  readonly markdown: string;
  readonly score: number;
  readonly headingPath: readonly string[];
  readonly partOf: string | null;
  readonly locator: SearchLocator;
  readonly document: SearchDocument;
}

export interface SearchResponse {
  readonly items: readonly SearchHit[];
  readonly normalizedQuery: string;
  readonly mode: SearchMode;
  readonly elapsedMs: number;
}

interface ActiveModel {
  readonly maximum_tokens: number;
  readonly query_prefix: string;
}

export interface CandidateRow {
  readonly id: unknown;
  readonly silo_id: number;
  readonly silo_slug: string;
  readonly document_id: unknown;
  readonly text: string;
  readonly character_start: number;
  readonly character_end: number;
  readonly byte_start: number;
  readonly byte_end: number;
  readonly page_start: number | null;
  readonly page_end: number | null;
  readonly heading_path: string[] | null;
  readonly part_of: string | null;
  readonly name: string;
  readonly title: string | null;
  readonly extension: string;
  readonly relative_path: string | null;
  readonly page_count: number | null;
  readonly character_count: number | null;
  readonly page_basis: string;
  readonly offsets_match_original: boolean;
  readonly original_available: boolean;
  readonly original_sha256: Buffer;
  readonly first_page_label: string | null;
  readonly last_page_label: string | null;
  readonly score: number;
}

export interface RankedCandidate {
  readonly row: CandidateRow;
  readonly score: number;
}

const candidateColumns = `
  c.id, c.silo_id, s.slug AS silo_slug, c.document_id, c.text,
  c.character_start, c.character_end, c.byte_start, c.byte_end,
  c.page_start, c.page_end, c.heading_path, c.part_of,
  d.name, d.title, d.extension, d.relative_path, d.page_count,
  d.character_count, d.page_basis, d.offsets_match_original,
  (d.source_state = 'present') AS original_available, d.original_sha256,
  (SELECT p.label FROM noderag.document_page p
   WHERE p.document_id = d.id AND p.silo_id = d.silo_id
     AND (p.page_number = c.page_start OR p.ordinal = c.page_start)
   ORDER BY (p.page_number = c.page_start) DESC, p.ordinal LIMIT 1) AS first_page_label,
  (SELECT p.label FROM noderag.document_page p
   WHERE p.document_id = d.id AND p.silo_id = d.silo_id
     AND (p.page_number = c.page_end OR p.ordinal = c.page_end)
   ORDER BY (p.page_number = c.page_end) DESC, p.ordinal DESC LIMIT 1) AS last_page_label`;

const filterSql = `
  AND ($4::bigint[] IS NULL OR d.source_id = ANY ($4::bigint[]))
  AND ($5::text IS NULL OR COALESCE(d.relative_path, d.name) LIKE $5::text || '%')
  AND ($6::text[] IS NULL OR d.extension = ANY ($6::text[]))
  AND ($7::timestamptz IS NULL OR d.created_at >= $7)
  AND ($8::timestamptz IS NULL OR d.created_at < $8)
  AND ($9::timestamptz IS NULL OR d.source_mtime >= $9)
  AND ($10::timestamptz IS NULL OR d.source_mtime < $10)
  AND ($11::integer IS NULL OR c.page_end >= $11)
  AND ($12::integer IS NULL OR c.page_start <= $12)
  AND ($13::boolean IS NULL OR $13 = EXISTS (
    SELECT 1 FROM noderag.document_image image
    WHERE image.document_id = d.id AND image.silo_id = d.silo_id
  ))
  AND ($14::boolean IS NULL OR $14 = ('table' = ANY (c.structure_kinds)))`;

const filterValues = (filters: SearchFilters): readonly unknown[] => [
  filters.sourceIds ?? null,
  filters.pathPrefix ?? null,
  filters.formats ?? null,
  filters.createdFrom ?? null,
  filters.createdTo ?? null,
  filters.modifiedFrom ?? null,
  filters.modifiedTo ?? null,
  filters.pageFrom ?? null,
  filters.pageTo ?? null,
  filters.hasImages ?? null,
  filters.hasTables ?? null,
];

export const normalizeSearchQuery = (query: string): string =>
  query.normalize('NFC').trim().replace(/\s+/gu, ' ');

export const reciprocalRankFusion = (
  vector: readonly CandidateRow[],
  keyword: readonly CandidateRow[],
  k = 60,
): readonly RankedCandidate[] => {
  const fused = new Map<string, RankedCandidate>();
  const add = (rows: readonly CandidateRow[]): void => {
    rows.forEach((row, index) => {
      const key = `${String(row.silo_id)}:${String(row.id)}`;
      const score = 1 / (k + index + 1);
      const existing = fused.get(key);
      fused.set(key, { row, score: score + (existing?.score ?? 0) });
    });
  };
  add(vector);
  add(keyword);
  return [...fused.values()].sort(
    (left, right) =>
      right.score - left.score ||
      left.row.silo_id - right.row.silo_id ||
      databaseInteger(left.row.id, 'chunk id') - databaseInteger(right.row.id, 'chunk id'),
  );
};

const labelFor = (row: CandidateRow, start: number | null, end: number | null): string => {
  if (row.page_basis === 'none' || start === null) {
    const denominator = row.character_count ?? 0;
    if (denominator <= 0) return '';
    const percent = Math.max(
      0,
      Math.min(100, Math.round((row.character_start / denominator) * 100)),
    );
    return `${String(percent)}% through document`;
  }
  if (row.page_basis === 'sheet') {
    const first = row.first_page_label ?? `Sheet ${String(start)}`;
    const last = row.last_page_label ?? (end === null ? first : `Sheet ${String(end)}`);
    return first === last ? `Sheet: ${first}` : `Sheets: ${first}–${last}`;
  }
  if (end === null || end === start) return `p. ${String(start)}`;
  return `pp. ${String(start)}–${String(end)}`;
};

const mergeText = (left: SearchHit, right: SearchHit): string => {
  const overlap = left.locator.characterEnd - right.locator.characterStart;
  if (overlap <= 0) return `${left.text}${right.text}`;
  return `${left.text}${right.text.slice(Math.min(overlap, right.text.length))}`;
};

const mergedPageLabel = (
  basis: string,
  start: number | null,
  end: number | null,
  characterStart: number,
  characterCount: number | null,
): string => {
  if (basis === 'none' || start === null) {
    if (characterCount === null || characterCount <= 0) return '';
    const percent = Math.max(0, Math.min(100, Math.round((characterStart / characterCount) * 100)));
    return `${String(percent)}% through document`;
  }
  if (basis === 'sheet') {
    return end === null || end === start
      ? `Sheet ${String(start)}`
      : `Sheets ${String(start)}–${String(end)}`;
  }
  return end === null || end === start
    ? `p. ${String(start)}`
    : `pp. ${String(start)}–${String(end)}`;
};

const toHit = (candidate: RankedCandidate): SearchHit => {
  const row = candidate.row;
  const chunkId = databaseInteger(row.id, 'chunk id');
  const documentId = databaseInteger(row.document_id, 'search document id');
  const title = row.title ?? row.name;
  return {
    chunkId,
    chunkIds: [chunkId],
    siloId: row.silo_id,
    silo: row.silo_slug,
    documentId,
    documentName: row.name,
    title: row.title,
    text: row.text,
    markdown: row.text,
    score: candidate.score,
    headingPath: row.heading_path ?? [],
    partOf: row.part_of,
    locator: {
      pageStart: row.page_start,
      pageEnd: row.page_end,
      pageLabel: labelFor(row, row.page_start, row.page_end),
      pageBasis: row.page_basis,
      characterStart: row.character_start,
      characterEnd: row.character_end,
      characterUnit: 'utf16',
      byteStart: row.byte_start,
      byteEnd: row.byte_end,
      byteUnit: 'utf8',
      offsetsMatchOriginal: row.offsets_match_original,
    },
    document: {
      id: documentId,
      title,
      format: row.extension,
      path: row.relative_path ?? row.name,
      pages: row.page_count,
      characters: row.character_count,
      originalAvailable: row.original_available,
    },
  };
};

export const collapseOverlappingHits = (
  candidates: readonly RankedCandidate[],
): readonly SearchHit[] => {
  const hits = candidates.map(toHit);
  const byDocument = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const key = `${String(hit.siloId)}:${String(hit.documentId)}`;
    const rows = byDocument.get(key) ?? [];
    rows.push(hit);
    byDocument.set(key, rows);
  }
  const collapsed: SearchHit[] = [];
  for (const rows of byDocument.values()) {
    rows.sort(
      (left, right) =>
        left.locator.characterStart - right.locator.characterStart || right.score - left.score,
    );
    for (const row of rows) {
      const previous = collapsed.at(-1);
      if (
        previous === undefined ||
        previous.siloId !== row.siloId ||
        previous.documentId !== row.documentId ||
        row.locator.characterStart > previous.locator.characterEnd
      ) {
        collapsed.push(row);
        continue;
      }
      const text = mergeText(previous, row);
      const best = row.score > previous.score ? row : previous;
      const pageStartValues = [previous.locator.pageStart, row.locator.pageStart].filter(
        (value): value is number => value !== null,
      );
      const pageEndValues = [previous.locator.pageEnd, row.locator.pageEnd].filter(
        (value): value is number => value !== null,
      );
      const pageStart = pageStartValues.length === 0 ? null : Math.min(...pageStartValues);
      const pageEnd = pageEndValues.length === 0 ? null : Math.max(...pageEndValues);
      const characterStart = Math.min(previous.locator.characterStart, row.locator.characterStart);
      const merged: SearchHit = {
        ...best,
        chunkIds: [...new Set([...previous.chunkIds, ...row.chunkIds])],
        text,
        markdown: text,
        locator: {
          ...best.locator,
          pageStart,
          pageEnd,
          pageLabel: mergedPageLabel(
            best.locator.pageBasis,
            pageStart,
            pageEnd,
            characterStart,
            best.document.characters,
          ),
          characterStart,
          characterEnd: Math.max(previous.locator.characterEnd, row.locator.characterEnd),
          byteStart: Math.min(previous.locator.byteStart, row.locator.byteStart),
          byteEnd: Math.max(previous.locator.byteEnd, row.locator.byteEnd),
        },
      };
      collapsed[collapsed.length - 1] = merged;
    }
  }
  return collapsed.sort((left, right) => right.score - left.score || left.chunkId - right.chunkId);
};

const activeModel = async (pool: Pool): Promise<ActiveModel> => {
  const model = await pool.query<ActiveModel>(
    `SELECT m.maximum_tokens, b.query_prefix
     FROM noderag.build b JOIN noderag.model_manifest m ON m.id = b.model_manifest_id
     WHERE b.state = 'active'`,
  );
  const active = model.rows[0];
  if (active === undefined) throw new Error('active_build_missing');
  return active;
};

const vectorLiteral = (vector: readonly number[]): string => {
  if (vector.length !== 1024 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('invalid-query-vector');
  }
  return `[${vector.map((value) => String(value)).join(',')}]`;
};

export interface ExecuteSearchOptions {
  readonly pool: Pool;
  readonly embedder: Embedder;
  readonly files?: DocumentFileStore;
  readonly principalId: number;
  readonly scope: SiloScope;
  readonly requestId: string;
  readonly sourceIp?: string;
  readonly gatewayId?: number;
  readonly request: SearchRequest;
}

export const executeSearch = async (options: ExecuteSearchOptions): Promise<SearchResponse> => {
  const started = performance.now();
  const normalizedQuery = normalizeSearchQuery(options.request.query);
  if (normalizedQuery.length === 0) throw new Error('invalid-query');
  if (options.scope.siloIds.length === 0) {
    return { items: [], normalizedQuery, mode: options.request.mode, elapsedMs: 0 };
  }
  const active = await activeModel(options.pool);
  let vector: string | undefined;
  if (options.request.mode !== 'keyword') {
    const batch = await coordinatedEmbedder(
      options.pool,
      `query:${options.requestId}`,
      options.embedder,
    ).embed([`${active.query_prefix}${normalizedQuery}`], active.maximum_tokens, 0);
    const first = batch.vectors[0];
    if (first === undefined) throw new Error('query-vector-missing');
    vector = vectorLiteral(first);
  }
  const candidateLimit = Math.min(200, Math.max(20, options.request.limit * 4));
  const ranked = await withSiloScope(options.pool, options.scope, async (database) => {
    const settings = await database.query<{ ef_search: number }>(
      'SELECT ef_search FROM noderag.settings WHERE id = 1',
    );
    await database.query(`SELECT set_config('hnsw.ef_search', $1, true)`, [
      String(settings.rows[0]?.ef_search ?? 100),
    ]);
    await database.query(`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)`);
    const vectorRows: CandidateRow[] = [];
    const keywordRows: CandidateRow[] = [];
    for (const siloId of options.scope.siloIds) {
      const filters = filterValues(options.request.filters);
      if (vector !== undefined) {
        const found = await database.query<CandidateRow>(
          `SELECT ${candidateColumns}, 1 - (c.embedding <=> $1::halfvec) AS score
           FROM noderag.chunk c
           JOIN noderag.document d ON d.silo_id = c.silo_id AND d.id = c.document_id
           JOIN noderag.silo s ON s.id = c.silo_id
           JOIN noderag.build b ON b.id = c.build_id AND b.state = 'active'
           WHERE c.silo_id = $2 AND d.state IN ('ready', 'source_missing', 'awaiting_vision')
             ${filterSql}
           ORDER BY c.embedding <=> $1::halfvec, c.id LIMIT $3`,
          [vector, siloId, candidateLimit, ...filters],
        );
        vectorRows.push(...found.rows);
      }
      if (options.request.mode !== 'vector') {
        const found = await database.query<CandidateRow>(
          `SELECT ${candidateColumns},
                  ts_rank_cd(c.search_vector, websearch_to_tsquery('simple', $1)) AS score
           FROM noderag.chunk c
           JOIN noderag.document d ON d.silo_id = c.silo_id AND d.id = c.document_id
           JOIN noderag.silo s ON s.id = c.silo_id
           JOIN noderag.build b ON b.id = c.build_id AND b.state = 'active'
           WHERE c.silo_id = $2 AND d.state IN ('ready', 'source_missing', 'awaiting_vision')
             AND c.search_vector @@ websearch_to_tsquery('simple', $1)
             ${filterSql}
           ORDER BY score DESC, c.id LIMIT $3`,
          [normalizedQuery, siloId, candidateLimit, ...filters],
        );
        keywordRows.push(...found.rows);
      }
    }
    vectorRows.sort((left, right) => Number(right.score) - Number(left.score));
    keywordRows.sort((left, right) => Number(right.score) - Number(left.score));
    const candidates: readonly RankedCandidate[] =
      options.request.mode === 'hybrid'
        ? reciprocalRankFusion(vectorRows, keywordRows)
        : (options.request.mode === 'vector' ? vectorRows : keywordRows).map((row) => ({
            row,
            score: Number(row.score),
          }));
    let items = collapseOverlappingHits(candidates).slice(0, options.request.limit);
    if (options.files !== undefined) {
      const availability = new Map<number, boolean>();
      for (const item of items) {
        const candidate = candidates.find(
          ({ row }) => databaseInteger(row.document_id, 'search document id') === item.documentId,
        );
        if (candidate === undefined) continue;
        const documentId = item.documentId;
        if (availability.has(documentId)) continue;
        availability.set(
          documentId,
          candidate.row.original_available &&
            (await options.files.verifyOriginal(
              documentId,
              candidate.row.extension,
              candidate.row.original_sha256,
            )),
        );
      }
      items = items.map((item) => ({
        ...item,
        document: {
          ...item.document,
          originalAvailable: availability.get(item.documentId) ?? false,
        },
      }));
    }
    const elapsedMs = Math.max(0, Math.round((performance.now() - started) * 1000) / 1000);
    await writeAuditEvent(database, {
      principalId: options.principalId,
      ...(options.gatewayId === undefined ? {} : { gatewayId: options.gatewayId }),
      action: 'search',
      result: 'ok',
      normalizedQuerySha256: hashNormalizedQuery(normalizedQuery),
      rowCount: items.length,
      requestId: options.requestId,
      ...(options.sourceIp === undefined ? {} : { sourceIp: options.sourceIp }),
      detail: {
        queryLength: normalizedQuery.length,
        mode: options.request.mode,
        filters: options.request.filters,
        scope: options.scope.siloIds,
        hitCount: items.length,
        latencyMs: elapsedMs,
        outcome: 'ok',
      },
    });
    return { items, elapsedMs };
  });
  return { ...ranked, normalizedQuery, mode: options.request.mode };
};
