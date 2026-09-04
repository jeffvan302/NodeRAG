# Milestone 12 Checklist — Evaluation, Performance, and Measured Defaults

Status: testbed implementation complete; GitHub certification pending

## Corpus and curation

- [x] The checked-in corpus contains real project material in MD, TXT, PDF, DOCX, and XLSX.
- [x] The 60-case golden set covers three silos and all required query classes, including cross-page, sheet, vision, multilingual, and Unicode cases.
- [x] Relevance uses stable canonical document path plus SHA-256 and optional one-based pages or exact sheet names; it never uses chunk IDs.
- [x] Corpus schema, artifact hashes, byte sizes, coverage, IDs, locators, and answerability are validated before every evaluation.
- [x] Evaluation experts can create draft cases and explicitly approve or reject them in the operator UI/API.

## Immutable runs and metrics

- [x] Runs freeze corpus, settings, environment, active builds, active models, migration head, workload, search mode, thresholds, and a valid `NODERAG_COMMIT_SHA` when supplied by a release/CI environment.
- [x] The worker claims runs durably, preserves silo scope, records observations and gains, and fails without promoting partial results.
- [x] Metrics include Recall@10, MRR, nDCG@10, zero-result rate, p50/p95 latency, leakage, and locator mismatch.
- [x] Reports group results overall and by silo, format, query class, mode, and workload.
- [x] Baseline acceptance requires a succeeded, gate-passing run and records the accepting principal.
- [x] Regressions create persistent alerts and compare candidates against the accepted baseline.

## Candidate matrix and decisions

- [x] Vector, keyword, and hybrid were compared on the same 60 cases.
- [x] q8 and q4 were measured with checksum-pinned real ONNX artifacts in Linux/amd64 Docker.
- [x] Chunk profiles 1,200/200, 2,000/300, and 3,000/400 were compared.
- [x] Heading prefix enabled and disabled were compared.
- [x] `ef_search` 50, 100, and 200 were compared while ANN recall was checked against exact search.
- [x] Search was measured while five documents ingested concurrently.
- [x] q8 vector passed with Recall@10 1.00, p95 90.853 ms, zero leakage, and zero locator mismatches.
- [x] Active-ingest vector passed with Recall@10 1.00 and p95 94.157 ms.
- [x] Hybrid was not promoted because its Recall@10 gain was 0 rather than at least 0.02.
- [x] q4 was not promoted because throughput was 0.831× q8 rather than at least 1.5×.
- [x] The 2,000/300 heading-prefixed profile and `ef_search=100` remain frozen defaults.
- [x] The shared runtime remains default because active ingest met the latency gate; the two-session option remains available from the M01 memory proof.
- [x] Chunk RLS remains enabled because Linux p95 overhead was 7.84%, with correct partition/index plans.
- [x] ANN Recall@10 was 0.90 across 160 samples at 8,500 chunks.

## Automation, packaging, and claims boundary

- [x] The nightly GitHub workflow validates quality, deterministic evaluation, real q8/q4 decisions, ANN/RLS, and the thin package.
- [x] Migration `000010_evaluation_baselines` is forward-only, checksummed, and the expected head.
- [x] OpenAPI M12 and the package payload expose the evaluation contract.
- [x] The WSL launcher tolerates Node 18 by running Node-dependent work inside the pinned Node 22 container.
- [x] The evaluator root filesystem is read-only apart from explicit tmpfs/report mounts.
- [x] The end-to-end `verify-m12.sh --real` command passes locally.
- [x] GitHub implementation workflow is green.
- [ ] Proof-only and final certification commits are green.
- [ ] Annotated tag `m12-complete` resolves remotely to the certification commit.
- [x] DSM timing, thermals, Package Center, administration UI, and file-sharing impact remain explicitly deferred to DSM-023.

## Claims boundary

This checklist certifies only the Linux/amd64 Docker testbed behavior until the pending GitHub rows are completed. It does not certify Synology DSM performance. The raw local reports under `docker-testbed/artifacts/m12` are intentionally ignored runtime output; the reviewed, versioned summary is `evaluation/m12-measured-baseline.json`. Final installed-SPK evaluation and NAS-service impact remain blocking in DSM-023.
