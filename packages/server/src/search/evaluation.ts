import { z } from 'zod';
import type { SearchMode } from './retrieval.js';

const formatSchema = z.enum(['pdf', 'docx', 'xlsx', 'txt', 'md']);
export const evaluationQueryClassSchema = z.enum([
  'semantic',
  'exact_identifier',
  'exact_name',
  'error_code',
  'quoted_phrase',
  'cross_page',
  'table',
  'vision',
  'multilingual',
  'unicode',
]);

export const evaluationRelevanceSchema = z
  .object({
    document: z.string().min(1).max(1024),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    pages: z.array(z.number().int().min(1)).min(1).max(100).optional(),
    sheets: z.array(z.string().min(1).max(255)).min(1).max(100).optional(),
  })
  .strict()
  .refine((value) => value.pages === undefined || value.sheets === undefined, {
    message: 'Relevance cannot mix page and sheet locators.',
  });

export const evaluationCaseSchema = z
  .object({
    id: z.string().min(1).max(120),
    silo: z.string().min(1).max(63),
    query: z.string().min(1).max(4000),
    queryClass: evaluationQueryClassSchema.default('semantic'),
    expectedFormat: formatSchema.optional(),
    answerable: z.boolean().default(true),
    relevant: z.array(evaluationRelevanceSchema).min(1),
    notes: z.string().max(4000).optional(),
  })
  .strict();

export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;

export interface EvaluationHit {
  readonly document: string;
  readonly sha256?: string;
  readonly silo?: string;
  readonly format: string;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly sheetStart?: string | null;
  readonly sheetEnd?: string | null;
  readonly sheetLabels?: readonly string[];
}

export interface EvaluationObservation {
  readonly testCase: EvaluationCase;
  readonly hits: readonly EvaluationHit[];
  readonly elapsedMs: number;
  readonly mode?: SearchMode;
  readonly workload?: 'idle' | 'ingest';
}

export interface EvaluationMetricSlice {
  readonly cases: number;
  readonly recallAt10: number;
  readonly meanReciprocalRank: number;
  readonly ndcgAt10: number;
  readonly zeroResultRate: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number };
}

export interface EvaluationMetrics extends EvaluationMetricSlice {
  readonly leakageCount: number;
  readonly locatorMismatchCount: number;
  readonly bySilo: Readonly<Record<string, EvaluationMetricSlice>>;
  readonly byFormat: Readonly<Record<string, EvaluationMetricSlice>>;
  readonly byQueryClass: Readonly<Record<string, EvaluationMetricSlice>>;
  readonly byMode: Readonly<Record<string, EvaluationMetricSlice>>;
  readonly byWorkload: Readonly<Record<string, EvaluationMetricSlice>>;
}

export interface EvaluationThresholds {
  readonly minimumRecallAt10: number;
  readonly minimumPerFormatRecallAt10: number;
  readonly maximumZeroResultRate: number;
  readonly maximumIdleP95Ms: number;
  readonly maximumIngestP95Ms: number;
  readonly maximumLeakageCount: number;
  readonly maximumLocatorMismatchCount: number;
}

export const releaseEvaluationThresholds: EvaluationThresholds = {
  minimumRecallAt10: 0.85,
  minimumPerFormatRecallAt10: 0.8,
  maximumZeroResultRate: 0.05,
  maximumIdleP95Ms: 3_000,
  maximumIngestP95Ms: 5_000,
  maximumLeakageCount: 0,
  maximumLocatorMismatchCount: 0,
};

