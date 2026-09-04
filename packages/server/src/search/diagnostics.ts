import type { SqlClient } from '../store/database.js';

export interface RlsBenchmarkMeasurement {
  readonly rlsOnP95Ms: number;
  readonly rlsOffP95Ms: number;
  readonly plan: unknown;
}

export interface RlsDecision {
  readonly keepChunkRls: boolean;
  readonly overheadRatio: number;
  readonly partitionRetained: boolean;
  readonly indexRetained: boolean;
  readonly rationale: string;
}

const planText = (plan: unknown): string => JSON.stringify(plan);

export const decideChunkRls = (measurement: RlsBenchmarkMeasurement): RlsDecision => {
  const denominator = Math.max(0.000_001, measurement.rlsOffP95Ms);
  const overheadRatio = (measurement.rlsOnP95Ms - measurement.rlsOffP95Ms) / denominator;
  const text = planText(measurement.plan);
  const partitionRetained = /chunk_s\d+/u.test(text);
  const indexRetained = /(embedding_hnsw|hnsw)/u.test(text);
  const keepChunkRls = overheadRatio <= 0.15 && partitionRetained && indexRetained;
  return {
    keepChunkRls,
    overheadRatio,
    partitionRetained,
    indexRetained,
    rationale: keepChunkRls
      ? 'Chunk RLS p95 overhead is at or below 15% and the scoped partition/index plan is retained.'
      : 'Chunk RLS exceeds the 15% gate or loses the scoped partition/index plan; retain metadata RLS and mandatory SiloScope plus partition isolation for chunks.',
  };
};

export const annRecallAtK = (
  approximateIds: readonly (string | number)[],
  exactIds: readonly (string | number)[],
  k = 10,
): number => {
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('k must be a positive integer.');
  const expected = new Set(exactIds.slice(0, k).map(String));
  if (expected.size === 0) return 1;
  const found = new Set(approximateIds.slice(0, k).map(String));
  let overlap = 0;
  for (const id of expected) if (found.has(id)) overlap += 1;
  return overlap / expected.size;
};

export const recordRlsDiagnostic = async (
  database: SqlClient,
  principalId: number,
  measurement: RlsBenchmarkMeasurement,
): Promise<RlsDecision> => {
  const decision = decideChunkRls(measurement);
  await database.query(
    `INSERT INTO noderag.retrieval_diagnostic(kind,config,metrics,decision,created_by)
     VALUES('rls_benchmark',$1,$2,$3,$4)`,
    [
      { threshold: 0.15, requiresPartitionPlan: true, requiresIndexPlan: true },
      {
        rlsOnP95Ms: measurement.rlsOnP95Ms,
        rlsOffP95Ms: measurement.rlsOffP95Ms,
        overheadRatio: decision.overheadRatio,
        partitionRetained: decision.partitionRetained,
        indexRetained: decision.indexRetained,
      },
      decision.keepChunkRls ? 'keep_chunk_rls' : 'metadata_rls_partition_scope',
      principalId,
    ],
  );
  return decision;
};

export const recordAnnDiagnostic = async (
  database: SqlClient,
  principalId: number,
  approximateIds: readonly (string | number)[],
  exactIds: readonly (string | number)[],
  k = 10,
): Promise<number> => {
  const recall = annRecallAtK(approximateIds, exactIds, k);
  await database.query(
    `INSERT INTO noderag.retrieval_diagnostic(kind,config,metrics,decision,created_by)
     VALUES('ann_recall',$1,$2,$3,$4)`,
    [
      { k, sampleQueries: 1 },
      { recallAtK: recall },
      recall >= 0.9 ? 'ann_acceptable' : 'increase_ef_search',
      principalId,
    ],
  );
  return recall;
};
