import type { Embedder } from '@noderag/shared';
import type { Pool } from 'pg';
import { SiloScope } from '../identity/scope.js';
import type { DocumentFileStore } from '../storage/document-files.js';
import { databaseInteger, withTransaction } from '../store/database.js';
import {
  compareCandidateToBaseline,
  evaluateRetrieval,
  evaluateThresholds,
  evaluationCaseSchema,
  releaseEvaluationThresholds,
  scoreObservation,
  type EvaluationMetrics,
  type EvaluationObservation,
} from './evaluation.js';
import { executeSearch, type SearchHit, type SearchMode } from './retrieval.js';

interface ClaimedRun {
  readonly id: unknown;
  readonly mode: SearchMode;
  readonly workload: 'idle' | 'ingest';
  readonly created_by: unknown;
}

interface EvaluationCaseRow {
  readonly id: unknown;
  readonly external_id: string;
  readonly silo_id: number;
  readonly silo_slug: string;
  readonly query: string;
  readonly query_class: string;
  readonly expected_format: string | null;
  readonly answerable: boolean;
  readonly relevant: unknown;
  readonly notes: string | null;
}

export interface ProcessEvaluationRunOptions {
  readonly pool: Pool;
  readonly embedder: Embedder;
  readonly files?: DocumentFileStore;
  readonly leaseOwner: string;
}

const sheetNames = (hit: SearchHit): readonly string[] => {
  if (hit.locator.pageBasis !== 'sheet') return [];
  const label = hit.locator.pageLabel.replace(/^Sheets?:\s*/u, '').replace(/^Sheets?\s+/u, '');
  return label
    .split('–')
    .map((value) => value.trim())
    .filter(Boolean);
};

const loadCases = async (pool: Pool): Promise<readonly EvaluationCaseRow[]> => {
  const result = await pool.query<EvaluationCaseRow>(
    `SELECT evaluation.id,evaluation.external_id,evaluation.silo_id,silo.slug AS silo_slug,
            evaluation.query,evaluation.query_class,evaluation.expected_format,
            evaluation.answerable,evaluation.relevant,evaluation.notes
       FROM noderag.evaluation_case evaluation
       JOIN noderag.silo silo ON silo.id=evaluation.silo_id
      WHERE evaluation.enabled AND evaluation.curation_state='approved'
      ORDER BY evaluation.id`,
  );
  return result.rows;
};

const createObservation = async (
  options: ProcessEvaluationRunOptions,
  run: ClaimedRun,
  row: EvaluationCaseRow,
): Promise<EvaluationObservation> => {
  const principalId = databaseInteger(run.created_by, 'evaluation run principal id');
  const scope = await SiloScope.resolve(options.pool, principalId, 'search', {
    requestedSiloIds: [row.silo_id],
  });
  const response = await executeSearch({
    pool: options.pool,
    embedder: options.embedder,
    ...(options.files === undefined ? {} : { files: options.files }),
    principalId,
    scope,
    requestId: `evaluation:${String(run.id)}:${row.external_id}`,
    request: { query: row.query, mode: run.mode, limit: 10, filters: {} },
  });
  const testCase = evaluationCaseSchema.parse({
    id: row.external_id,
    silo: row.silo_slug,
    query: row.query,
    queryClass: row.query_class,
    ...(row.expected_format === null ? {} : { expectedFormat: row.expected_format }),
    answerable: row.answerable,
    relevant: row.relevant,
    ...(row.notes === null ? {} : { notes: row.notes }),
  });
  return {
    testCase,
    mode: run.mode,
    workload: run.workload,
    elapsedMs: response.elapsedMs,
    hits: response.items.map((hit) => {
      const sheets = sheetNames(hit);
      return {
        document: hit.document.path,
        sha256: hit.document.sha256,
        silo: hit.silo,
        format: hit.document.format,
        pageStart: hit.locator.pageStart,
        pageEnd: hit.locator.pageEnd,
        ...(sheets[0] === undefined ? {} : { sheetStart: sheets[0] }),
        ...(sheets[1] === undefined ? {} : { sheetEnd: sheets[1] }),
        ...(hit.locator.pageLabels.length === 0 ? {} : { sheetLabels: hit.locator.pageLabels }),
      };
    }),
  };
};