export interface ThresholdDecision {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

const stableDocumentMatches = (
  hit: EvaluationHit,
  relevant: EvaluationCase['relevant'][number],
): boolean => {
  const normalizedHit = hit.document.replaceAll('\\', '/');
  const normalizedRelevant = relevant.document.replaceAll('\\', '/');
  const pathMatches =
    normalizedHit === normalizedRelevant ||
    normalizedHit.endsWith(`/${normalizedRelevant}`) ||
    normalizedRelevant.endsWith(`/${normalizedHit}`);
  return pathMatches && (relevant.sha256 === undefined || hit.sha256 === relevant.sha256);
};

const locatorMatches = (
  hit: EvaluationHit,
  relevant: EvaluationCase['relevant'][number],
): boolean => {
  if (relevant.pages !== undefined) {
    const start = hit.pageStart;
    if (start === null) return false;
    const end = hit.pageEnd ?? start;
    return relevant.pages.some((page) => page >= start && page <= end);
  }
  if (relevant.sheets !== undefined) {
    const hitSheets = new Set([
      ...(hit.sheetLabels ?? []),
      ...[hit.sheetStart, hit.sheetEnd].filter((value): value is string => Boolean(value)),
    ]);
    return relevant.sheets.some((sheet) => hitSheets.has(sheet));
  }
  return true;
};

const gain = (observation: EvaluationObservation, hit: EvaluationHit): number =>
  observation.testCase.relevant.some(
    (relevant) => stableDocumentMatches(hit, relevant) && locatorMatches(hit, relevant),
  )
    ? 1
    : 0;

export const scoreObservation = (
  observation: EvaluationObservation,
): {
  readonly gains: readonly number[];
  readonly leakageCount: number;
  readonly locatorMismatchCount: number;
} => {
  let leakageCount = 0;
  let locatorMismatchCount = 0;
  const top = observation.hits.slice(0, 10);
  for (const hit of top) {
    if (hit.silo !== undefined && hit.silo !== observation.testCase.silo) leakageCount += 1;
    const stableMatch = observation.testCase.relevant.some((relevant) =>
      stableDocumentMatches(hit, relevant),
    );
    const invalidLocator = observation.testCase.relevant.some((relevant) => {
      if (!stableDocumentMatches(hit, relevant)) return false;
      if (relevant.pages !== undefined)
        return hit.pageStart === null || (hit.pageEnd !== null && hit.pageEnd < hit.pageStart);
      if (relevant.sheets !== undefined)
        return (hit.sheetLabels?.length ?? 0) === 0 && !hit.sheetStart && !hit.sheetEnd;
      return false;
    });
    if (stableMatch && invalidLocator) {
      locatorMismatchCount += 1;
    }
  }
  return {
    gains: top.map((hit) => gain(observation, hit)),
    leakageCount,
    locatorMismatchCount,
  };
};

const percentile = (values: readonly number[], quantile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? 0;
};

const metricSlice = (observations: readonly EvaluationObservation[]): EvaluationMetricSlice => {
  let recalled = 0;
  let reciprocalRank = 0;
  let ndcg = 0;
  let zero = 0;
  for (const observation of observations) {
    const top = observation.hits.slice(0, 10);
    if (top.length === 0) zero += 1;
    const gains = top.map((hit) => gain(observation, hit));
    const first = gains.findIndex((value) => value > 0);
    if (first >= 0) {
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
  }
  const cases = observations.length;
  return {
    cases,
    recallAt10: cases === 0 ? 0 : recalled / cases,
    meanReciprocalRank: cases === 0 ? 0 : reciprocalRank / cases,
    ndcgAt10: cases === 0 ? 0 : ndcg / cases,
    zeroResultRate: cases === 0 ? 0 : zero / cases,
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
  };
};

const groupMetrics = (
  observations: readonly EvaluationObservation[],
  key: (observation: EvaluationObservation) => string | undefined,
): Readonly<Record<string, EvaluationMetricSlice>> => {
  const groups = new Map<string, EvaluationObservation[]>();
  for (const observation of observations) {
    const value = key(observation);
    if (value === undefined) continue;
    groups.set(value, [...(groups.get(value) ?? []), observation]);
  }
  return Object.fromEntries([...groups].map(([value, rows]) => [value, metricSlice(rows)]));
};

export const evaluateRetrieval = (
  observations: readonly EvaluationObservation[],
): EvaluationMetrics => {
  let leakageCount = 0;
  let locatorMismatchCount = 0;
  for (const observation of observations) {
    const score = scoreObservation(observation);
    leakageCount += score.leakageCount;
    locatorMismatchCount += score.locatorMismatchCount;
  }
  return {
    ...metricSlice(observations),
    leakageCount,
    locatorMismatchCount,
    bySilo: groupMetrics(observations, ({ testCase }) => testCase.silo),
    byFormat: groupMetrics(observations, ({ testCase }) => testCase.expectedFormat),
    byQueryClass: groupMetrics(observations, ({ testCase }) => testCase.queryClass),
    byMode: groupMetrics(observations, ({ mode }) => mode),
    byWorkload: groupMetrics(observations, ({ workload }) => workload),
  };
};

export const evaluateThresholds = (
  metrics: EvaluationMetrics,
  thresholds: EvaluationThresholds = releaseEvaluationThresholds,
): ThresholdDecision => {
  const failures: string[] = [];
  if (metrics.recallAt10 < thresholds.minimumRecallAt10)
    failures.push('overall_recall_below_threshold');
  if (metrics.zeroResultRate > thresholds.maximumZeroResultRate)
    failures.push('zero_result_rate_above_threshold');
  if (metrics.leakageCount > thresholds.maximumLeakageCount) failures.push('cross_silo_leakage');
  if (metrics.locatorMismatchCount > thresholds.maximumLocatorMismatchCount)
    failures.push('locator_mismatch');
  for (const [format, value] of Object.entries(metrics.byFormat)) {
    if (value.recallAt10 < thresholds.minimumPerFormatRecallAt10)
      failures.push(`format_recall_below_threshold:${format}`);
  }
  const idle = metrics.byWorkload['idle'];
  if (idle !== undefined && idle.latencyMs.p95 > thresholds.maximumIdleP95Ms)
    failures.push('idle_p95_above_threshold');
  const ingest = metrics.byWorkload['ingest'];
  if (ingest !== undefined && ingest.latencyMs.p95 > thresholds.maximumIngestP95Ms)
    failures.push('ingest_p95_above_threshold');
  return { passed: failures.length === 0, failures };
};

export const compareCandidateToBaseline = (
  candidate: EvaluationMetrics,
  baseline: EvaluationMetrics,
): { readonly recallRegression: number; readonly latencyRatio: number } => ({
  recallRegression: baseline.recallAt10 - candidate.recallAt10,
  latencyRatio: baseline.latencyMs.p95 <= 0 ? 1 : candidate.latencyMs.p95 / baseline.latencyMs.p95,
});

export type EvaluationCandidateKind = 'release_default' | 'q4' | 'hybrid' | 'rls';

export interface CandidateMeasurement {
  readonly kind: EvaluationCandidateKind;
  readonly recallAt10: number;
  readonly p95Ms: number;
  readonly throughputPerSecond?: number;
}

export const decideCandidatePromotion = (
  candidate: CandidateMeasurement,
  baseline: CandidateMeasurement,
): ThresholdDecision => {
  const failures: string[] = [];
  const recallLoss = baseline.recallAt10 - candidate.recallAt10;
  if (candidate.kind === 'release_default' && recallLoss > 0.01)
    failures.push('release_default_recall_regression');
  if (candidate.kind === 'q4') {
    const baselineThroughput = baseline.throughputPerSecond ?? 0;
    const candidateThroughput = candidate.throughputPerSecond ?? 0;
    if (baselineThroughput <= 0 || candidateThroughput / baselineThroughput < 1.5)
      failures.push('q4_throughput_gain_below_1_5x');
    if (recallLoss > 0.01) failures.push('q4_recall_loss_above_0_01');
  }
  if (candidate.kind === 'hybrid') {
    if (candidate.recallAt10 - baseline.recallAt10 < 0.02)
      failures.push('hybrid_recall_gain_below_0_02');
    if (baseline.p95Ms <= 0 || candidate.p95Ms / baseline.p95Ms > 2)
      failures.push('hybrid_latency_above_2x');
  }
  if (candidate.kind === 'rls') {
    if (baseline.p95Ms <= 0 || candidate.p95Ms / baseline.p95Ms - 1 > 0.15)
      failures.push('rls_overhead_above_15_percent');
  }
  return { passed: failures.length === 0, failures };
};
