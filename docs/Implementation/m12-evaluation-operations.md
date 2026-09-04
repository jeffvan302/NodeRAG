# Milestone 12 Evaluation Operations

Status: Docker testbed baseline accepted; DSM performance remeasurement deferred to DSM-023

## Purpose and claims boundary

This procedure creates, runs, reviews, and promotes a NodeRag retrieval baseline. It proves the quality, isolation, locator, and provisional performance behavior of a commit in the Linux/amd64 Docker testbed. It does not claim Synology DSM performance, thermal safety, Package Center behavior, or impact on DSM file sharing. Those claims require DSM-023 against the final installed SPK.

## Versioned inputs

An evaluation is reproducible only when all of the following are frozen in the run:

- the approved case corpus snapshot and digest;
- the active build IDs and chunk profiles for every included silo;
- the active model manifests, source revisions, artifact hashes, dimensions, pooling, normalization, and query/document prefixes;
- the settings revision and environment description;
- the Git commit in `NODERAG_COMMIT_SHA` when it is a full 40-character lowercase SHA;
- migration head `000010_evaluation_baselines`;
- workload (`idle` or `ingest`) and search mode (`vector`, `keyword`, or `hybrid`);
- the release thresholds copied into the run.

The checked-in corpus is `fixtures/evaluation/m12`. Its manifest identifies five source documents, one per supported format, spread across three silos. The golden set contains 60 manually curated, answerable cases spanning semantic, exact identifier, exact name, error code, quoted phrase, cross-page, table, vision, multilingual, and Unicode queries. Relevance is expressed with canonical document paths and SHA-256 plus optional one-based page or exact sheet-name constraints. Chunk IDs are forbidden.

## Curating cases

1. Sign in as an administrator or operator with evaluation-management authority.
2. Open the Evaluation panel.
3. Create a draft case with a stable case ID, query, silo slug, source format, query class, answerable flag, and at least one relevant document locator.
4. Use the immutable source SHA-256 whenever it is known. For paged documents, provide one-based pages. For workbooks, provide exact sheet names. Never combine page and sheet constraints in one relevance item.
5. Review the case against the actual source artifact. Approve it only when another reviewer can reproduce the answer and locator. Reject ambiguous, synthetic, or obsolete cases.
6. A run includes only approved cases. Draft and rejected cases remain visible for curation but cannot silently change an existing corpus snapshot.

The repository validator is:

```text
node scripts/verify-m12-corpus.mjs
```

It verifies schema conformance, hashes and byte sizes, required formats/silos/query classes, one-based pages, exact sheet names, cross-page coverage, vision coverage, Unicode content, stable IDs, and the 50–100 case requirement.

## Running the Docker testbed

From the repository root, run:

```text
bash docker-testbed/scripts/verify-m12.sh --real
```

The launcher performs the following ordered operations:

1. Selects the native WSL Docker engine when available or the Docker Desktop Windows CLI through WSL interop.
2. Verifies the checksum-pinned q8 and q4 model artifacts, downloading only missing artifacts.
3. Starts the pinned, read-only Linux/amd64 Node 22 evaluator image. Its only writable paths are `/tmp`, the Vite configuration cache tmpfs, and the explicit report mount.
4. Runs corpus validation, evaluation/retrieval unit tests, the deterministic 60-case database evaluation, and the ANN/RLS measurement.
5. Runs the real q8 nine-candidate matrix and writes `docker-testbed/artifacts/m12/m12-docker-q8.json`.
6. Runs the real q4 comparison and writes `docker-testbed/artifacts/m12/m12-docker-q4.json`.
7. Applies the release decision rules to both fresh reports. Old reports are removed before the run, so stale evidence cannot satisfy the command.

For a fast host-side deterministic check on a Node 22 development environment, run `pnpm evaluation:m12`. This is useful while coding but does not replace the Linux real-model result.

## Queueing and processing runtime evaluations

