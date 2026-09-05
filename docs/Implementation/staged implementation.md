# NodeRag Staged Implementation Plan

**Status:** Implementation authority for NodeRag v1
**Created:** 2026-09-04
**Target:** Synology DSM 7.2+, x86_64, 8 GB+ RAM
**Distribution:** Private, manually installed `.spk`
**Repository:** `jeffvan302/NodeRAG`, direct commits to `main`
**Execution sequence:** Milestones 0–14 in WSL/Docker, followed by one final live DSM certification
**Primary sources:** `docs/planning/ARCHITECTURE.md` and `docs/planning/IMPLEMENTATION.md`
**Reference source:** `docs/RailwayRagDocs` (read-only, untracked reference material)

---

## 1. Purpose and Completion Contract

This document is the step-by-step execution authority for taking NodeRag from its current documentation-only state through a completed, tested, recoverable v1.0.0 release. It is written for an implementation system that must be able to work milestone by milestone without inventing product policy or silently skipping difficult integration work. Milestone 0 creates the repository-owned WSL/Docker environment under `docker-testbed/`; Milestones 1–14 use that environment as their primary execution target.

The implementation system must treat every milestone as a cumulative delivery boundary. No milestone may activate behavior owned by a later milestone. A milestone is not complete when code merely exists: its automated tests, Docker-testbed checks, proof artifact, direct-main commit, push, and GitHub Actions run must all pass.

Milestones 0–14 close with `certification: testbed-complete`. They intentionally do not require access to a Synology device. Every DSM-only assertion encountered during those milestones is appended to the deferred DSM certification register instead of being represented as passed. After Milestone 14, the exact release-candidate artifact is taken through the final live DSM certification note. Only that final pass authorizes the labels `DSM-certified` and `v1.0.0`.

The finished product must:

- install as one private `.spk` on supported Synology hardware;
- bundle PostgreSQL 17 and pgvector;
- run Qwen3-Embedding-0.6B locally on the NAS CPU;
- ingest TXT, Markdown, PDF, DOCX, and XLSX;
- retain a managed original and canonical Markdown for every document;
- turn embedded images and unusable/scanned PDF pages into searchable Markdown through remote Ollama vision;
- enforce silo-scoped access for browser users and API keys;
- expose equivalent REST, MCP, and browser capabilities;
- support vector, keyword, and hybrid retrieval with verifiable provenance;
- survive worker, database, network, and NAS restarts;
- rebuild chunks or embeddings without taking search offline;
- purge explicitly deleted content completely;
- back up, restore, upgrade, and uninstall predictably;
- produce a reproducible SPK, checksums, SBOM, notices, release documentation, and milestone evidence.

---

## 2. Authority, Source Precedence, and Conflict Resolution

When two documents disagree, use this order:

1. This staged implementation plan.
2. Explicitly locked, decided, corrected, or superseding language in `docs/planning/ARCHITECTURE.md`.
3. Engineering and build-order guidance in `docs/planning/IMPLEMENTATION.md`.
4. Reusable operational lessons from `docs/RailwayRagDocs`.
5. Older contradictory passages in the planning documents.

Do not modify the two planning documents merely to hide a contradiction. Record any newly discovered conflict as an ADR or amendment to this file before implementing the affected schema or public contract. The user-approved WSL/Docker-first sequence in this revision explicitly supersedes earlier language that required recurring NAS checkpoints or hardware spikes before product implementation.

### 2.1 Locked implementation decisions

| Area                 | Authoritative v1 decision                                                                                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform             | DSM 7.2+, x86_64, minimum 8 GB physical RAM. ARM/aarch64 is excluded.                                                                                                                                                                                                                    |
| Runtime              | Begin with Synology `Node.js_v22`; re-evaluate before release because Node 22 reaches planned upstream EOL on 2027-04-30. A release after EOL requires a validated supported Synology runtime or maintained bundled Node.                                                                |
| Database             | PostgreSQL 17 and pgvector bundled inside the SPK. Unix socket only by default.                                                                                                                                                                                                          |
| Silos                | Silos are access-control and partition boundaries only. They do not own chunk, model, CPU, vision, search-language, or storage settings.                                                                                                                                                 |
| Capabilities         | Independent `read`, `upload`, and `delete` capabilities per principal and silo. None implies another.                                                                                                                                                                                    |
| Administration       | `server_admin` is required for silo lifecycle, principals, grants, settings, storage, gateways, builds, backup/restore, and upgrades.                                                                                                                                                    |
| API keys             | API keys use the same silo grants as users and default to `search_only`, which blocks document downloads, full Markdown, and mutations regardless of other grants.                                                                                                                       |
| Originals            | Every ingest creates a package-managed original named by document ID. There is no reference-in-place mode and no original-file deduplication in v1.                                                                                                                                      |
| Canonical Markdown   | Stored as a package-managed file named by document ID. PostgreSQL stores hashes, boundaries, states, and locators, not full page Markdown.                                                                                                                                               |
| Missing watched file | Retain the managed original and searchable index, set `source_state=missing`, and require review. An unavailable source root must never mark all children missing.                                                                                                                       |
| Explicit delete      | Always purges the managed original, Markdown, pages, images, chunks, vectors, jobs that exist only for it, and cache entries whose reference count reaches zero.                                                                                                                         |
| Character offsets    | UTF-16 code units into canonical Markdown; always populated.                                                                                                                                                                                                                             |
| Byte offsets         | UTF-8 bytes into canonical Markdown; always populated.                                                                                                                                                                                                                                   |
| Original matching    | `offsets_match_original` only indicates whether canonical Markdown offsets also address the original bytes.                                                                                                                                                                              |
| Page locators        | Locator object always exists. Page fields are nullable for TXT and Markdown.                                                                                                                                                                                                             |
| Chunking             | System-wide build profile. Defaults: target 2,000 UTF-16 units, overlap 300, token guard 1,024, snap window 15%, heading prefix enabled.                                                                                                                                                 |
| Keyword language     | PostgreSQL `simple` configuration initially, for mixed-language safety.                                                                                                                                                                                                                  |
| Search default       | Vector/Meaning initially. Hybrid is promoted only by measured evaluation.                                                                                                                                                                                                                |
| Embedding            | Qwen3-Embedding-0.6B ONNX, 1,024 dimensions, last-token pooling, L2 normalization, instructed queries, unprefixed documents.                                                                                                                                                             |
| Vision               | System-wide provider configuration and global content-hash cache. Direct Ollama Cloud is the setup default with an encrypted bearer API key, editable 1–16 parallel-call limit, and explicit off-network warning; self-hosted Ollama and authenticated reverse proxies remain supported. |
| Audit privacy        | Do not store raw search text. Store a normalized-query hash and operational metadata. Default retention: 90 days.                                                                                                                                                                        |
| Distribution         | Private manual SPK upload. No package repository, SynoCommunity submission, or auto-update in v1.                                                                                                                                                                                        |
| Git workflow         | Commit bounded, passing changes directly to `main`. Do not use milestone branches or pull requests. Do not force-push or rewrite shared history.                                                                                                                                         |
| Test sequence        | Complete M0–M14 in `docker-testbed`; run one final live DSM certification against the immutable M14 candidate before tagging v1.0.0.                                                                                                                                                     |

### 2.2 Source-file behavior

Direct uploads and watched folders both produce a managed original under NodeRag's data root. The external watched file remains only a source and change-detection input.

For watched folders:

1. Check that the configured root exists, is mounted, and is readable.
2. If the root is unhealthy, mark the source unavailable and stop. Do not change document presence state.
3. If the root is healthy and one previously known file is absent, set that document's source state to `missing`, record `missing_since`, and retain its managed copy and index.
4. If the file returns with the same content hash, clear the missing state without reprocessing.
5. If it returns with a different content hash, enqueue a normal reindex.
6. Only an explicit API/UI purge performed by a principal with `delete` may destroy the retained document.

### 2.3 Permissions

Use capability rows, not an ordered role column:

```ts
export type SiloCapability = 'read' | 'upload' | 'delete';
```

The grant key is `(principal_id, silo_id, capability)`. Checks are exact:

- `read` authorizes search, chunks, previews, Markdown, and original downloads.
- `upload` authorizes direct uploads, source creation/configuration, crawl, and reindex.
- `delete` authorizes document purge by known ID.
- Silo deletion always requires `server_admin`, even if the administrator also has `delete` on the silo.
- A principal may technically hold `delete` without `read`; the API may purge a known ID but may not list or retrieve the document.

---

## 3. Autonomous Execution Protocol

### 3.1 Work-package loop

For every work package, perform these steps in order:

1. Re-read the current milestone, relevant planning sections, and prior milestone proof.
2. Inspect the repository and verify that its actual state matches the documented baseline.
3. Record any discrepancy before making a change.
4. Implement only the current work package. Keep later behavior absent or disabled.
5. Add or update tests in the same change.
6. Run the narrowest relevant checks, then the full milestone suite.
7. Update schemas, OpenAPI, operator notes, and implementation documentation in the same commit.
8. Generate or update the milestone checklist and proof.
9. Inspect `git diff`, `git status`, and staged paths. Preserve unrelated and untracked user files.
10. Stage explicit paths only. Never use an indiscriminate add that could include `docs/RailwayRagDocs`, models, fixtures containing private content, secrets, or backups.
11. Commit directly to `main` using `MNN: concise outcome`.
12. Push to the configured upstream and wait for GitHub Actions.
13. Create the `mNN-complete` tag only after the remote workflow passes.
14. Begin the next milestone only when the proof says `nextMilestoneAuthorized: true`.

### 3.2 Failure rule

When a required gate fails:

- stop the milestone;
- keep incomplete behavior disabled;
- do not weaken a test, capability check, quality threshold, or security rule merely to proceed;
- record the failing command, target environment, evidence, error, and attempted mitigations;
- follow only the fallback explicitly approved in this plan;
- if all approved fallbacks fail, report the architecture decision that must be reopened.

### 3.3 Proof artifacts

Create these during implementation:

```text
docs/Implementation/proofs/mNN-proof.json
docs/Implementation/checklists/mNN-checklist.md
docs/Implementation/proofs/dsm-final-proof.json
docs/Implementation/checklists/dsm-final-checklist.md
```

Every proof JSON must contain:

```json
{
  "version": 1,
  "milestone": "MNN",
  "recordedAt": "ISO-8601 timestamp",
  "reviewer": "human or automated gate identity",
  "milestoneCommit": "full Git commit SHA",
  "upstreamCommit": "full remote main SHA",
  "migrationHead": "current migration identifier",
  "dependencyLockSha256": "lockfile digest",
  "modelManifestRevision": "revision or null",
  "readinessState": "operational or milestone-appropriate state",
  "featureFlags": {},
  "contracts": {},
  "evidence": {},
  "invariants": {},
  "tests": {},
  "liveEvidence": {},
  "environment": "docker-testbed",
  "certification": "testbed-complete",
  "deferredDsmChecks": [],
  "failures": [],
  "gate": "passed",
  "nextMilestoneAuthorized": true
}
```

