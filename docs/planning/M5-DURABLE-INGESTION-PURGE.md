# Milestone 5 — Durable Ingestion, Verification, Sources, and Purge Record

Status: implementation-complete-ci-pending

Recorded: 2026-09-04

Evidence environment: Windows/WSL 2, Docker Desktop, PostgreSQL 17 with pgvector, and non-root Linux package simulation; not DSM

Certification ceiling: `testbed-complete`

## Outcome

Milestone 5 converts the M04 Markdown slice into an operable, restart-safe ingestion system. Jobs now have fenced leases, heartbeats, checkpoints, retry classes, ordered events, explicit control operations, fair document dispatch, and transactionally atomic settlement. Watched Markdown sources use allowlisted roots and conservative missing-file behavior. Nightly locator and storage verification surfaces durable findings. Document and silo deletion use explicit authorization and auditable, resumable purge state machines.

This milestone deliberately remains Markdown-only. TXT, PDF, DOCX, XLSX, vision extraction, full hybrid retrieval, the production UI, final native/model packaging, rebuild/evaluation/recovery/soak, and live DSM certification remain assigned to M06–M14 and the final DSM gate.

## Forward-only schema and durable state

Migration `000004_durable_ingestion` advances the expected head and has SHA-256 `17bb57292f7291f009e18ed32e6fd49906d82b684f5d3ef12efa3e963c2eb30c`. It adds:

- source scheduling, operator notes, generation/failure counters, and last-success/failure timestamps;
- `present`, `missing`, and `detached` document source states;
- structural chunk and continuation metadata;
- job snapshots, logical/physical attempts, lease epochs, heartbeat, progress, checkpoint, cancellation, retry, result, and structured error fields;
- per-document dispatch timestamps, durable integrity findings, purge operations, and fenced resource leases;
- one-live-source-job guards, expired-lease indexes, and PostgreSQL notifications for persisted job events.

Every change is forward-only and included in the migration checksum manifest and thin package. Historical migrations remain immutable.

## Fenced jobs, recovery, and events

Claims use database time, `FOR UPDATE SKIP LOCKED`, and a monotonically increasing lease epoch. A worker may settle, heartbeat, or report failure only while its owner and epoch still match the row. Reclaiming an expired physical lease increments the physical attempt and epoch while preserving the logical attempt and checkpoint. A stale worker is rejected even if it later returns a plausible result.

The first successful claim freezes the schema revision, parser revision, settings, active build, and model manifest into the job. Progress and checkpoints are durable. Failures are classified as transient, permanent, cancelled, or indeterminate; transient failures enter bounded retry wait, while permanent and cancelled work settles terminally.

Terminal job state and its event are written in one transaction. Ordered `job_event.sequence` values form the recovery cursor. `GET /v1/jobs/stream` replays persisted events from `Last-Event-ID: <job-id>:<sequence>` and can continue with PostgreSQL notifications. Closing the stream has no cancellation side effect. Cancellation is an explicit authenticated mutation and is observed at worker heartbeats/stage boundaries.

The integration matrix proves:

1. a worker death before/after heartbeat followed by expired-lease reclaim;
2. exactly one winner when two workers contend for the same expired job;
3. stale-epoch completion rejection;
4. a real PostgreSQL container restart after terminal writes but before commit, followed by rollback, reclaim, and one durable terminal result;
5. cancellation request, cancelled settlement, disconnect independence, and event replay;
6. transient and permanent error behavior with structured state.

## Priority, fairness, and resource control

Lower numeric job priorities run first. Query embedding retains the embedder protocol's high-priority queue; normal ingestion and crawl work run ahead of nightly verification and future rebuild work. Within equal priority, `document_dispatch.last_claimed_at` gives the least-recently-dispatched document first. The test creates repeat work for the first document and proves that the second document is selected before that repeat.

Two durable CPU lease slots bound extraction/embedding work across worker processes. Embeddings take a shared PostgreSQL advisory lock, while HNSW construction takes the corresponding exclusive lock, so index construction cannot overlap active embedding. Resource releases are fenced and occur in `finally` paths.

The platform contract records conservative background scheduling. Linux package startup runs the embedder at `nice 5` and the worker at `nice 10`; the worker uses best-effort `ionice` class 2 priority 7 when available. Local and DSM adapters expose the same intended values, leaving live DSM behavior for final certification.

## Watched source behavior

Administrators can register, inspect, update, detach, manually crawl, and review missing files through authenticated APIs. Browser mutations require trusted Origin, CSRF, and idempotency. Source paths must resolve beneath an explicit `NODERAG_SOURCE_ROOTS` allowlist. Roots and enumerated entries reject symlinks; traversal and roots outside the allowlist fail closed. Enumeration is deterministic, Markdown-only, and applies validated include/exclude globs.

Schedules are disabled on creation even when an interval is supplied. They become active only through an explicit update. The worker enqueues due crawls idempotently; the integration test forces an enabled schedule due and verifies that exactly one live crawl is created.

A healthy crawl first evaluates `(mtime,size)` as a fast gate and treats SHA-256 as authoritative whenever content may have changed. Behavior is conservative:

| Observation                                | Durable behavior                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Root unavailable or denied                 | Source health changes; documents are not marked missing                                                    |
| Healthy root lacks a known file            | Managed original/index remain searchable; document becomes `missing`/`source_missing` with `missing_since` |
| Missing file returns with the same SHA-256 | Document returns to `present`/`ready` without reprocessing                                                 |
| Missing or present file returns changed    | Existing job history remains; old live work is cancelled and a new extraction generation is indexed        |
| Source is detached                         | Source row is removed; retained documents become `detached` and remain searchable                          |

Operator review notes are stored separately from source content. Managed copies remain the authoritative indexed content after source disappearance.