1. In the Evaluation panel, approve the intended cases.
2. Queue vector, keyword, and hybrid modes for the same workload and environment.
3. The API creates one immutable corpus snapshot and settings revision, freezes build/model metadata, and stores one queued run per mode.
4. The durable worker claims one queued run with `FOR UPDATE SKIP LOCKED`, evaluates only within each case's authorized silo scope, persists per-case observations and rank gains, calculates aggregates, and writes the gate disposition.
5. Worker interruption leaves the run recoverable. A terminal failure stores a safe failure code and opens an evaluation alert rather than promoting a partial result.
6. Review overall, silo, format, query-class, mode, and workload groups. Leakage and locator counts must be inspected even when aggregate recall is high.
7. Accept a baseline only from a succeeded run whose gate passed. Baseline acceptance deactivates the previous baseline of the same scope transactionally and records the accepting principal and time.

## Metrics and hard gates

Every run records Recall@10, mean reciprocal rank, nDCG@10, zero-result rate, p50/p95 latency, cross-silo leakage count, and locator-mismatch count. The enforced testbed thresholds are:

- leakage exactly 0;
- locator mismatch exactly 0;
- overall Recall@10 at least 0.85;
- each supported format Recall@10 at least 0.80;
- answerable zero-result rate no more than 0.05;
- idle p95 no more than 3,000 ms;
- active-ingest p95 no more than 5,000 ms.

Candidate policy adds these relative gates:

- no release candidate may reduce overall or a major format's Recall@10 by more than 0.01 without documented acceptance;
- q4 needs at least 1.5× q8 throughput and no more than 0.01 Recall@10 loss;
- hybrid needs at least 0.02 absolute Recall@10 gain and no more than 2× p95 latency;
- chunk RLS is retained only at no more than 15% p95 overhead with the expected partition and index plan.

Keyword-only results are retained as diagnostic evidence. They are not expected to pass the semantic corpus gate and do not fail the release when vector and the selected default pass.

## Accepted Docker defaults

The authoritative values are in `evaluation/m12-measured-baseline.json`. The accepted defaults are vector search, q8-avx2, chunk target/overlap 2,000/300, heading prefix enabled, `ef_search=100`, and chunk-table RLS enabled. Hybrid, q4, alternate chunk profiles, heading-prefix-off, and alternate `ef_search` values remain non-default candidates.

The shared embedding runtime passed the active-ingest latency gate. Milestone 1 separately proved that a long-input session plus a short-query session fits the 8 GiB testbed ceiling. Therefore a dedicated query session is not enabled by default; it remains a DSM tuning option if DSM-023 shows contention without memory pressure.

## Nightly regression and alert handling

The `M12 measured evaluation and defaults` GitHub workflow runs nightly and on relevant pushes or pull requests. It validates the corpus, full quality suite, deterministic evaluation, ANN/RLS gates, real q8/q4 decision matrix, and reproducible thin package.

On a regression:

1. Do not accept the candidate baseline or change release defaults.
2. Inspect the open evaluation alert and the frozen run snapshots before rerunning.
3. Classify the failure as corpus drift, source-hash drift, model/build/settings drift, leakage, locator loss, quality, latency, partition/index plan, or infrastructure.
4. Correct the cause or explicitly reject the candidate. Never weaken a threshold to make an unexplained failure pass.
5. Re-run from fresh containers and retain the failed run for comparison.
6. If a formerly accepted baseline regresses by more than 0.01 Recall@10 overall or in a major format, block promotion until the result is explained and approved.

## Final DSM test

DSM-023 repeats the accepted q8 vector baseline, background-ingest test, q4/hybrid comparisons where practical, ANN/RLS checks, and shared-versus-dedicated session observation through the exact installed SPK. It adds RSS, swap, CPU, temperature, disk latency, DSM administration responsiveness, and file-sharing responsiveness. Docker timings are provisional and must not be represented as NAS capacity promises.