A component probe is not exit proof. Required repository, database, package, security, recovery, and testbed gates must all be represented when applicable. Before final DSM certification, `liveEvidence` must remain empty and every applicable live-device claim must appear in `deferredDsmChecks`. Testbed evidence must never be relabeled as DSM evidence.

### 3.4 Repository safeguards

The current checkout is Windows with `core.autocrlf=true` and `core.filemode=false`. Milestone 0 must establish line endings before Linux and DSM scripts are added:

- LF for shell, SQL, JSON, YAML, TypeScript, JavaScript, Markdown, Docker, and DSM package files;
- Linux-side verification of executable lifecycle scripts and tar permissions;
- no committed credentials, setup tokens, production files, extracted private text, vectors, backups, or model weights;
- no changes to the untracked Railway reference directory unless explicitly authorized;
- no progression while the pushed `main` workflow is failing.

---

## 4. Target Architecture and Interfaces

### 4.1 Repository layout

```text
NodeRag/
├── docs/
│   ├── planning/
│   └── Implementation/
│       ├── staged implementation.md
│       ├── proofs/
│       └── checklists/
├── packages/
│   ├── shared/
│   ├── server/
│   └── ui/
├── spk/
│   ├── vendor/spksrc/
│   └── noderag/
├── fixtures/
│   ├── formats/
│   ├── unicode/
│   └── golden/
├── eval/
├── scripts/
├── .github/workflows/
└── docker-testbed/
    ├── compose.yaml
    ├── README.md
    ├── TEST-PLAN.md
    ├── fixtures/
    ├── initdb/
    └── scripts/
```

### 4.2 Stack

| Layer              | Choice                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| Runtime            | Node.js 22 compatibility baseline; supported-runtime release gate                                  |
| Language           | TypeScript, `strict`, `noUncheckedIndexedAccess`                                                   |
| Workspaces         | pnpm, exact package-manager version pinned through Corepack                                        |
| HTTP               | Fastify                                                                                            |
| Validation/OpenAPI | Zod with Fastify type provider and generated JSON Schema                                           |
| Database           | `pg`, hand-reviewed SQL, no ORM                                                                    |
| Migrations         | `node-pg-migrate`, forward-only, immutable checksums                                               |
| Passwords          | Argon2id, provisionally calibrated in the testbed and re-calibrated during final DSM certification |
| Embedding          | `onnxruntime-node`, tokenizer files loaded locally                                                 |
| PDF                | `pdfjs-dist`; MuPDF only if the measured fallback gate requires it                                 |
| DOCX               | `unzipper` + `fast-xml-parser`, direct OOXML traversal                                             |
| XLSX               | `exceljs` streaming reader                                                                         |
| UI                 | Preact + Vite, no SSR                                                                              |
| Markdown display   | HTML-disabled/sanitized Markdown renderer                                                          |
| Tests              | Vitest, fast-check, Testcontainers, Playwright, accessibility checks                               |
| Bundling           | esbuild, production dependencies preassembled                                                      |
| Packaging          | Pinned vendored spksrc, built on Linux/WSL/CI                                                      |
| MCP                | Official Model Context Protocol SDK                                                                |
| Logging            | Structured JSON through Fastify/Pino with redaction                                                |

No ORM, GraphQL, Redis, production-runtime Docker, runtime package installation, or second message broker is permitted. Docker is authorized only for development, CI, testbed execution, and release-candidate rehearsal.

### 4.3 Process boundaries

The SPK supervises:

1. PostgreSQL 17 + pgvector on a private Unix socket.
2. Fastify API/control server and static SPA.
3. Durable ingestion worker.
4. Separate shared ONNX embedder process on a private Unix socket.
5. Optional gateway listeners bounded to the declared DSM port range.

Ollama remains remote. Its failure must degrade vision work to `pending_vision`, not stop text ingestion or search.

### 4.4 Module dependency rules

Enforce with dependency-cruiser:

```text
api → application services → store
api → identity → store
ingest → decode/extract/chunk/embed/vision → store
search → embed/store
DSM users → adapters/dsm
local development → adapters/local
all packages → shared
shared → no application package
```

The store must not import API code. Extractors must not import search or database code. Only the DSM adapter may know Synology paths, commands, or lifecycle variables.

### 4.5 Public types

```ts
export type SiloCapability = 'read' | 'upload' | 'delete';

export type PageBasis = 'exact' | 'sheet' | 'rendered' | 'explicit' | 'none';

export type ReadinessState =
  | 'unconfigured'
  | 'initializing'
  | 'operational'
  | 'maintenance'
  | 'upgrade_required'
  | 'database_ahead'
  | 'degraded'
  | 'unavailable';

export type DocumentState =
  'pending' | 'extracting' | 'awaiting_vision' | 'ready' | 'source_missing' | 'failed' | 'purging';

export type JobState =
  'pending' | 'leased' | 'retry_wait' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export interface Locator {
  pageStart: number | null;
  pageEnd: number | null;
  pageLabel: string | null;
  pageBasis: PageBasis;
  charStart: Utf16Offset;
  charEnd: Utf16Offset;
  charUnit: 'utf16';
  byteStart: Utf8Offset;
  byteEnd: Utf8Offset;
  byteUnit: 'utf8';
  offsetsMatchOriginal: boolean;
}

export interface ModelManifest {
  name: string;
  sourceRevision: string;
  artifactSha256: string;
  tokenizerRevision: string;
  quantization: string;
  dimensions: number;
  maximumTokens: number;
  pooling: 'last_token';
  normalize: 'l2';
  queryPrefix: string;
  documentPrefix: '';
}
```

`SiloScope` must have a private constructor. Only the authorization resolver may create it, after intersecting principal grants, gateway ceiling, and requested silos. Every silo-partitioned store function accepts it as its first parameter.

### 4.6 API conventions

- Base path: `/v1`.
- Authentication: session cookie or bearer API key.
- Browser mutations: SameSite Strict cookie plus CSRF token and Origin checking.
- Persistent mutations: require `Idempotency-Key`.
- Same key/same digest: replay the stored outcome.
- Same key/different digest: `409 Conflict`.
- Errors: RFC 9457 `application/problem+json`, stable error code, and request ID.
- Lists: opaque cursor pagination.
- Uploads: streamed to a temporary file while hashing; never fully buffered.
- Default direct-upload maximum: 2 GiB, configurable downward by the administrator.
- Jobs/events: durable ordered event rows; SSE supports `Last-Event-ID`.
- OpenAPI: generated from runtime schemas and checked against the route inventory.
- SPA and MCP: use the same application services and authorization checks as REST.

### 4.7 API surface

Setup and authentication:

```text
GET    /v1/setup/status
POST   /v1/setup/verify-token
POST   /v1/setup/configure
GET    /v1/setup/events
POST   /v1/auth/login
POST   /v1/auth/logout
GET    /v1/auth/me
PATCH  /v1/auth/password
```

Search and retrieval:

```text
POST   /v1/search
POST   /v1/embed
GET    /v1/silos
GET    /v1/documents
GET    /v1/documents/:id
GET    /v1/documents/:id/markdown
GET    /v1/documents/:id/pages/:ordinal
GET    /v1/documents/:id/original
GET    /v1/chunks/:id
GET    /v1/chunks/:id/context
GET    /v1/images/:id
```

Ingestion:

```text
POST   /v1/documents
POST   /v1/documents/:id/reindex
DELETE /v1/documents/:id
GET    /v1/sources
POST   /v1/sources
GET    /v1/sources/:id
PATCH  /v1/sources/:id
DELETE /v1/sources/:id
POST   /v1/sources/:id/crawl
POST   /v1/sources/:id/review-missing
POST   /v1/images/:id/revision
GET    /v1/jobs
GET    /v1/jobs/:id
GET    /v1/jobs/stream
POST   /v1/jobs/:id/retry
POST   /v1/jobs/:id/pause
POST   /v1/jobs/:id/resume
POST   /v1/jobs/:id/cancel
```

Administration:

```text
GET/POST/PATCH/DELETE /v1/admin/silos...
GET/POST/PATCH        /v1/admin/principals...
POST/DELETE           /v1/admin/api-keys...
GET/PUT/DELETE        /v1/admin/grants...
GET/POST/PATCH/DELETE /v1/admin/gateways...
GET                   /v1/admin/audit
GET                   /v1/admin/health
GET/PUT               /v1/admin/settings
GET/POST               /v1/admin/models...
GET/POST/PATCH         /v1/admin/builds...
GET/POST/PATCH         /v1/admin/storage...
GET/POST               /v1/admin/backups...
GET/POST               /v1/admin/restores...
GET/POST               /v1/admin/evaluation...
```

Contracts:

```text
GET    /v1/openapi.json
POST   /mcp
```

Search-only API keys may use search, chunks, context, and silo listing only. They may not retrieve whole Markdown/originals or invoke any mutation.

---

## 5. Milestones at a Glance

| Milestone               | Outcome                                               | Hard gate                                                                                                        |
| ----------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| M0                      | Repository-owned WSL/Docker testbed                   | Clean checkout starts healthy PostgreSQL 17 + pgvector and passes the halfvec probe                              |
| M1                      | Contract freeze and testbed feasibility               | ONNX, PostgreSQL/pgvector, Node runtime, extraction, Ollama, and Argon2id pass locally; DSM register is complete |
| M2                      | Reproducible repo, dev stack, CI, thin SPK            | Clean checkout builds; thin SPK passes static and simulated lifecycle checks                                     |
| M3                      | Schema, identity, authorization, readiness            | Zero-grant and independent-capability suites pass                                                                |
| M4                      | Markdown vertical slice                               | Markdown upload returns a scoped vector result with exact locators                                               |
| M5                      | Durable ingestion, verifier, missing-source and purge | Crash recovery and purge evidence pass                                                                           |
| M6                      | All five formats                                      | Hand-verified fixture corpus passes                                                                              |
| M7                      | Vision and bad-PDF fallback                           | Vision output is searchable; outages remain retryable                                                            |
| M8                      | Full retrieval, REST, gateway, MCP, eval harness      | Contract and isolation matrices pass                                                                             |
| M9                      | Full UI and setup wizard                              | All UI functions use public API; E2E/a11y pass                                                                   |
| M10                     | Production SPK and simulated storage lifecycle        | Candidate archive and lifecycle pass the local package-user simulator                                            |
| M11                     | Zero-downtime rebuilds                                | Chunk/model rebuild and rollback work under search load                                                          |
| M12                     | Evaluation and testbed-measured defaults              | Quality thresholds and provisional resource/latency thresholds pass on the test corpus                           |
| M13                     | Backup, restore, upgrade, fault/security hardening    | Blank-install restore and upgrade rollback pass                                                                  |
| M14                     | Immutable testbed release candidate                   | Clean-room build, full testbed suite, and 24-hour Docker soak pass                                               |
| Final DSM certification | Live-device validation after all milestones           | Exact M14 candidate passes install through uninstall, performance, recovery, and soak checks before v1.0.0       |

