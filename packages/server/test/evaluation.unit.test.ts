import { describe, expect, it } from 'vitest';
import {
  compareCandidateToBaseline,
  decideCandidatePromotion,
  evaluateRetrieval,
  evaluateThresholds,
  evaluationCaseSchema,
} from '../src/search/evaluation.js';

describe('M12 evaluation harness', () => {
  it('uses durable document/page relevance and computes ranking metrics', () => {
    const testCase = evaluationCaseSchema.parse({
      id: 'q001',
      silo: 'legal',
      query: 'termination notice period',
      relevant: [{ document: 'MSA.pdf', pages: [12, 13] }],
    });
    const metrics = evaluateRetrieval([
      {
        testCase,
        elapsedMs: 10,
        hits: [
          { document: 'wrong.pdf', format: 'pdf', pageStart: 1, pageEnd: 1 },
          { document: 'MSA.pdf', format: 'pdf', pageStart: 12, pageEnd: 12 },
        ],
      },
      { testCase: { ...testCase, id: 'q002' }, elapsedMs: 30, hits: [] },
    ]);
    expect(metrics).toMatchObject({
      cases: 2,
      recallAt10: 0.5,
      meanReciprocalRank: 0.25,
      zeroResultRate: 0.5,
      latencyMs: { p50: 10, p95: 30 },
    });
    expect(metrics.ndcgAt10).toBeCloseTo(1 / Math.log2(3) / 2, 12);
    expect(metrics.bySilo['legal']).toMatchObject({ cases: 2, recallAt10: 0.5 });
  });

  it('rejects chunk IDs as the relevance unit', () => {
    expect(() =>
      evaluationCaseSchema.parse({
        id: 'bad',
        silo: 'legal',
        query: 'query',
        relevant: [{ chunkId: 42 }],
      }),
    ).toThrow();
  });

  it('pins content hashes and checks exact page and sheet relevance', () => {
    const sha256 = 'a'.repeat(64);
    const pageCase = evaluationCaseSchema.parse({
      id: 'pdf-vision',
      silo: 'operations',
      query: 'VR-204',
      queryClass: 'vision',
      expectedFormat: 'pdf',
      relevant: [{ document: 'architecture.pdf', sha256, pages: [3] }],
    });
    const sheetCase = evaluationCaseSchema.parse({
      id: 'xlsx-table',
      silo: 'evaluation',
      query: 'minimum recall',
      queryClass: 'table',
      expectedFormat: 'xlsx',
      relevant: [{ document: 'matrix.xlsx', sha256, sheets: ['Quality Thresholds'] }],
    });
    const metrics = evaluateRetrieval([
      {
        testCase: pageCase,
        mode: 'hybrid',
        workload: 'idle',
        elapsedMs: 100,
        hits: [
          {
            document: 'architecture.pdf',
            sha256,
            silo: 'operations',
            format: 'pdf',
            pageStart: 3,
            pageEnd: 3,
          },
        ],
      },
      {
        testCase: sheetCase,
        mode: 'hybrid',
        workload: 'idle',
        elapsedMs: 200,
        hits: [
          {
            document: 'matrix.xlsx',
            sha256,
            silo: 'evaluation',
            format: 'xlsx',
            pageStart: 0,
            pageEnd: 0,
            sheetStart: 'Quality Thresholds',
          },
        ],
      },
    ]);
    expect(metrics).toMatchObject({
      recallAt10: 1,
      leakageCount: 0,
      locatorMismatchCount: 0,
      byFormat: { pdf: { recallAt10: 1 }, xlsx: { recallAt10: 1 } },
      byMode: { hybrid: { cases: 2 } },
    });
    expect(evaluateThresholds(metrics)).toEqual({ passed: true, failures: [] });
  });

  it('fails closed on leakage, locator errors, regressions, and slow candidates', () => {
    const testCase = evaluationCaseSchema.parse({
      id: 'leak',
      silo: 'legal',
      query: 'agreement',
      expectedFormat: 'pdf',
      relevant: [{ document: 'MSA.pdf', pages: [12] }],
    });
    const baseline = evaluateRetrieval([
      {
        testCase,
        workload: 'idle',
        elapsedMs: 100,
        hits: [
          {
            document: 'MSA.pdf',
            silo: 'legal',
            format: 'pdf',
            pageStart: 12,
            pageEnd: 12,
          },
        ],
      },
    ]);
    const candidate = evaluateRetrieval([
      {
        testCase,
        workload: 'idle',
        elapsedMs: 4_000,
        hits: [
          {
            document: 'MSA.pdf',
            silo: 'finance',
            format: 'pdf',
            pageStart: null,
            pageEnd: null,
          },
        ],
      },
    ]);
    expect(evaluateThresholds(candidate)).toMatchObject({ passed: false });
    expect(evaluateThresholds(candidate).failures).toEqual(
      expect.arrayContaining([
        'cross_silo_leakage',
        'locator_mismatch',
        'idle_p95_above_threshold',
      ]),
    );
    expect(compareCandidateToBaseline(candidate, baseline)).toEqual({
      recallRegression: 1,
      latencyRatio: 40,
    });
  });

  it('enforces measured q4, hybrid, and RLS promotion rules', () => {
    const baseline = {
      kind: 'release_default' as const,
      recallAt10: 0.9,
      p95Ms: 1_000,
      throughputPerSecond: 10,
    };
    expect(
      decideCandidatePromotion(
        {
          kind: 'q4',
          recallAt10: 0.895,
          p95Ms: 800,
          throughputPerSecond: 16,
        },
        baseline,
      ),
    ).toEqual({ passed: true, failures: [] });
    expect(
      decideCandidatePromotion({ kind: 'hybrid', recallAt10: 0.92, p95Ms: 2_001 }, baseline).passed,
    ).toBe(false);
    expect(
      decideCandidatePromotion({ kind: 'rls', recallAt10: 0.9, p95Ms: 1_151 }, baseline).failures,
    ).toContain('rls_overhead_above_15_percent');
  });
});
