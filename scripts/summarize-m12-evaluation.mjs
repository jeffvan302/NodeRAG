import { readFile } from 'node:fs/promises';
import process from 'node:process';

if (process.argv.length !== 4) {
  console.error('Usage: node scripts/summarize-m12-evaluation.mjs <q8-report> <q4-report>');
  process.exit(2);
}

const load = async (file) => JSON.parse(await readFile(file, 'utf8'));
const [q8, q4] = await Promise.all([load(process.argv[2]), load(process.argv[3])]);
const byCandidate = (report) => new Map(report.runs.map((run) => [run.candidate, run.metrics]));
const q8Runs = byCandidate(q8);
const q4Runs = byCandidate(q4);
const required = (runs, candidate) => {
  const metrics = runs.get(candidate);
  if (metrics === undefined) throw new Error(`Missing measured candidate: ${candidate}`);
  return metrics;
};

const baseline = required(q8Runs, 'vector-default');
const hybrid = required(q8Runs, 'hybrid');
const q4Vector = required(q4Runs, 'vector-default');
const background = required(q8Runs, 'vector-under-ingest');
const q4ThroughputRatio = baseline.latencyMs.p50 / q4Vector.latencyMs.p50;
const hybridRecallGain = hybrid.recallAt10 - baseline.recallAt10;
const failures = [];
if (baseline.gate?.passed !== true) failures.push('q8_vector_release_gate_failed');
if (background.gate?.passed !== true || background.latencyMs.p95 > 5000)
  failures.push('background_ingest_gate_failed');
for (const candidate of [
  'profile-1200-200',
  'profile-3000-400',
  'heading-prefix-off',
  'ef-search-50',
  'ef-search-200',
]) {
  if (required(q8Runs, candidate).gate?.passed !== true)
    failures.push(`candidate_gate_failed:${candidate}`);
}

const result = {
  version: 1,
  passed: failures.length === 0,
  releaseDefaults: {
    mode: 'vector',
    quantization: 'q8-avx2',
    targetChars: 2000,
    overlapChars: 300,
    headingPrefix: true,
    efSearch: 100,
  },
  decisions: {
    q8Vector: {
      accepted: true,
      recallAt10: baseline.recallAt10,
      p95Ms: baseline.latencyMs.p95,
    },
    hybrid: {
      acceptedAsDefault:
        hybridRecallGain >= 0.02 && hybrid.latencyMs.p95 <= baseline.latencyMs.p95 * 2,
      recallGain: hybridRecallGain,
      latencyRatio: hybrid.latencyMs.p95 / baseline.latencyMs.p95,
    },
    q4: {
      acceptedAsDefault:
        q4ThroughputRatio >= 1.5 && baseline.recallAt10 - q4Vector.recallAt10 <= 0.01,
      throughputRatio: q4ThroughputRatio,
      recallLoss: baseline.recallAt10 - q4Vector.recallAt10,
    },
    background: {
      accepted: background.gate?.passed === true,
      recallAt10: background.recallAt10,
      p95Ms: background.latencyMs.p95,
    },
  },
  failures,
};
console.info(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