---

## 6. Milestone 0 — WSL/Docker Testbed Foundation

### Goal

Create a reusable, repository-owned Linux test environment that can carry every platform-independent milestone to completion and produce an immutable release candidate before any DSM work begins.

### Dependencies

None.

### Owned paths

All Docker-specific code, scripts, fixture guidance, generated-artifact staging, and testbed planning belong under `docker-testbed/`. Product runtime code remains under `packages/`, and production packaging remains under `spk/`. Nothing in `docker-testbed/` may become a runtime dependency of the Synology package.

### Ordered work

1. Record Windows, WSL distribution/kernel, Docker Desktop, Docker Engine, Docker Compose, CPU, RAM, and available disk versions/capacity.
2. Confirm Docker Desktop's WSL 2 integration is enabled for the selected distribution and that `docker compose` works from WSL.
3. Establish LF rules for shell, SQL, YAML, JSON, JavaScript, TypeScript, Markdown, Docker, and DSM files.
4. Create and maintain `docker-testbed/README.md`, `docker-testbed/TEST-PLAN.md`, `docker-testbed/compose.yaml`, `docker-testbed/scripts/`, `docker-testbed/initdb/`, and the fixture/artifact/runtime hygiene paths.
5. Start PostgreSQL 17 plus pgvector on an isolated Compose network, publishing its development port only to `127.0.0.1`.
6. Generate the database password into a Git-ignored Compose secret file without displaying or logging it.
7. Add a database health check and require readiness before any dependent service or verification suite runs.
8. Enable `vector`, create a temporary `halfvec` table, insert a vector, and prove an exact similarity query.
9. Pin the accepted PostgreSQL/pgvector image to an immutable digest. Record source, license, PostgreSQL version, pgvector version, architecture, and digest.
10. Provide safe bootstrap, start, verify, stop, log/status, and explicitly destructive reset operations. A normal stop must preserve the database volume; reset must require a confirmation argument.
11. Add `.gitignore` protection for secrets, runtime state, generated artifacts, private fixtures, model files, and backups.
12. Define the progressive Compose expansion for Node, server, worker, UI, deterministic vision, optional live Ollama, fault injection, backup/restore, and clean-room release testing. Do not add a service before its owning milestone.
13. Define how GitHub Actions validates the Compose model, image digests, initialization SQL, secret hygiene, health checks, and halfvec probe from a clean checkout.
14. Create `m00-checklist.md` and `m00-proof.json` with `environment: docker-testbed`, `certification: testbed-complete`, exact tool/image versions, commands, tests, and resource baseline.

### Tests

- `docker compose config --quiet` passes after bootstrap.
- The secret exists locally, is non-empty, is not displayed, and is not tracked.
- PostgreSQL becomes healthy within the recorded timeout.
- `vector` is installed and the `halfvec` similarity probe passes.
- Only the configured loopback database port is published.
- Stop/start preserves the probe database; the guarded reset removes only testbed resources.
- A clean checkout can regenerate the secret and reach the same healthy state.

### Exit gate

The committed testbed starts from a clean checkout, its versions and image digest are recorded, its secret and fixture hygiene checks pass, PostgreSQL 17 and pgvector are healthy, and the halfvec probe succeeds. Generate proof, commit, push, wait for CI, and tag `m00-complete`.

---

## 7. Milestone 1 — Contract Freeze, Testbed Inventory, and Feasibility

### Goal

Test every platform-independent assumption capable of invalidating the architecture before product code expands. Produce provisional constants for later scheduling, memory, storage, and UI estimates, and create an explicit register for every assertion that only DSM can settle.

### Dependencies

Milestone 0.

### Ordered work

1. Record exact WSL distribution/kernel, container architecture, CPU instruction sets exposed to Docker, physical/logical cores, Docker CPU/RAM limits, and available memory.
2. Record testbed volume/bind-mount layout, filesystem type, free space, and local fixture-folder permissions.
3. Record corpus document count, total bytes, format mix, largest file per format, language mix, and expected daily change volume.
4. Record whether overnight indexing is acceptable and the preferred global ingest window.
5. Record the Ollama host, model, network route, authentication, configured parallelism, and whether content may leave the LAN.
6. Pin a specific spksrc commit. Verify its PostgreSQL, pgvector, and Node recipes rather than tracking `master`.
7. Convert DSM `run-as: package`, resource, data-share, port, web integration, and lifecycle requirements into adapter contracts, static validators, and a non-root Linux lifecycle simulator. Record the real-device checks in the deferred DSM register.
8. Use the Linux x86_64 compatibility baseline for initial ONNX selection and record target-NAS CPU detection as deferred.
9. Run `onnxruntime-node` in the Node 22 compatibility container and produce one normalized 1,024-element Qwen embedding.
10. If the prebuilt Linux runtime fails, try the documented library/source-build fallbacks. Treat success as testbed compatibility only; Synology C++ runtime compatibility remains deferred.
11. Pin the model repository revision, tokenizer revision, exact file SHA-256, license, pooling, normalization, dimension, query prefix, and document prefix in a model manifest.
12. Run PostgreSQL 17 and pgvector in the testbed; create `vector`; insert and query `halfvec(1024)`. Cross-build the production binaries through pinned spksrc and inspect their artifact/dependency manifests without claiming DSM startup.
13. If the cross-build fails, repair the pinned spksrc package. Record package-user startup of those binaries as a final DSM check.
14. Run Argon2id in the Node 22 compatibility container and choose a provisional cost near 100 ms without excessive memory use. Mark final NAS calibration as deferred.
15. Benchmark q8, q4 where compatible, and fp16 at 256, 512, and 1,024 tokens using one through N physical threads.
16. Record testbed throughput, p50/p95 latency, peak RSS, CPU utilization, and Docker resource pressure. Label every value provisional rather than a DSM capacity promise.
17. Run the storage probe against testbed bind mounts and named volumes: resolve path, inspect mount type, create a probe directory, apply 0700, stat actual permissions, write/fsync/read, and clean up. Test DSM `/volumeN`, ACL, encryption, ext4/btrfs, and share behavior only in final certification.
18. Pass one representative TXT, Markdown, scanned PDF, two-column PDF, Word-saved DOCX, Google-exported DOCX, and messy workbook through throwaway extraction.
19. Send a representative table image from the testbed to Ollama; validate the returned schema and record elapsed time.
20. Confirm whether a second short-query ONNX session fits within the memory budget while PostgreSQL is running.
21. Create `docs/planning/M1-TESTBED-FEASIBILITY.md` with every command, environment, measurement, artifact hash, conclusion, and provisional value.
22. Create the initial format and Unicode fixture inventory without adding private production documents.
23. Create the deferred DSM certification register containing the NAS inventory, runtime ABI, package-user PostgreSQL, ONNX, Argon2, storage/ACL, port/web integration, lifecycle, real performance, reboot, and DSM-service-impact checks.

### External facts to verify

- DSM 7 requires third-party packages to use the package identity: <https://help.synology.com/developer-guide/privilege/preface.html>
- DSM data-share behavior: <https://help.synology.com/developer-guide/resource_acquisition/data_share.html>
- DSM port configuration: <https://help.synology.com/developer-guide/resource_acquisition/port_config.html>
- Current spksrc source: <https://github.com/SynoCommunity/spksrc>
- pgvector recommends list partitioning or separate tables for tenant-isolated ANN search: <https://github.com/pgvector/pgvector>
- Qwen model contract: <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B>
- Qwen ONNX artifacts must be pinned and hashed: <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/tree/bd58e9fd4b0467770da53678d8da25481c0f959b/onnx>
- Ollama structured output capability: <https://docs.ollama.com/capabilities/structured-outputs>
- Node runtime support schedule: <https://nodejs.org/en/about/previous-releases>

### Acceptance matrix

| Case               | Required result                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| ONNX load          | Module loads in the Node 22 Linux compatibility container and completes inference; DSM ABI remains registered                       |
| Embedding contract | Exactly 1,024 finite values, L2-normalized, repeatable within tolerance                                                             |
| PostgreSQL         | Testbed initializes and starts PG17; cross-built artifact is produced and inspected                                                 |
| pgvector           | Extension loads; `halfvec(1024)` insert and similarity query succeed                                                                |
| Argon2id           | Hash and verify succeed at a provisional testbed cost; final NAS calibration remains registered                                     |
| Storage probe      | Unsafe simulated paths are rejected with a specific reason; DSM path classes remain registered                                      |
| Format spike       | Each representative format produces or honestly rejects usable output                                                               |
| Ollama             | Tags/model check and schema-constrained table transcription succeed, or vision is recorded as unavailable without blocking the core |
| Runtime support    | Node 22 compatibility and end-of-support risk are recorded; installed Synology runtime remains registered                           |
| DSM register       | Every live-only assertion has an owner, procedure, expected result, and release-blocking severity                                   |

### Exit gate

ONNX, PostgreSQL/pgvector, the Node 22 compatibility container, Argon2id, extraction, and the applicable Ollama probe must be green in the testbed. The DSM register must be complete and no proof may claim live-device success. Generate `m01-proof.json` with `certification: testbed-complete`, push the passing milestone commit, wait for CI, then tag `m01-complete`.

---

## 8. Milestone 2 — Repository Foundation, Development Stack, CI, and Thin SPK

### Goal

Create a reproducible workstation environment, strict module boundaries, baseline CI, and a minimal DSM package artifact before implementing the product surface.

### Ordered work

1. Add `.gitattributes` before adding shell scripts. Force LF endings and document executable-mode verification.
2. Add `.gitignore` for dependencies, builds, models, private fixtures, backups, generated vectors, secrets, runtime data, and temporary uploads.
3. Add README, security policy, license policy, `THIRD-PARTY.md` generation instructions, and development prerequisites.
4. Create the root workspace manifest and pin the exact pnpm version through `packageManager` and Corepack.
5. Add TypeScript strict configuration, linting, formatting checks, Vitest, and dependency-cruiser.
6. Create `packages/shared`, `packages/server`, and `packages/ui` with build/test/typecheck scripts.
7. Create `adapters/local` and `adapters/dsm`; define platform path, process, resource, and lifecycle interfaces.
8. Extend the Milestone 0 PostgreSQL 17 + pgvector Compose configuration rather than creating a second development stack.
9. Establish forward-only migrations with an immutable checksum manifest and expected migration head.
10. Add Fastify health/readiness skeleton and a static Preact page.
11. Add structured logging with secret/header/body redaction and request IDs.
12. Add GitHub Actions for dependency install, typecheck, lint, boundary checks, unit tests, Testcontainers integration tests, UI build, secret scan, license audit, and Linux line-ending/executable-mode checks.
13. Add a Linux x86_64 Node 22 compatibility job for ONNX and Argon2id; name it testbed compatibility, not DSM compatibility.
14. Vendor the pinned spksrc commit under `spk/vendor/spksrc`.
15. Create the thin NodeRag SPK with required `INFO`, privilege/resource files, one port, icon, lifecycle scripts, and hello/health UI.
16. Build through Linux/WSL/CI, not native Windows GNU tooling.
17. Unpack the thin SPK in a clean Linux container, run static metadata/resource checks, and exercise install/start/status/stop/restart/reboot-simulation/uninstall scripts as a non-root simulated package user. Append the equivalent live Package Center cases to the final DSM register.

