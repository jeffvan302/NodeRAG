# M01 — Contract Freeze, Testbed Inventory, and Feasibility Checklist

Status: local gates passed; GitHub proof closure pending
Environment: Docker testbed
Recorded: 2026-09-04

## Inventory and operator boundaries

- [x] Exact WSL, kernel, container architecture, CPU features, cores, Docker limits, and memory are recorded.
- [x] Bind-mount and named-volume filesystem/permission behavior is measured.
- [x] The eight-file synthetic feasibility corpus is cataloged and hash-verified.
- [x] The absent production corpus, real Google Docs export, and preferred ingest window are recorded as operator inputs rather than invented facts.
- [x] Local Ollama route, authentication state, configured parallelism, empty model inventory, and LAN-only content boundary are recorded.

## Runtime, database, and security feasibility

- [x] The Node 22 Linux x86-64 compatibility image is digest-pinned and runs non-root under an 8 GB limit.
- [x] The Qwen repository revision, model/tokenizer artifacts, hashes, license, pooling, normalization, dimension, and prefixes are pinned.
- [x] q8 ONNX inference produces repeatable normalized 1,024-value embeddings.
- [x] A long-input session plus a second short-query session fits below the 8 GB cgroup ceiling.
- [x] PostgreSQL 17 and pgvector execute a real `halfvec(1024)` insertion and similarity query.
- [x] Pinned spksrc PostgreSQL and pgvector recipes cross-build for x64 DSM 7.2 and produce inspected artifacts.
- [x] Argon2id hash, verify, wrong-password rejection, and provisional near-100 ms calibration pass.

## Contracts, storage, formats, and optional integration

- [x] DSM privilege/resource/data-share/port/web/lifecycle requirements exist as versioned contracts.
- [x] Static DSM contract validation and non-root lifecycle simulation pass.
- [x] Named-volume mode 0700, write/fsync/read/cleanup, bind-mount classification, and unsafe-path rejection pass.
- [x] TXT, Markdown, two-column PDF, raster-only PDF, two DOCX classes, and a messy XLSX pass or receive an honest disposition.
- [x] The local Ollama endpoint is reachable; no vision model is installed, so the structured-image case is honestly `unavailable` and nonblocking.
- [x] q8, compatible q4f16, and fp16 complete the 256/512/1,024-token matrix for threads 1–12 with p50/p95, RSS, CPU, and pressure evidence.

## Evidence and delivery

- [x] The deferred DSM register has an owner, procedure, expected result, and severity for every live-only assertion.
- [x] `docs/planning/M1-TESTBED-FEASIBILITY.md` contains final commands, measurements, hashes, conclusions, and provisional values.
- [x] All Milestone 1 scripts pass syntax and local core/full validation.
- [x] The implementation commit is pushed to `main` and its M01 GitHub Actions run succeeds.
- [x] `m01-proof.json` records the implementation commit and successful workflow run.
- [ ] The proof-closure commit is pushed and its own workflow run succeeds.
- [ ] Annotated tag `m01-complete` resolves to the proof-closure commit.

M02 is authorized only after every item above is complete. Docker evidence must
remain labeled `testbed-complete`; it cannot close any row in the live DSM
register.
