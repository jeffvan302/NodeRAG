import { z } from 'zod';

export const evaluationRelevanceSchema = z
  .object({
    document: z.string().min(1).max(1024),
    pages: z.array(z.number().int().min(0)).max(100).optional(),
  })
  .strict();

export const evaluationCaseSchema = z
  .object({
    id: z.string().min(1).max(120),
    silo: z.string().min(1).max(63),
    query: z.string().min(1).max(4000),
    relevant: z.array(evaluationRelevanceSchema).min(1),
    notes: z.string().max(4000).optional(),
  })
  .strict();

export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;

export interface EvaluationHit {
  readonly document: string;
  readonly format: string;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
}

export interface EvaluationObservation {
  readonly testCase: EvaluationCase;
  readonly hits: readonly EvaluationHit[];
  readonly elapsedMs: number;
}

export interface EvaluationMetrics {
  readonly cases: number;
  readonly recallAt10: number;
  readonly meanReciprocalRank: number;
  readonly ndcgAt10: number;
  readonly zeroResultRate: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number };
  readonly bySilo: Readonly<
    Record<string, { readonly cases: number; readonly recallAt10: number }>
  >;
  readonly byFormat: Readonly<
    Record<string, { readonly relevantHits: number; readonly returnedHits: number }>
  >;
}

const pageMatches = (hit: EvaluationHit, relevant: EvaluationCase['relevant'][number]): boolean => {
  if (hit.document !== relevant.document) return false;
  if (relevant.pages === undefined || relevant.pages.length === 0) return true;
  if (hit.pageStart === null) return false;
  const start = hit.pageStart;
  const end = hit.pageEnd ?? hit.pageStart;
  return relevant.pages.some((page) => page >= start && page <= end);
};

const gain = (observation: EvaluationObservation, hit: EvaluationHit): number =>
  observation.testCase.relevant.some((relevant) => pageMatches(hit, relevant)) ? 1 : 0;

const percentile = (values: readonly number[], quantile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? 0;
};

export const evaluateRetrieval = (
  observations: readonly EvaluationObservation[],
): EvaluationMetrics => {
  let recalled = 0;
  let reciprocalRank = 0;
  let ndcg = 0;
  let zero = 0;
  const silos = new Map<string, { cases: number; recalled: number }>();
  const formats = new Map<string, { relevantHits: number; returnedHits: number }>();
  for (const observation of observations) {
    const top = observation.hits.slice(0, 10);
    if (top.length === 0) zero += 1;
    const gains = top.map((hit) => gain(observation, hit));
    const first = gains.findIndex((value) => value > 0);
    const didRecall = first >= 0;
    if (didRecall) {
      recalled += 1;
      reciprocalRank += 1 / (first + 1);
    }
    const dcg = gains.reduce((sum, value, index) => sum + value / Math.log2(index + 2), 0);
    const idealCount = Math.min(10, observation.testCase.relevant.length);
    const ideal = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2)).reduce(
      (sum, value) => sum + value,
      0,
    );
    ndcg += ideal === 0 ? 0 : dcg / ideal;
    const silo = silos.get(observation.testCase.silo) ?? { cases: 0, recalled: 0 };
    silo.cases += 1;
    if (didRecall) silo.recalled += 1;
    silos.set(observation.testCase.silo, silo);
    for (const hit of top) {
      const format = formats.get(hit.format) ?? { relevantHits: 0, returnedHits: 0 };
      format.returnedHits += 1;
      format.relevantHits += gain(observation, hit);
      formats.set(hit.format, format);
    }
  }
  const count = observations.length;
  return {
    cases: count,
    recallAt10: count === 0 ? 0 : recalled / count,
    meanReciprocalRank: count === 0 ? 0 : reciprocalRank / count,
    ndcgAt10: count === 0 ? 0 : ndcg / count,
    zeroResultRate: count === 0 ? 0 : zero / count,
    latencyMs: {
      p50: percentile(
        observations.map(({ elapsedMs }) => elapsedMs),
        0.5,
      ),
      p95: percentile(
        observations.map(({ elapsedMs }) => elapsedMs),
        0.95,
      ),
    },
    bySilo: Object.fromEntries(
      [...silos].map(([silo, value]) => [
        silo,
        { cases: value.cases, recallAt10: value.cases === 0 ? 0 : value.recalled / value.cases },
      ]),
    ),
    byFormat: Object.fromEntries(formats),
  };
};