### Tests

- Clean clone/setup on Windows and Linux.
- Migration checksum/head test.
- Dependency-boundary test.
- Production bundle smoke test.
- Shell LF and executable-mode test.
- Thin SPK archive, metadata, package-user, install/start/stop/restart/reboot-simulation/uninstall checklist.

### Exit gate

`pnpm` setup, testbed database, migrations, server, UI, tests, and CI all work from a clean checkout. The thin SPK passes archive, static, and simulated lifecycle checks without being represented as installed on DSM. Generate proof with the deferred live checklist, commit, push, wait for CI, and tag `m02-complete`.

---

## 9. Milestone 3 — Database, Identity, Authorization, Readiness, and Audit

### Goal

Establish access control, partition boundaries, durable state, migration discipline, and fail-closed readiness before ingesting content.

### Ordered work

1. Define the complete initial schema so `silo_id`, principal identity, job durability, build provenance, and purge requirements are never retrofitted.
2. Create migrations for `silo`, `principal`, `app_user`, `api_key`, `silo_grant`, `session`, `audit_log`, `settings`, encrypted secrets, `model_manifest`, `build`, `silo_build_state`, `source`, `document`, `document_page`, `document_image`, partitioned `chunk`, `job`, `job_event`, caches, gateways, and idempotency records.
3. Store cache vectors as unindexed generic `halfvec` with explicit dimension metadata; keep active chunk parents dimension-typed.
4. Add document normalization, source presence, missing timestamp, original/Markdown hashes, page basis, and offset metadata missing from the draft schema.
5. Add source schedule and health fields to `source`, not `silo`.
6. Add `snap_window`, rules version, model manifest reference, and query prefix to versioned build profiles.
7. Implement transactional silo creation with its chunk partition, HNSW, GIN, and document index.
8. Implement transactional silo purge/drop, but keep it disabled until the purge milestone proves content cleanup.
9. Implement `SiloScope` with a private constructor and exact capability resolution.
10. Apply provisional RLS to source, document, page, image, and chunk tables.
11. Implement Argon2id password storage, login backoff, lockout, password change, and disabled-user handling.
12. Implement random server-side session identifiers stored as hashes, sliding expiry, absolute expiry, CSRF tokens, and immediate revocation.
13. Implement API keys with one-time reveal, SHA-256 lookup, prefix, expiry, CIDR rules, per-minute limit, usage metadata, revocation, and search-only narrowing.
14. Implement a package-local AES-256-GCM secret root and encrypted provider-token records. Browser/API responses expose only existence and nonreversible fingerprints.
15. Implement readiness states and route policies. Worker claims and application mutations fail closed unless readiness permits them; health remains readable.
16. Implement idempotency records keyed by principal, operation, key, and request digest.
17. Implement structured audit events without raw queries or secret values. Add age indexes and batched retention cleanup.
18. Add centralized auth wrappers and a machine-readable route authorization inventory.
19. Implement minimal setup bootstrap for the first server administrator and default silo, still behind unconfigured-mode controls.

### Security tests

- Every protected route as an unauthenticated caller.
- Every route as a zero-grant principal.
- All read/upload/delete capability combinations.
- Cross-silo ID guessing.
- Search-only API key against full Markdown, original, upload, reindex, and delete.
- Expired/revoked key and session.
- Disabled user and login-disabled state.
- CIDR and rate-limit behavior.
- CSRF and Origin checks.
- RLS and query-builder isolation.
- Secret redaction in logs and responses.

### Exit gate

Every schema object exists at the recorded migration head. Partitions create and drop correctly in tests. No route can access silo data without `SiloScope`. The complete zero-grant/capability matrix passes. Generate proof and tag `m03-complete` only after remote CI passes.

---

## 10. Milestone 4 — Markdown Vertical Slice

### Goal

Prove every architectural seam with the thinnest useful flow: one Markdown upload, one silo, durable jobs, local embedding, and vector search.

### Ordered work

1. Implement streaming multipart upload with early size/disk checks, temporary file, simultaneous SHA-256, and idempotency.
2. Validate extension/MIME and reject unsupported content.
3. Allocate the document ID and write its managed original under the document-ID bucket layout.
4. Fsync the original before committing the authoritative document row.
5. Decode Markdown, strip BOM, normalize CRLF to LF, normalize NFC, and record normalization/encoding metadata.
6. Write the canonical Markdown file, fsync it, compute its hash, and record its location and size.
7. Implement the single locator producer in `packages/shared/locator`.
8. Compute UTF-16 and UTF-8 page/document offsets in one pass.
9. Implement initial heading detection and system-wide chunk profile.
10. Snap boundaries in priority order: paragraph, sentence, line, word, surrogate-safe hard cut.
11. Apply 300-unit overlap, final-runt merging, token guard, and heading prefix.
12. Hash exactly the prefixed text sent to the embedder.
13. Implement the PostgreSQL-backed job stages required for the slice.
14. Implement the private framed embedder protocol and one long-lived ONNX session.
15. Apply instructed query input, unprefixed document input, last-token pooling, and L2 normalization.
16. Reuse vectors through the embedding cache and update cache references transactionally.
17. Store chunk text, vector, build provenance, page/character/byte locators, token count, heading path, and hashes in the silo partition.
18. Implement minimal `POST /v1/search` vector retrieval and audit metadata.
19. Return the passage text and full locator so no client must slice to display the result.
20. Run the flow in the development services, production bundle, and unpacked SPK/lifecycle simulator in the testbed.

### Acceptance matrix

| Case                   | Required result                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Upload retry           | Same idempotency key/request returns the original outcome without a duplicate document                                          |
| Markdown normalization | BOM/CRLF/NFD inputs produce recorded LF/NFC canonical Markdown                                                                  |
| Locator                | UTF-16 and UTF-8 slices reproduce every chunk exactly                                                                           |
| Embedding              | Query and document conventions match the frozen model manifest                                                                  |
| Search scope           | Only the permitted silo partition is searched                                                                                   |
| Restart                | A process restart resumes or safely settles the ingest job                                                                      |
| Packaged simulation    | Uploaded Markdown is returned by `/v1/search` through the production bundle under simulated package paths and user restrictions |

### Exit gate

The vertical slice works end to end in the testbed and packaged simulation with exact locators and access isolation. This is the architecture proof point; do not begin format expansion if it is unstable. Generate proof and tag `m04-complete` after CI and the packaged smoke pass.

---

## 11. Milestone 5 — Durable Ingestion, Locator Verification, Missing Sources, and Purge

### Goal

Make long-running work restartable, make locator drift immediately visible, implement the chosen watched-file behavior, and prove complete destructive deletion.

### Ordered work

1. Expand the job table with kind, priority, frozen configuration revision, logical attempt, maximum attempts, lease owner, lease epoch, lease expiry, heartbeat, progress, retry time, cancellation request, result, and structured error.
2. Claim work with `FOR UPDATE SKIP LOCKED` and a lease epoch that fences stale workers.
3. Reclaim expired leases while preserving the logical job and completed checkpoints.
4. Distinguish transient, permanent, cancelled, and indeterminate external-call failures.
5. Settle the job and append its terminal event in one transaction so a lost response cannot create duplicate terminal state.
6. Persist ordered job events before exposing SSE. Recover progress with job ID and event sequence.
7. Make client disconnect independent from job cancellation.
8. Freeze settings, build, parser, model, prompt, and schema revisions when a job starts.
9. Schedule query embeddings first, normal ingest second, and corpus rebuilds last.
10. Round-robin ingest across documents so one large import cannot starve new small documents.
11. Add a shared CPU semaphore for extraction and embedding, plus a separate global mutex preventing HNSW builds while embedding.
12. Run background processes with conservative `nice`/`ionice` settings in the Linux testbed and express the equivalent DSM values through the platform adapter for final verification.
13. Implement source registration, include/exclude patterns, schedule, manual crawl, `(mtime,size)` fast gate, and content-SHA authority.
14. Check root health before comparing file inventory.
15. Implement `present`, `missing`, and `detached` source states with `missing_since` and operator notes.
16. Retain the managed original/index when a healthy crawl confirms a missing file.
17. Restore a missing document to present without reprocessing if the content hash is unchanged.
18. Complete Markdown-aware chunking:
    - tables, fenced code, image provenance blocks, and list items are atomic;
    - oversized tables split at row boundaries with the header repeated;
    - code splits at line boundaries with continuation metadata;
    - page boundaries do not force chunk boundaries;
    - adjacent overlap is exactly the profile value;
    - final remainder under 25% merges into the preceding chunk.
19. Guard hard cuts so they never split a UTF-16 surrogate pair.
20. Verify each chunk before commit:
    - UTF-16 slice equals stored chunk body;
    - UTF-8 byte slice decodes to the same body;
    - counts and page mapping agree;
    - string is well formed.
21. Add Unicode fixtures containing emoji, rare CJK, combining marks, ZWJ sequences, bidi controls, Arabic, and Hebrew.
22. Add a nightly verifier sampling several hundred chunks per silo and surfacing mismatch IDs in admin health.
23. Add a file/row integrity sweeper for missing originals, missing Markdown, hash mismatches, orphaned files, orphaned chunks, and invalid cache references.
24. Implement explicit document purge requiring the exact `delete` capability.
25. Purge in an auditable state machine so retries are idempotent:
    - mark document `purging`;
    - remove chunks and document-owned database rows;
    - decrement embedding/vision references;
    - delete zero-reference cache data;
    - unlink managed original, Markdown, and extracted images;
    - mark the operation complete in audit/history without retaining document content.
26. Implement server-admin silo purge: stop new work, cancel/drain jobs, purge documents, drop the partition, remove grants/source rows, and retain non-content audit identity as policy permits.

### Fault and security tests