const persistCompletedRun = async (
  pool: Pool,
  run: ClaimedRun,
  rows: readonly EvaluationCaseRow[],
  observations: readonly EvaluationObservation[],
  metrics: EvaluationMetrics,
): Promise<void> => {
  const runId = databaseInteger(run.id, 'evaluation run id');
  const decision = evaluateThresholds(metrics);
  await withTransaction(pool, async (database) => {
    for (const [index, observation] of observations.entries()) {
      const row = rows[index];
      if (row === undefined) throw new Error('evaluation_case_alignment_failed');
      const score = scoreObservation(observation);
      await database.query(
        `INSERT INTO noderag.evaluation_observation
           (run_id,case_id,elapsed_ms,hits,gains,leakage_count,locator_mismatch_count)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          runId,
          row.id,
          observation.elapsedMs,
          JSON.stringify(observation.hits),
          score.gains,
          score.leakageCount,
          score.locatorMismatchCount,
        ],
      );
    }
    await database.query(
      `UPDATE noderag.evaluation_run
          SET state='succeeded', metrics=$2, case_count=$3, thresholds=$4,
              failure_code=$5, finished_at=now(), lease_owner=NULL, leased_until=NULL
        WHERE id=$1`,
      [
        runId,
        JSON.stringify({ ...metrics, gate: decision }),
        observations.length,
        JSON.stringify(releaseEvaluationThresholds),
        decision.passed ? null : 'quality_gate_failed',
      ],
    );
    for (const code of decision.failures) {
      await database.query(
        `INSERT INTO noderag.evaluation_alert(run_id,severity,code,detail)
         VALUES($1,'failure',$2,$3)`,
        [runId, code, JSON.stringify({ source: 'release-threshold' })],
      );
    }
    const baseline = await database.query<{
      id: unknown;
      metrics: EvaluationMetrics;
    }>(
      `SELECT baseline.id,run.metrics
         FROM noderag.evaluation_baseline baseline
         JOIN noderag.evaluation_run run ON run.id=baseline.run_id
        WHERE baseline.active AND baseline.mode=$1 AND baseline.workload=$2`,
      [run.mode, run.workload],
    );
    const active = baseline.rows[0];
    if (active !== undefined) {
      const comparison = compareCandidateToBaseline(metrics, active.metrics);
      if (comparison.recallRegression > 0.01) {
        await database.query(
          `INSERT INTO noderag.evaluation_alert
             (run_id,baseline_id,severity,code,detail)
           VALUES($1,$2,'failure','recall_regression',$3)`,
          [runId, active.id, JSON.stringify(comparison)],
        );
      }
    }
  });
};

export const processOneEvaluationRun = async (
  options: ProcessEvaluationRunOptions,
): Promise<boolean> => {
  const claimed = await withTransaction(options.pool, async (database) => {
    const result = await database.query<ClaimedRun>(
      `WITH candidate AS (
         SELECT id FROM noderag.evaluation_run
          WHERE state='queued'
          ORDER BY created_at,id
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE noderag.evaluation_run run
          SET state='running',started_at=now(),lease_owner=$1,
              leased_until=now()+interval '30 minutes'
         FROM candidate
        WHERE run.id=candidate.id
       RETURNING run.id,run.mode,run.workload,run.created_by`,
      [options.leaseOwner],
    );
    return result.rows[0] ?? null;
  });
  if (claimed === null) return false;
  const runId = databaseInteger(claimed.id, 'evaluation run id');
  try {
    const rows = await loadCases(options.pool);
    if (rows.length === 0) throw new Error('approved_evaluation_cases_missing');
    const observations: EvaluationObservation[] = [];
    for (const row of rows) observations.push(await createObservation(options, claimed, row));
    const metrics = evaluateRetrieval(observations);
    await persistCompletedRun(options.pool, claimed, rows, observations, metrics);
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 200) : 'evaluation_failed';
    await options.pool.query(
      `UPDATE noderag.evaluation_run
          SET state='failed',failure_code=$2,finished_at=now(),
              lease_owner=NULL,leased_until=NULL
        WHERE id=$1`,
      [runId, code],
    );
  }
  return true;
};