## Markdown structures and exact locators

Chunk construction recognizes headings, list items, fenced code, tables, and image-provenance blocks. Ordinary structures remain atomic when they fit. Oversized tables split at row boundaries and repeat the header only in embedding input; stored passage text remains an exact canonical slice. Oversized code splits on lines and records continuation metadata. Adjacent overlap remains the configured exact value, page boundaries do not force splits, and a final remainder below the profile threshold merges into the preceding chunk.

All hard cuts are surrogate-safe. Unicode fixtures include emoji, a ZWJ family sequence, rare CJK, combining marks, bidi controls, Arabic, and Hebrew. Before storage and during verification, both locator equations must hold:

```text
canonical.slice(characterStart, characterEnd) == chunk.text
UTF8(canonical)[byteStart:byteEnd].decode() == chunk.text
```

The verifier also checks well-formed UTF-16, document character bounds, and page mapping.

## Integrity verification and health

The worker creates no more than one nightly verification job in a 24-hour window. The locator verifier samples up to 300 chunks per active silo by default. The storage sweeper checks managed original/canonical presence and SHA-256, orphaned managed directories, orphaned chunks, and embedding/vision cache reference counts.

Findings are durable and keyed by category plus stable identity. Repeated detection updates the same row; a clean follow-up marks it resolved rather than deleting history. Server-admin health returns `degraded` with open finding IDs/categories and returns to `ok` after the underlying drift is repaired and rechecked. A test corrupts a stored passage, proves the locator finding and degraded health, repairs it, and proves automatic resolution.

## Document and silo purge

Document purge requires the exact silo `delete` capability and a matching document-ID confirmation. Lack of delete returns a non-enumerating denial. A delete-only principal may purge a known ID while still receiving no search results.

The durable state machine is:

```text
marked -> rows_removed -> files_removed -> completed
```

It cancels or drains live document work, marks the document purging, decrements cache references, deletes zero-reference cache entries, removes silo chunks and document-owned rows, removes the managed document directory, records destroyed counts, and writes a content-free audit result. Existing non-complete operations are found before the document row, which makes retries possible after destructive database work has already committed. File deletion errors are recorded without losing the retryable stage.

Fault injection interrupts a purge at `marked`, immediately after `rows_removed`, and immediately after `files_removed`. Every retry resumes the same operation ID and reaches `completed`. A separate shared-content test proves the first purge preserves cache entries at reference count one and the second removes the zero-reference entries. Idempotency replay returns the original result.

Server-admin silo purge requires the exact silo slug. It switches the silo to `purging` so new scope/job claims stop, cancels or drains work, runs document purges, drops the silo chunk partition, removes the silo and cascading grants/sources, and retains a non-content audit identity.

## API and package behavior

`platform/openapi.m05.json` records the M05 source, job, event, health, document-purge, and silo-purge surface. All job/source reads are narrowed by authenticated silo scope. Every state-changing route requires the planned capability plus browser Origin/CSRF and idempotency controls.

The deterministic thin-SPK simulator now starts the packaged API, worker, and embedder as non-root with a read-only root filesystem, registers an allowlisted watched source, crawls and searches it, replays durable SSE completion, purges a direct upload, restarts all application processes, and proves the watched search result survives. The simulator still uses the explicit test embedder; the production native/model-bearing package remains a later milestone.

## Reproducible facts and local gate

| Artifact                      | Value                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| Dependency lock SHA-256       | `c299069355f2b314dd67b1607b196847b9cd701bcc6a319b2ac0adee7f8ed9c7` |
| Migration 000004 SHA-256      | `17bb57292f7291f009e18ed32e6fd49906d82b684f5d3ef12efa3e963c2eb30c` |
| M05 OpenAPI SHA-256           | `c26bb64241f96df742a7f149587361ead7b0d87ca525213f19f556c88c7df64c` |
| Thin SPK bytes                | `1,136,640`                                                        |
| Thin SPK SHA-256 (two builds) | `9a7d111f7f7d9c2317278a7e17cbf2362d68118d274be0f1b1bfe1fafacf579b` |
| Server bundle SHA-256         | `92d391b782ad94d2a1c1abe2831166880348dbd6dd49562758cf1d2bb8f6c349` |
| Worker bundle SHA-256         | `a84636676f4c9de004a4d5f9edf1286cd445f316a4e1ef8e255a0ee7155fdd71` |
| Embedder bundle SHA-256       | `a89f97a3e10b8e6315f240b1d450ca7d6fcb74a23a45fbc2a0bf135a3dcc88d2` |

The final local gate uses a frozen strict-peer dependency install, verifies four migration checksums, passes strict TypeScript, ESLint, Prettier, 58-module/85-dependency boundaries, 15 unit files/27 tests, production build and smoke, six license classes, secret scan, repository hygiene, four PostgreSQL/pgvector integration files/28 tests, two byte-identical package builds, archive verification, and the non-root lifecycle simulation.

The M05 GitHub workflow separates repository quality, the cumulative integration suite, M01 Linux/ONNX compatibility, and deterministic thin-SPK verification. M04 has been frozen to manual-only so later commits cannot replace its certified evidence.

## Deferred DSM and later work

No result here closes a row in `docs/Implementation/dsm-deferred-register.md`. Live package identity/ACLs, Synology Node/native ABI, filesystem and share behavior, reverse proxy, reboot recovery, q8 memory/thermals, upgrade/backup, and soak remain for the exact M14 release candidate on the user's Synology.

M06 is authorized only after the implementation, proof-closure, and certification commits all pass M05 CI and annotated tag `m05-complete` is remotely verified.

## Gate state

All local M05 gates pass. GitHub implementation, proof-closure, and certification evidence is pending.