- Worker dies before and after lease heartbeat.
- Database restarts during a job settlement.
- Two workers attempt the same expired job.
- Cancellation arrives during each pipeline stage.
- Source share is unmounted; no document is marked missing.
- Healthy source loses one file; document remains searchable and marked missing.
- Missing file returns unchanged and changed.
- User with upload but no delete attempts purge.
- User with delete but no read purges a known document ID but cannot enumerate documents.
- Cache content shared by two documents survives the first purge and disappears after the second.
- Purge is retried after interruption at every step.

### Exit gate

Durable jobs survive crashes without duplicated completed work, all Unicode locators verify by both units, source loss follows the chosen retain-for-review behavior, and purge evidence proves no uniquely reachable content remains. Generate proof and tag `m05-complete`.

---

## 12. Milestone 6 — TXT, PDF, DOCX, and XLSX Extraction

### Goal

Complete all five supported formats using deterministic extraction where possible and honest provenance where the source format cannot provide exact pages.

### Fixture corpus

Build small, redistributable fixtures with hand-reviewed expected Markdown:

```text
fixtures/formats/
├── txt/
│   ├── utf8.txt
│   ├── utf16-no-bom.txt
│   └── shift-jis.txt
├── md/
│   ├── structure.md
│   ├── nfd-accents.md
│   └── astral-rtl.md
├── pdf/
│   ├── two-column.pdf
│   ├── no-tounicode.pdf
│   ├── scanned.pdf
│   ├── ligatures.pdf
│   └── hyphenated.pdf
├── docx/
│   ├── word-saved.docx
│   ├── gdocs-export.docx
│   ├── explicit-breaks.docx
│   └── tables-images-footnotes.docx
└── xlsx/
    ├── multi-region.xlsx
    ├── dates-currency.xlsx
    ├── formulas-no-cache.xlsx
    ├── merged-cells.xlsx
    ├── wide-90-col.xlsx
    └── tall-5000-row.xlsx
```

### Ordered work

1. Keep extractor contracts pure: `extract(bytes, format, options, injectedVision) -> Page[]` with no database, system clock, filesystem path assumptions, or real network dependency.
2. Implement a shared page/Markdown assembly contract with extraction method, confidence, warnings, images, and page basis.
3. TXT/Markdown decode order:
   - BOM wins and is stripped;
   - test BOM-less UTF-16 alternating-null patterns;
   - try strict UTF-8;
   - use an approved legacy detector;
   - record encoding and confidence;
   - normalize CRLF to LF;
   - normalize to NFC;
   - compute all offsets only afterward.
4. Preserve Markdown structure without reformatting. TXT only splits paragraphs on blank lines and does not invent headings.
5. Implement PDF page extraction with `pdfjs-dist` legacy build:
   - retain glyph coordinates and render modes;
   - detect columns and rebuild reading order;
   - infer missing spaces from glyph gaps;
   - fold `ﬁ`, `ﬂ`, `ﬀ`, `ﬃ`, and `ﬄ`;
   - conservatively join line-end hyphenation;
   - handle useful invisible OCR layers without duplicating visible text;
   - reject encrypted files that cannot be opened;
   - calculate extraction confidence per page.
6. Fail a PDF page to the vision path when it has no usable text, too many replacements/private-use characters, implausible spacing, or quality far below the document median.
7. Implement DOCX by walking OOXML directly:
   - heading styles;
   - paragraphs/emphasis;
   - ordered/unordered lists;
   - exact table structure;
   - drawings/images;
   - footnotes;
   - `w:lastRenderedPageBreak`;
   - explicit page and section breaks.
8. Set DOCX `page_basis` to `rendered`, `explicit`, or `none`. Never synthesize exact pages.
9. Implement XLSX with streaming reads:
   - one sheet is one page;
   - apply number/date/currency display formats;
   - index cached formula values, not formulas;
   - warn when cached values are absent;
   - detect contiguous nonempty regions;
   - emit free text as paragraphs and regions as tables;
   - infer headers conservatively;
   - repeat merged-cell values;
   - switch above 15 columns to record-oriented Markdown;
   - report hidden/empty sheets and skipped ranges;
   - send charts/images to the injected vision interface.
10. Assemble document Markdown with pages in order and exactly `"\n\n"` between page bodies. Page markers remain metadata, not visible injected text.
11. Store page UTF-16 and UTF-8 ranges into the assembled artifact.
12. Write canonical Markdown before committing the new ready version.
13. Reuse unchanged chunks and image/vector caches where exact digests match.
14. Enforce memory ceilings and prove a 200 MB-style workbook path is streaming rather than fully resident.
15. Run the production bundle and packaged simulator against every format; append the equivalent installed-SPK cases to the final DSM register.

### Acceptance matrix

| Case                       | Required result                                                 |
| -------------------------- | --------------------------------------------------------------- |
| BOM and BOM-less input     | Correct decode, stripped BOM, offsets computed afterward        |
| Low-confidence legacy text | Ingests with visible warning, never silently as confident UTF-8 |
| Two-column PDF             | Reading order matches human reading order                       |
| Missing ToUnicode / scan   | Page is routed to vision, not indexed as gibberish              |
| DOCX from Word             | `page_basis=rendered` when saved break information exists       |
| Generated DOCX             | `page_basis=none` when no reliable breaks exist                 |
| Excel dates/currency       | Markdown contains displayed values, not raw serial numbers      |
| Missing formula cache      | Warning/failure is explicit; zero is not invented               |
| Wide/tall workbook         | Record layout and repeated headers remain meaningful            |
| All output                 | Dual locator verifier passes after assembly and chunking        |

### Exit gate

Every hand-reviewed format fixture passes in development, production-bundle, and packaged-simulation modes; resource limits hold and failure/warning states are visible. Generate proof with the deferred installed-SPK format cases and tag `m06-complete`.

---

## 13. Milestone 7 — Vision and Bad-PDF Recovery

### Goal

Turn images, tables, diagrams, charts, and unusable PDF pages into searchable Markdown while keeping remote failures recoverable and visible.

### Ordered work

1. Define a versioned `VisionProvider` capability contract and one Ollama implementation.
2. Implement `/api/tags` reachability/model discovery and `/api/chat` schema capability checks.
3. Require the configured endpoint/model to pass a deterministic built-in table-image test before
   activation. Generate and retain the PNG inside the server bundle; provider testing must never
   depend on a repository fixture path or the process working directory.
4. Default setup to `https://ollama.com/api/chat`, accept host-root, `/api`, and full `/api/chat`
   forms, and expose an optional masked API-key field that is encrypted only after activation.
   Keep self-hosted Ollama and authenticated reverse proxies supported.
5. Define and version the response schema: `kind`, `markdown`, `alt`, and bounded `confidence`.
6. Use a transcription-only prompt, temperature 0, configured context, and model keep-alive.
   Include the exact JSON schema in the prompt; on canonical Ollama Cloud omit its unsupported
   native `format` field but retain strict local response validation.
7. Validate every response with Zod. Invalid output is not accepted as extraction.
8. Downscale to the configured maximum dimension while retaining a digest of the original bytes.
9. Skip images under 64×64, extreme aspect ratios above 20:1, and near-uniform low-entropy artifacts.
10. Cache by image SHA, provider/model revision, prompt revision, schema revision, and preprocessing revision.
11. Keep the cache global because vision configuration is system-wide. Do not expose cross-silo cache membership.
12. Store a dispatch marker before an external call and the validated result immediately after it.
13. Add exponential backoff, maximum attempts, timeout, and global parallelism semaphore.
14. Do not exceed the probed provider concurrency.
15. Splice accepted Markdown at the original page position inside invisible provenance comments containing image ID, page, kind, model, and revisions.
16. Route bad/scanned PDF page renders through the identical interface and mark page extraction `vision` or `mixed`.
17. When calls fail, write an alt-text placeholder, set `pending_vision`, complete text ingestion, and schedule retry.
18. Add admin counts, manual retry, projected call count, elapsed estimate, and warnings for scan-heavy documents.
19. Add a deterministic fake keyed by image hash for all automated ingestion tests.
20. Keep one marked real-provider integration suite outside normal CI.

### Tests

- Valid table/chart/diagram/photo/formula output.
- Malformed JSON, schema violation, hallucinated extra fields, timeout, connection loss, model missing, and rate limit.
- Duplicate logo across pages and silos results in one validated provider call.
- Cache invalidates on model/prompt/schema/preprocessing revision.
- A 400-page scan reports projected calls before confirmation.
- Ollama goes offline mid-document; text remains searchable and images become retryable.
- Low-confidence vision result is flagged and retains provenance.

### Exit gate

Representative images and scanned/failed PDF pages become searchable with provenance. Provider loss never blocks successful text ingestion. Generate proof and tag `m07-complete`.

---

## 14. Milestone 8 — Complete Retrieval, REST API, Gateways, MCP, and Evaluation Harness

### Goal

Complete the public backend, ensure all clients share identical authorization, and make retrieval quality measurable.

### Ordered work

1. Implement query NFC normalization.
2. Implement vector search with the frozen query instruction and active model manifest.
3. Search only the partitions in `SiloScope`; merge per-partition results using comparable active-model scores.
4. Set `hnsw.ef_search` per transaction and use iterative scan where the pinned pgvector version supports it.
5. Implement keyword search with `websearch_to_tsquery('simple', ...)` and per-partition GIN indexes.
6. Implement hybrid search through Reciprocal Rank Fusion with `k=60`.
7. Add bounded filters: silo, source, path prefix, format, created/modified date, page range, images, and detected tables.
8. Collapse hits from the same document whose character ranges overlap or abut. Keep the best score and widen the displayed/page range.
9. Add stable format-aware page labels and percentage-through-document labels for page-less formats.
10. Implement pre-split context responses so common clients never interpret UTF-16 indices.
11. Complete every setup, auth, retrieval, ingestion, job, and admin route defined in Section 4.7.
12. Apply request IDs, cursor pagination, idempotency, rate limits, streaming uploads/downloads, and RFC 9457 errors consistently.
13. Generate OpenAPI from the route schemas and fail CI when the route inventory, schemas, and documentation differ.
14. Implement short-lived authenticated download tickets if direct links are required; never expose private filesystem paths.
15. Implement gateway listeners within the statically declared DSM range. A gateway narrows scope and never authenticates or widens it.
16. Probe ports before binding and surface conflicts without crashing the control server.
17. Implement MCP tools for search, document/page context, chunks, and silo listing using the same auth/scope/audit services.
18. Store audit query hash, length, mode, filters, scope, hit count, latency, request ID, principal, gateway, and outcome—never raw search text.
19. Build an RLS benchmark with realistic silo counts, HNSW indexes, and result sizes.
20. Keep RLS on chunks if p95 overhead is 15% or less and query plans retain partition/index behavior. If not, keep RLS on metadata and use mandatory scope plus partition isolation on chunks; record the measured decision.
21. Compare ANN results with exact search on sampled queries and expose recall diagnostics.
22. Create the evaluation data format using document/page relevance rather than chunk IDs.

