import { describe, expect, it } from 'vitest';
import { evaluateRetrieval, evaluationCaseSchema } from '../src/search/evaluation.js';

describe('M08 evaluation harness', () => {
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
    expect(metrics.bySilo['legal']).toEqual({ cases: 2, recallAt10: 0.5 });
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
});
