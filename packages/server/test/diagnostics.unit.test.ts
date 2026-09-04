import { describe, expect, it } from 'vitest';
import { annRecallAtK, decideChunkRls } from '../src/search/diagnostics.js';

describe('M08 retrieval decision gates', () => {
  it('computes sampled ANN recall against exact results', () => {
    expect(annRecallAtK([1, 2, 4], [1, 2, 3], 3)).toBeCloseTo(2 / 3, 12);
    expect(annRecallAtK([], [], 10)).toBe(1);
  });

  it('keeps chunk RLS only under the p95 and plan-retention gate', () => {
    expect(
      decideChunkRls({
        rlsOnP95Ms: 11,
        rlsOffP95Ms: 10,
        plan: [
          {
            Plan: {
              'Node Type': 'Index Scan',
              'Relation Name': 'chunk_s3',
              'Index Name': 'chunk_s3_embedding_hnsw_idx',
            },
          },
        ],
      }),
    ).toMatchObject({ keepChunkRls: true, partitionRetained: true, indexRetained: true });
    expect(
      decideChunkRls({
        rlsOnP95Ms: 12,
        rlsOffP95Ms: 10,
        plan: [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'chunk' } }],
      }).keepChunkRls,
    ).toBe(false);
  });
});