### Contract and security tests

- Every implemented route appears once in OpenAPI and the authorization inventory.
- Every response validates against its schema.
- Same idempotency key/same body replays; changed body returns 409.
- Cursor tampering fails cleanly.
- Gateway scope is always an intersection.
- MCP cannot accept model-supplied silo IDs outside server scope.
- Search-only keys cannot retrieve whole artifacts or mutate.
- Unauthorized silo IDs return 404 or empty scoped results without enumeration.
- Overlap collapse never merges different documents.
- Exact-versus-ANN recall sampling is recorded.

### Exit gate

All three search modes, complete REST surface, gateways, and MCP respect identical scope. OpenAPI/route drift is impossible in CI. The RLS decision is recorded from testbed measurements. Run the packaged API/MCP smoke matrix, register the live DSM equivalents, generate proof, and tag `m08-complete`.

---

## 15. Milestone 9 — Complete UI and First-Run Setup

### Goal

Allow a nontechnical administrator to install, configure, ingest, search, troubleshoot, and administer NodeRag through the same public API used externally.

### Ordered work

1. Implement readiness-aware routing and unconfigured mode.
2. Generate a high-entropy one-time setup token at install, store only its verifier at 0600, expire it after setup, and never log it.
3. Build setup-token verification, administrator creation, password calibration, default silo, and recovery instructions.
4. Build storage selection with path probe results, capacity estimate, warnings, and safe defaults.
5. Build model download/manual-upload flow with checksum and air-gapped instructions.
6. Build embedding calibration using approximately twenty representative chunks and show measured characters/second plus projected ingest time.
7. Build Ollama configuration/test showing reachability, model, optional encrypted API key,
   editable provider parallelism, validated sample Markdown, and elapsed time.
8. Build source mappings only after the package user can read the selected paths. Label them as
   read-only input/watch folders and explain that they are not NodeRag's managed storage.
9. Stream setup progress from durable events and recover after page refresh.
10. Implement search with one query box, Meaning/Keyword/Both labels, and visible silo-selection chips.
11. Display passages, heading breadcrumbs, document metadata, exact/qualified locators, grouped same-document results, and page-less percentage location.
12. Add preview using server-prepared context, open/download original, and copy citation.
13. Add filters for the complete retrieval surface and explanatory empty states.
14. Build the document browser with ingest state, page basis, warnings, image status, source-missing review, reindex, and purge.
15. Build ingest/source pages with schedules, live queue, ETA, attempts, failures, pause/resume/cancel/retry.
16. Build independent read/upload/delete capability management.
17. Build users, API keys, gateways, audit, settings, model, builds, storage, backup/restore,
    evaluation, and health pages. Administration cannot be a JSON viewer: expose the safe create,
    edit, test, grant, retry, and destructive-confirmation controls supported by each API, with
    plain-language descriptions of every section and consequential setting.
18. Require typed confirmation for document/silo purge and display exactly what will be destroyed.
19. Use grapheme-aware display truncation and `dir="auto"`; never apply grapheme indexing to locator arithmetic.
20. Add keyboard-first behavior, focus management, responsive design, reduced-motion behavior,
    and WCAG-focused semantics. Provide five explicit per-user browser color schemes—Light, Dark,
    Forest green, Midnight blue, and Deep red—and keep the NodeRag `N` visible in navigation and
    the browser/site icon.
21. Add Playwright coverage for setup, auth, search, upload, source-missing review, capability administration, jobs, and purge.
22. Add automated accessibility checks and manual keyboard/screen-reader checklist.
23. Prove the UI has no browser-only filesystem access or privileged endpoint unavailable to an
    equivalent API client. A configured managed-storage path may be returned only by the
    server-administrator storage endpoint so that an administrator can maintain it; ordinary
    retrieval, health, and list responses must not expose it.

### Exit gate

All intended user and administrator work is possible through the UI and public API. E2E, accessibility, security, and refresh/reconnect flows pass. Generate proof and tag `m09-complete`.

### Testbed implementation record (2026-09-04)

The M09 implementation is complete in the WSL/Docker testbed. The shipped Preact UI provides readiness-aware setup/login/maintenance routing, durable first-run recovery, the complete operator workspace, and public-API-backed administration. Release-candidate usability reviews subsequently strengthened the administration surfaces with knowledge-space creation/editing, explained system settings, storage creation/editing with safe in-use path locking, editable vision credentials/concurrency, readable evaluation cards, five per-user browser color schemes, and a consistent NodeRag browser/site icon. Migration `000007_operator_ui`, `platform/openapi.m09.json`, the current M14 OpenAPI, browser/accessibility suite, operator guide, checklist, proof, and five-job GitHub workflow are the closure evidence. Production model transfer and strict DSM storage/package behavior remain correctly assigned to M10 and final live-DSM certification.

---

## 16. Milestone 10 — Production SPK, Storage, Transport, and Simulated Lifecycle

### Goal

Turn the complete application into a production SPK candidate and prove first run, storage handling, supervision, upgrade, and uninstall behavior in the package-user testbed simulator. Live DSM certification remains final.

### Ordered work

1. Build PostgreSQL, pgvector, required native libraries, application bundles, and UI through the pinned Linux/spksrc toolchain.
2. Package no development dependencies and include no lifecycle path that installs packages at runtime.
3. Finalize `INFO`, icons, license/notices, `conf/privilege`, `conf/resource`, web/port configuration, dependency declarations, wizard assets, and lifecycle scripts.
4. Implement and fixture-test architecture, DSM version, physical RAM, required Synology runtime, port, and disk prerequisite guards. Register their real DSM outputs for final certification.
5. Run everything in the simulator as a dedicated non-root user with package-like ownership and no undeclared write access.
6. Keep PostgreSQL on a 0700 Unix socket with TCP disabled by default. Any diagnostic TCP exposure is explicit, authenticated, and warned.
7. Start the API in unconfigured mode before PostgreSQL initialization and expose only health/setup routes.
8. Run `initdb` at first configured start, generate database credentials, run migrations, create the first admin/default silo, and transition readiness atomically.
9. Implement the documented DSM web integration metadata and validate it statically. Keep port 8787 as the documented fallback and register live desktop/web integration for final certification.
10. Keep gateway listeners disabled by default. Warn before enabling plaintext listeners outside a trusted LAN; support reverse proxy/TLS configuration.
11. Implement the full storage probe:
    - resolved path is under `/volumeN`;
    - ext4 or btrfs, not CIFS/NFS/FUSE;
    - encrypted-share policy enforced;
    - mode 0700/0750 sticks;
    - write/fsync/read succeeds;
    - free space exceeds projected data plus rebuild reserve;
    - sync/indexing-service warnings are shown.
12. Keep PGDATA, WAL, runtime socket, and private configuration in package-controlled app data by default.
13. Permit validated relocation of the bulk PostgreSQL tablespace, managed documents, model, and caches.
14. Implement storage relocation as a guarded job: acquire maintenance barrier, stop new ingest, checkpoint, back up, stop PostgreSQL if required, verified copy, checksum sample/full manifest, repoint, restart, integrity check, then retain old data until explicit cleanup.
15. Implement resumable model download to `.partial`, SHA verification, atomic rename, manual upload/local import, and mirror fallback.
16. Supervise database, API, worker, and embedder with ordered startup, readiness, shutdown, timeouts, and stale-PID/socket cleanup.
17. Implement structured log rotation and admin-visible recent errors without exposing secrets/document bodies.
18. Preserve data by default on package uninstall. Require the uninstall-wizard contract's explicit destructive option to remove it, and test both branches in the simulator.
19. In fresh disposable testbed volumes, simulate clean install, setup, ingest, search, process restart, host/reboot restart, package restart, same-major upgrade, failed start, retained uninstall, destructive uninstall, and reinstall. Record the exact Package Center repetitions for final DSM certification.

### Exit gate

The production SPK candidate passes archive inspection and the full testbed lifecycle with correct simulated ownership, permissions, storage, readiness, recovery, and no shell repair. Every DSM-only result remains in the deferred register. Generate proof with `certification: testbed-complete` and tag `m10-complete`.

---

## 17. Milestone 11 — Zero-Downtime Rebuilds and Model Lifecycle

### Goal

Make system-wide chunk or embedding changes safe, observable, resumable, reversible, and invisible to active search until a verified cutover.

### Core rules

- A build is an immutable chunk profile plus immutable model manifest.
- A partial build is never searchable.
- Search reads only active partitions.
- Same-model profile changes may activate per silo because scores remain comparable.
- A model or model-revision change activates all silos in one transaction.
- A different embedding dimension uses a new typed parent table and atomic parent-level swap.
- Old active data remains available until the new build has passed verification and rollback has been rehearsed.

### Ordered work

1. Finalize immutable `model_manifest`, `build`, and `silo_build_state` records.
2. Store exact chunk rules version, target, overlap, token guard, snap window, heading policy, model artifact, tokenizer, query prefix, dimensions, pooling, and normalization.
3. Implement a proposal endpoint that estimates source characters, expected chunks, embedding hours, vision reuse, temporary storage, and free-space reserve before creating work.
4. Require explicit administrator confirmation after the estimate.
5. Create detached per-silo staging chunk tables with constraints matching their intended partition bound.
6. Populate staging tables through durable low-priority jobs with frozen build inputs.
7. Reuse cached vectors only on exact embedded-text and exact model-manifest digests.
8. Build HNSW and GIN indexes only after data population, and never while the embedder is running at full width.
9. Check row counts, locator verifier, document coverage, vector dimensions, null/finite values, and sampled exact/ANN recall before declaring a silo ready.
10. Implement pause, resume, cancellation, and restart from durable document-level checkpoints.
11. Preserve complete checkpoints on ordinary cancellation; make checkpoint discard a separate explicit destructive action.
12. For a same-model profile change, swap each verified silo partition transactionally and retain the old table under a rollback name until the full build gate passes.
13. For a model/revision change, verify all silo staging partitions first, then detach/attach them and update active model/build state in one transaction.
14. For a dimension change, create a complete new parent with typed partitions/indexes, populate all silos, verify, then rename parents and active metadata atomically.
15. Prevent searches from comparing scores produced by different model manifests.
16. Implement rollback before old-table cleanup.
17. Make cleanup separately authorized, resumable, audited, and blocked while any rollback reference remains.
18. Rehearse a chunk-setting change and model change against a real corpus while continuous search traffic runs.

### Acceptance matrix

| Case                      | Required result                                                     |
| ------------------------- | ------------------------------------------------------------------- |
| Interrupted build         | Resumes from completed document checkpoints                         |
| Cancelled build           | Active search unchanged; complete checkpoints retained              |
| Failed verification       | New data remains detached and inactive                              |
| Same model/profile change | Verified silos may flip independently without score incompatibility |
| Model revision change     | All silos flip atomically or none do                                |
| Dimension change          | New typed parent activates atomically                               |
| Search during build       | Old active build continues serving with normal scope                |
| Rollback                  | Previous build is restored before cleanup                           |
| Cleanup                   | Old data is removed only after explicit authorization               |

