import { describe, expect, it } from 'vitest';
import {
  collapseOverlappingHits,
  normalizeSearchQuery,
  reciprocalRankFusion,
  type CandidateRow,
  type RankedCandidate,
} from '../src/search/retrieval.js';
import { CursorError, decodeCursor, encodeCursor } from '../src/api/cursor.js';

const row = (
  input: Partial<CandidateRow> &
    Pick<CandidateRow, 'id' | 'document_id' | 'character_start' | 'character_end' | 'text'>,
): CandidateRow => ({
  id: input.id,
  silo_id: input.silo_id ?? 1,
  silo_slug: input.silo_slug ?? 'default',
  document_id: input.document_id,
  text: input.text,
  character_start: input.character_start,
  character_end: input.character_end,
  byte_start: input.byte_start ?? input.character_start,
  byte_end: input.byte_end ?? input.character_end,
  page_start: input.page_start === undefined ? 1 : input.page_start,
  page_end: input.page_end === undefined ? 1 : input.page_end,
  heading_path: input.heading_path ?? null,
  part_of: input.part_of ?? 'document',
  name: input.name ?? 'example.md',
  title: input.title ?? 'Example',
  extension: input.extension ?? 'md',
  relative_path: input.relative_path ?? 'example.md',
  page_count: input.page_count ?? 1,
  character_count: input.character_count ?? 1000,
  page_basis: input.page_basis ?? 'exact',
  offsets_match_original: input.offsets_match_original ?? true,
  original_available: input.original_available ?? true,
  original_sha256: input.original_sha256 ?? Buffer.alloc(32),
  first_page_label: input.first_page_label ?? null,
  last_page_label: input.last_page_label ?? null,
  page_labels: input.page_labels ?? [],
  score: input.score ?? 0.5,
});

describe('M08 retrieval algorithms', () => {
  it('normalizes queries to NFC without changing their meaning', () => {
    expect(normalizeSearchQuery('  Cafe\u0301\t  costs  ')).toBe('Café costs');
  });

  it('uses deterministic RRF k=60 and combines duplicate candidates', () => {
    const first = row({
      id: 1,
      document_id: 10,
      character_start: 0,
      character_end: 10,
      text: 'first',
    });
    const second = row({
      id: 2,
      document_id: 20,
      character_start: 0,
      character_end: 10,
      text: 'second',
    });
    const fused = reciprocalRankFusion([first, second], [second, first]);
    expect(fused.map(({ row: candidate }) => candidate.id)).toEqual([1, 2]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(reciprocalRankFusion([], [])).toEqual([]);
    expect(reciprocalRankFusion([first], [])).toHaveLength(1);
  });

  it('collapses overlapping and abutting chunks only within one document', () => {
    const ranked: RankedCandidate[] = [
      {
        row: row({ id: 1, document_id: 10, character_start: 0, character_end: 6, text: 'abcdef' }),
        score: 0.7,
      },
      {
        row: row({ id: 2, document_id: 10, character_start: 4, character_end: 10, text: 'efghij' }),
        score: 0.9,
      },
      {
        row: row({ id: 3, document_id: 10, character_start: 10, character_end: 13, text: 'klm' }),
        score: 0.5,
      },
      {
        row: row({ id: 4, document_id: 11, character_start: 0, character_end: 6, text: 'abcdef' }),
        score: 0.8,
      },
    ];
    const collapsed = collapseOverlappingHits(ranked);
    expect(collapsed).toHaveLength(2);
    const merged = collapsed.find(({ documentId }) => documentId === 10);
    expect(merged?.text).toBe('abcdefghijklm');
    expect(merged?.chunkIds).toEqual([1, 2, 3]);
    expect(merged?.score).toBe(0.9);
    expect(merged?.locator).toMatchObject({ characterStart: 0, characterEnd: 13 });
  });

  it('keeps collapsed locators format-aware for sheets and page-less documents', () => {
    const sheet = collapseOverlappingHits([
      {
        row: row({
          id: 10,
          document_id: 20,
          character_start: 0,
          character_end: 10,
          text: 'first',
          page_basis: 'sheet',
          page_start: 1,
          page_end: 1,
          first_page_label: 'Quality Thresholds',
          last_page_label: 'Quality Thresholds',
          page_labels: ['Quality Thresholds'],
        }),
        score: 0.8,
      },
      {
        row: row({
          id: 11,
          document_id: 20,
          character_start: 10,
          character_end: 20,
          text: 'second',
          page_basis: 'sheet',
          page_start: 2,
          page_end: 2,
          first_page_label: 'Candidate Matrix',
          last_page_label: 'Candidate Matrix',
          page_labels: ['Candidate Matrix'],
        }),
        score: 0.7,
      },
    ]);
    expect(sheet[0]?.locator.pageLabel).toBe('Sheets: Quality Thresholds–Candidate Matrix');
    expect(sheet[0]?.locator.pageLabels).toEqual(['Quality Thresholds', 'Candidate Matrix']);

    const pageLess = collapseOverlappingHits([
      {
        row: row({
          id: 12,
          document_id: 21,
          character_start: 250,
          character_end: 300,
          text: 'first',
          page_basis: 'none',
          page_start: null,
          page_end: null,
          character_count: 1000,
        }),
        score: 0.7,
      },
      {
        row: row({
          id: 13,
          document_id: 21,
          character_start: 300,
          character_end: 350,
          text: 'second',
          page_basis: 'none',
          page_start: null,
          page_end: null,
          character_count: 1000,
        }),
        score: 0.9,
      },
    ]);
    expect(pageLess[0]?.locator.pageLabel).toBe('25% through document');
  });

  it('uses authenticated opaque cursors and rejects tampering', () => {
    const cursor = encodeCursor({ kind: 'documents', id: 42 });
    expect(decodeCursor(cursor)).toEqual({ kind: 'documents', id: 42 });
    const separator = cursor.indexOf('.');
    const signatureStart = separator + 1;
    const replacement = cursor[signatureStart] === 'A' ? 'B' : 'A';
    const tampered = `${cursor.slice(0, signatureStart)}${replacement}${cursor.slice(signatureStart + 1)}`;
    expect(() => decodeCursor(tampered)).toThrow(CursorError);
    expect(() => decodeCursor('not-a-cursor')).toThrow(CursorError);
  });
});