### Exit gate

Both rebuild classes and rollback work on a real corpus under active search, without mixed models or downtime. Generate proof and tag `m11-complete`.

---

## 18. Milestone 12 — Evaluation, Performance, and Testbed-Measured Defaults

### Goal

Select quality defaults from the approved corpus and provisional performance/resource defaults from the recorded testbed rather than intuition or public leaderboards. Hardware-dependent values remain subject to final DSM certification.

### Golden set

Create 50–100 real, non-synthetic question-to-relevant-document/page cases covering:

- every silo intended for release;
- every supported format;
- semantic questions;
- exact identifiers, names, error codes, and quoted phrases;
- cross-page answers;
- Excel tables;
- vision-derived content;
- multilingual and Unicode cases present in the real corpus.

Record relevance by stable document ID and page/sheet range, not chunk ID, so the set survives re-chunking.

### Ordered work

1. Add UI actions for authorized experts to mark correct/incorrect results and curate the golden set.
2. Implement repeatable evaluation runs pinned to commit, migration head, build, model, settings revision, and corpus snapshot.
3. Calculate Recall@10, MRR, nDCG@10, zero-result rate, and p50/p95 latency.
4. Report overall, per silo, per format, per query class, and per search mode.
5. Compare vector, keyword, and hybrid.
6. Compare q8 and q4 where the Milestone 1 testbed compatibility gate found usable artifacts.
7. Compare at minimum 1,200/200, 2,000/300, and 3,000/400 chunk profiles.
8. Compare heading prefix enabled/disabled.
9. Tune `ef_search` by comparing ANN with exact search.
10. Compare one shared ONNX session with separate query/ingest sessions when memory permits.
11. Re-check RLS on/off using actual corpus size and access patterns.
12. Measure background ingest impact on testbed API/UI latency, host I/O, memory, and concurrent fixture access. Add DSM UI, file-sharing, and normal NAS service impact to the final register.
13. Freeze release defaults in a versioned settings/build record.
14. Store the accepted baseline and run it nightly.
15. Alert on quality, latency, locator, partition coverage, or model-version regressions.

### Release thresholds

- Cross-silo leakage: exactly zero.
- Locator mismatches: exactly zero.
- Overall Recall@10: at least 0.85 on answerable golden queries.
- Recall@10 per supported format: at least 0.80.
- Zero-result rate on answerable cases: no more than 5%.
- Idle search p95 in the recorded Milestone 0 resource envelope: no more than 3 seconds. This is a provisional testbed gate, not a NAS promise.
- Search p95 in that envelope while ingest is active: no more than 5 seconds. If the shared session cannot meet it and memory allows, enable the dedicated query session provisionally.
- A proposed release change may not reduce overall or any major format's Recall@10 by more than one percentage point without explicit documented acceptance.
- Promote q4 only if it is at least 1.5× faster than q8 and loses no more than one percentage point of Recall@10.
- Promote hybrid to default only if it improves overall Recall@10 by at least two percentage points without more than doubling p95 latency.
- Retain chunk-table RLS only if measured p95 overhead is 15% or less and query plans remain correct.
- Normal background work must not make the testbed UI or fixture access unusable during the documented test window. Repeat the usability check against DSM administration and file sharing during final certification.

### Exit gate

The golden set is representative, all quality and provisional testbed performance thresholds pass, defaults are frozen with their environment qualification, and nightly regression is active. Hardware-dependent defaults are explicitly marked pending DSM certification. Generate proof and tag `m12-complete`.

---

## 19. Milestone 13 — Backup, Restore, Upgrade, Fault Recovery, and Security Hardening

### Goal

Prove that NodeRag can be recovered, upgraded, and operated after realistic failures without depending on the original machine or undocumented manual repair.

### 19.1 Data classification

Classify every persisted value before accepting a schema change:

| Class                 | Examples                                                                | Backup/restore rule                                      |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| Source of truth       | managed originals, canonical Markdown, pages, silo/document identity    | Always include                                           |
| Behavioral/provenance | parser/model/build manifests, chunk settings, grants                    | Include so content remains interpretable                 |
| Derived               | chunks, vectors, indexes, caches                                        | Full backup may include; portable export may rebuild     |
| Secrets               | provider tokens, root keys, database credentials                        | Only in encrypted recovery backup; re-encrypt on restore |
| Security history      | principals, password hashes, API-key hashes, audit metadata             | Include in full recovery according to policy             |
| Ephemeral             | sessions, setup tokens, leases, temporary uploads, live SSE connections | Never restore as active state                            |
| Installation-local    | filesystem paths, ports, device identity, schedules tied to a host      | Reconfigure or import disabled                           |

Unknown/unclassified fields fail backup-schema verification.

### 19.2 Backup products

Implement two products:

1. **Full appliance recovery archive**
   - encrypted with a user-supplied passphrase of at least 12 characters;
   - includes logical database dump, managed originals, Markdown, image artifacts, settings/provenance, identity/security state, and optional model weights;
   - excludes active sessions, setup token, live leases, and temporary files;
   - intended for disaster recovery of the same appliance owner.
2. **Portable corpus export**
   - encrypted;
   - includes silos, documents, originals, Markdown, pages, provenance, and settings required to rebuild;
   - excludes users, API keys, sessions, audit history, provider secrets, device placement, live jobs, and gateway configuration;
   - imports into an explicitly selected destination silo/ownership configuration.

### 19.3 Ordered backup work

1. Define a versioned outer sidecar and inner manifest.
2. Put entry path, size, SHA-256, classification, and logical owner in the inner manifest.
3. Store the final whole-archive SHA-256 in the sidecar/job record, never inside the archive it hashes.
4. Preflight database client/server major compatibility, destination capacity, encryption password, and output location.
5. Require the destination to be outside NodeRag's active data directories.
6. Enter a maintenance barrier that blocks new mutations and worker claims while allowing health and, where consistent, read-only search.
7. Drain or checkpoint active mutations.
8. Take the consistency timestamp from the database clock.
9. Stream the database dump and files through encryption without buffering the archive in RAM or temporary system storage.
10. Support checksummed volumes when the destination filesystem imposes size limits.
11. Release the maintenance barrier in `finally` on success, failure, or cancellation.
12. Verify using an independent reader that decrypts, reassembles, parses, hashes, and samples artifacts without trusting exporter bookkeeping.
13. Record verified/unverified state; an archive is not called successful merely because upload/write completed.
14. Support scheduled backups to an administrator-selected location suitable for later Hyper Backup protection.

### 19.4 Ordered restore work

1. Inspect sidecar, encryption, archive version, NodeRag version, PostgreSQL major, schema compatibility, model dimensions, and required free space before mutation.
2. Define blankness as absence of user content, not literally zero seeded/system rows.
3. Enter maintenance mode and create a pre-restore safety backup where applicable.
4. Restore into staging paths/database first.
5. Preserve stable silo/document/page IDs.
6. Use database column types when restoring JSON/arrays; never infer types from serialized values.
7. Re-encrypt restored provider secrets under the destination installation root.
8. Invalidate sessions and setup tokens.
9. Reset queued/running jobs and stale leases to safe review/requeue states.
10. Disable restored schedules, gateways, and external-provider settings until an administrator validates the new environment.
11. Verify row counts, relationships, file hashes, Markdown hashes, page offsets, vector dimensions, partition coverage, sample searches, and authorization.
12. Atomically activate restored state only after verification.
13. Retain old state until explicit cleanup.

### 19.5 Upgrade work

1. Pin one PostgreSQL major per NodeRag major.
2. Compare on-disk PG major with incoming package during preupgrade.
3. For a major change, require at least twice the current logical database size free.
4. Run the old `pg_dumpall`/logical dump before old binaries disappear.
5. Initialize the new cluster, apply schema to the expected head, restore, verify, and retain the old dump/cluster until confirmation.
6. Rehearse NodeRag 1.0→1.1 migrations on a copy of a real installation.
7. Never edit an already shipped migration; add a new forward migration.
8. Verify migration file checksum, manifest entry, expected head, and tests in the same change.

### 19.6 Fault and security matrix

Test at minimum:

- worker killed at every ingest stage;
- database restart during claim, write, purge, and build swap;
- simultaneous testbed process/host restart during ingest, backup, relocation, and rebuild; register the equivalent NAS reboot cases for final certification;
- Ollama unavailable, slow, malformed, and rate-limited;
- watched share offline and later restored;
- disk full during upload, extraction, HNSW build, backup, and restore;
- corrupt original, Markdown, cache, partition, backup volume, and manifest;
- expired lease and competing workers;
- interrupted/indeterminate external model call;
- traversal attempts in upload names, archives, and download paths;
- decompression/ZIP bombs and oversized XML;
- SQL, JSON, Markdown/HTML, header, and log injection;
- CSRF, session fixation, API-key leakage, and rate-limit bypass;
- every admin route without admin authorization;
- cross-silo search/retrieval by IDs, filters, gateways, and MCP;
- secret, dependency vulnerability, and license scans.

Generate an SBOM and `THIRD-PARTY.md`. Fail releases on disallowed runtime licenses or unresolved critical vulnerabilities unless a time-bounded, reviewed exception exists in the proof.

### Exit gate

A verified encrypted backup restores into a blank installation, search and authorization work afterward, same/major-version upgrade rollback is proven, and the complete fault/security matrix passes. Generate proof and tag `m13-complete`.

---

## 20. Milestone 14 — Immutable Testbed Release Candidate

### Goal

Produce a reproducible, documented, supportable, immutable NodeRag release candidate after a production-like testbed certification. This milestone completes implementation but does not publish v1.0.0 or claim DSM certification.

### Ordered work

1. Freeze dependency lockfile, migration checksums/head, OpenAPI, settings defaults, parser revisions, model manifest, SPK metadata, and release notes.
2. Verify the Node 22 compatibility baseline remains supported. If Node 22 has reached EOL, update the testbed and package manifest to a maintained candidate runtime; final Synology runtime availability remains a DSM certification check.
3. Build from a clean checkout in Linux CI with no untracked build inputs.
4. Re-run typecheck, lint, dependency rules, unit, property, integration, security, contract, UI, evaluation, packaging, backup/restore, and license suites.
5. Unpack and run the exact SPK candidate in a clean package-user testbed with fresh database, app-data, document, model, cache, and log volumes.
6. Complete the first-run wizard through the production bundle without shell intervention.
7. Ingest a production-like corpus containing every supported format, page-basis path, multilingual/Unicode content, embedded images, and scan fallback.
8. Run REST, MCP, gateway, UI, audit, capability, source-missing, reindex, purge, rebuild, backup, restore, host/process restart, and upgrade acceptance cases.
9. Run a minimum 24-hour Docker testbed soak with scheduled crawls, background ingest, search traffic, Ollama interruption/recovery, nightly locator verification, backup, log rotation, and competing host I/O.
10. Fail the soak on cross-silo exposure, locator mismatch, stuck terminal work, unrecovered lease, failed scheduled backup, quality threshold regression, unbounded resource growth, or critical health alarm.
11. Inspect Git for secrets, documents, models, backups, vectors, generated runtime state, and accidental Railway reference staging.
12. Generate:
    - final `.spk`;
    - SPK SHA-256;
    - SBOM;
    - `THIRD-PARTY.md`;
    - migration checksum manifest;
    - model manifest;
    - OpenAPI document;
    - milestone proof bundle;
    - installation/upgrade/release notes;
    - administrator guide;
    - API/MCP guide;
    - backup/restore guide;
    - troubleshooting and known-limitations guide.
13. Commit the final release-candidate state directly to `main` and push.
14. Wait for the complete GitHub workflow to pass on the exact commit.
15. Create an annotated release-candidate tag such as `v1.0.0-rc.1`; do not create `v1.0.0`.
16. Create or stage a private GitHub prerelease containing the SPK, checksum, notices, release notes, proof bundle, and final DSM checklist.
17. Start the tagged candidate—not an untagged local build—in a fresh testbed, verify its checksum and health identity, and record them in `m14-proof.json`.

### Testbed release-candidate gate

All testbed definition-of-done items below must be true, the Docker soak must pass, the remote workflow must be green, and `m14-proof.json` must contain `gate: passed`, `certification: testbed-complete`, `releaseAuthorized: false`, and `dsmCertificationRequired: true`.

---

## 21. Final DSM Certification Note — Required Before v1.0.0

This activity begins only after Milestone 14 passes. It is deliberately outside the WSL/Docker milestone sequence so development can proceed without NAS access. It is still a release-blocking certification, not an optional courtesy smoke test.

Use the exact tagged M14 candidate and verify its checksum before installation. Do not rebuild it for DSM testing. Complete and record at least:

1. NAS model, DSM build, x86_64 architecture, CPU features, cores, RAM, volumes, filesystem, encryption, ACLs, free space, and declared ports.
2. Synology Node runtime availability/support and `onnxruntime-node` loading against the real DSM C++ runtime.
3. One correct normalized 1,024-element embedding for the pinned model, followed by q8/q4/fp16 throughput, p50/p95, RSS, CPU, thermal, and DSM-responsiveness measurements.
4. Cross-built PostgreSQL 17 and pgvector `initdb`, private Unix-socket startup, extension creation, `halfvec(1024)` insert/search, restart, and shutdown as the package-created user.
5. Argon2id recalibration on the NAS and any settings migration required by the measured cost.
6. DSM `run-as: package`, resource, data-share, port, firewall, web/desktop integration, logs, and lifecycle behavior.
7. Storage probes on each approved `/volumeN` path, including ext4/btrfs, encryption, ACL-mode persistence, write/fsync/read, capacity, relocation, and rollback.
8. Package Center manual install, first-run setup, one fixture of every format, vision/Ollama, vector/keyword/hybrid search, REST, MCP, gateways, UI, permissions, audit, missing-source behavior, reindex, purge, and rebuild.
9. Service restart, package restart, NAS reboot during ordinary work and each durable operation, same-major upgrade, failed-start recovery, backup, blank restore, rollback, retained uninstall, destructive uninstall, and reinstall.
10. Repeat the versioned Milestone 12 baseline through the installed SPK as DSM-023: verify the approved corpus hashes; re-run q8 vector, vector/keyword/hybrid, representative q4, ANN/exact, RLS, active-ingest, and shared-versus-dedicated session cases where practical; record quality, locators, leakage, p50/p95, RSS, swap, CPU, temperature, disk latency, DSM administration responsiveness, and file-sharing responsiveness. Then complete a minimum 24-hour soak alongside ordinary DSM administration and file-sharing activity.

If a DSM check fails, do not weaken the check or publish v1.0.0. Reopen the owning milestone, fix and re-run its testbed suite, produce a new immutable release candidate, and repeat affected DSM checks. If every check passes, generate `dsm-final-proof.json`, commit any evidence-only documentation, wait for CI, create annotated tag `v1.0.0` on the certified candidate commit, and create the private GitHub release with the certified SPK and proof bundle.

---

## 22. Cross-Cutting Test Matrix

Every milestone runs the applicable layers and preserves all earlier passing layers.

| Layer              | Required coverage                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Unit               | Locator, chunking, encoding, normalization, extraction, hashing, auth, settings, retry classification           |
| Property           | Dual-unit slicing, surrogate safety, chunk reconstruction, overlap, idempotency                                 |
| Integration        | Migrations, partitions, RLS, job leases, caches, search, purge, rebuild cutover                                 |
| Security           | Route inventory, zero-grant, independent capabilities, API-key narrowing, CSRF, traversal, redaction            |
| Contract           | Runtime schemas, OpenAPI, RFC 9457, pagination, idempotency, SSE reconnection                                   |
| UI                 | Setup, auth, search, ingest, admin, jobs, failures, purge, responsive layout                                    |
| Accessibility      | Automated axe checks plus keyboard/focus/screen-reader checklist                                                |
| Evaluation         | Recall@10, MRR, nDCG@10, zero-result rate, ANN/exact recall, p50/p95                                            |
| Fault              | Worker/DB/process/host restart, network outage, disk full, corrupt artifacts, expired leases                    |
| Package simulation | Archive, metadata, non-root ownership, lifecycle scripts, storage probe, clean/retained/destructive states      |
| NAS final          | Install, setup, ingest, search, reboot, upgrade, backup, restore, uninstall; run only after M14                 |
| Release            | Clean build, checksum, SBOM, license allow-list, secret scan, tagged-candidate test, certified-artifact install |

### Global invariants

1. No silo query executes without a resolved `SiloScope`.
2. No public/admin/MCP route is absent from the authorization inventory.
3. No offset is minted outside `packages/shared/locator`.
4. PostgreSQL never interprets application UTF-16 offsets with text substring operations.
5. Both offset pairs always address canonical Markdown.
6. No plaintext provider token, API key, password, session token, or setup token is stored or logged.
7. No long-running task depends on an HTTP process remaining alive.
8. No partial build or partial restore is searchable.
9. No search compares embeddings from incompatible model manifests.
10. No failed vision call blocks otherwise valid text ingestion.
11. No large workbook is fully loaded into memory.
12. No explicit delete leaves uniquely reachable document content.
13. No watched-source outage triggers an automatic purge.
14. No gateway widens a principal's grants.
15. No UI path bypasses the public authorization/application layer.
16. No later-milestone behavior activates early.
17. No milestone completes without proof and green remote CI.
18. No testbed result is represented as live DSM evidence.
19. No `v1.0.0` tag or final release is created before `dsm-final-proof.json` passes.

---

## 23. Final Definition of Done

Milestone implementation is testbed-complete when M0–M14 proofs pass and the immutable candidate bundle exists. NodeRag v1 is complete and DSM-certified only when the final DSM certification also passes and all of the following are true:

- A single manually installed SPK supplies the complete private appliance on supported DSM hardware.
- The package user, bundled PostgreSQL/pgvector, API, worker, embedder, and UI start in the correct order and recover after reboot.
- First-run setup is secure, resumable, understandable, and requires no shell access.
- TXT, Markdown, PDF, DOCX, and XLSX produce canonical Markdown with honest page basis and visible extraction warnings.
- Embedded images and bad/scanned PDF pages use recoverable Ollama processing with provenance.
- Every document has a managed original and canonical Markdown file with verified hashes.
- Every chunk has valid UTF-16 and UTF-8 locators into canonical Markdown.
- Browser, REST, gateway, and MCP access use identical silo-scope resolution.
- Independent read/upload/delete capabilities behave exactly as specified.
- Search-only API keys cannot exfiltrate whole documents or mutate data.
- Vector, keyword, and hybrid modes meet the measured release thresholds.
- Search results contain usable passage text, heading context, page/sheet label where meaningful, and portable provenance.
- Durable jobs survive process/database/NAS interruption without silent duplicate work or permanent `running` state.
- Missing watched files remain retained for review and source outages do not destroy indexes.
- Explicit document and silo deletion performs a complete verified purge.
- Chunk/model rebuilds do not take search offline or mix model spaces.
- Backup, blank-install restore, schema upgrade, PostgreSQL-major upgrade, and rollback are proven.
- Logs, audit, health, retention, capacity, model, and job diagnostics are operable through the UI/API.
- Accessibility, security, dependency, license, and secret gates pass.
- A clean CI build produces the same release inputs represented by the manifests and proof.
- The final SPK, checksum, SBOM, notices, release notes, documentation, and proof bundle are attached to the private v1.0.0 GitHub release.

---

## 24. Explicit v1 Exclusions

Do not add these while executing the plan:

- ARM/aarch64 NAS support.
- Remote embedding providers.
- Cross-encoder reranking.
- DSM SSO.
- Bundled LibreOffice or exact DOCX rendering.
- PPTX, HTML, EML, CSV, XLS, or standalone image documents.
- Document-level ACLs finer than silo capabilities.
- Railway, Supabase, PostgREST, Bubble, RunPod, Task Datasets, federated data, or template-document generation.
- Production-runtime Docker, Redis, or another message queue. Repository-owned WSL/Docker development and test infrastructure is explicitly allowed.
- Public package repositories, SynoCommunity publication, or auto-update.
- Automated DSM installation control beyond the written/live acceptance procedure.

The Railway documentation may inform durability, idempotency, migration, security, proof, and backup patterns. It must not expand NodeRag into the Railway project's broader product surface.

---

## 25. Required Operator Inputs

These are facts the implementation system must collect. Testbed inputs are required during Milestones 0–1; NAS inputs may be deferred until the final DSM certification and are not design choices to guess:

- WSL distribution/kernel, Docker/Compose versions and resource allocation;
- exact NAS model, DSM build, CPU, RAM, and available test access before final DSM certification;
- NAS volume/share/ACL/encryption layout before final DSM certification;
- representative non-private or approved test files for every format;
- corpus document count, total size, format/language mix, and largest files;
- Ollama endpoint, model, auth, parallelism, and data-boundary approval;
- preferred ingest window and tolerance for overnight indexing;
- backup destination and retention needs;
- final administrator responsible for golden-set relevance judgments;
- release recipient and private GitHub release access.

If a NAS input is unavailable, continue through M14 without claiming live evidence. The final DSM certification and `v1.0.0` release remain blocked rather than fabricating evidence.
