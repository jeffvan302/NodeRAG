# M05 — Durable Ingestion, Verification, Sources, and Purge Checklist

Status: implementation-complete-ci-pending

Environment: WSL/Docker testbed and non-root Linux package simulation

Recorded: 2026-09-04

## Schema and durable job contract

- [x] Forward-only migration `000004_durable_ingestion` is the expected migration head and has an immutable manifest SHA-256.
- [x] Jobs store frozen configuration, logical/physical attempts, maximum attempts, owner, epoch, expiry, heartbeat, progress, checkpoint, retry time, cancellation request, result, error class, and structured error.
- [x] Claims use database time and `FOR UPDATE SKIP LOCKED`.
- [x] Lease epochs fence stale heartbeat, progress, success, cancellation, and failure writes.
- [x] Expired leases preserve the logical attempt/checkpoint while incrementing physical attempts and lease epoch.
- [x] First claim freezes schema, parser, settings, build, and model revisions.
- [x] Transient, permanent, cancelled, and indeterminate failures have explicit durable behavior.
- [x] Terminal state and terminal event settle in the same transaction.
- [x] Ordered events are persisted before SSE exposure and use `<job-id>:<sequence>` recovery cursors.
- [x] SSE disconnect does not cancel work; cancellation is an explicit authenticated mutation.
- [x] Pause, resume, retry, cancel, job list, and job detail APIs are scoped and audited through the route contract.

## Crash, restart, fairness, and resources

- [x] Worker loss before/after heartbeat is recovered through lease expiry.
- [x] Two concurrent workers produce exactly one winner for an expired job.
- [x] A stale worker cannot commit after a new lease epoch is issued.
- [x] A PostgreSQL container restart between settlement writes and commit rolls back the partial transaction; reclaim produces one terminal result.
- [x] Query embedding priority remains ahead of background embedding; ingest/crawl precede nightly verification/future rebuild work.
- [x] Equal-priority document jobs dispatch round-robin and do not starve a later document.
- [x] Two durable CPU slots bound background CPU work.
- [x] Shared embedding and exclusive HNSW advisory locking prevents overlap.
- [x] Linux package startup uses embedder `nice 5`, worker `nice 10`, and best-effort worker `ionice` class 2 priority 7.
- [x] Local and DSM platform adapters declare equivalent background scheduling intent.

## Watched sources

- [x] Source roots must resolve beneath explicit absolute allowlisted roots.
- [x] Root and entry symlinks, traversal outside the root, invalid globs, and unconfigured roots fail closed.
- [x] Enumeration is deterministic and applies Markdown include/exclude patterns.
- [x] Source registration records an interval but leaves unattended scheduling disabled by default.
- [x] Explicit schedule enablement and due-job creation are integration-tested.
- [x] Manual crawl is authenticated, CSRF/Origin protected, idempotent, and source-scoped.
- [x] `(mtime,size)` is a fast gate and content SHA-256 is authoritative.
- [x] Unavailable root changes health but does not mark documents missing.
- [x] A healthy missing file becomes `missing`/`source_missing` and remains searchable from its managed copy.
- [x] Missing review stores an operator note without deleting indexed content.
- [x] An unchanged return becomes present without reprocessing.
- [x] A changed return creates new extraction work while retaining prior job history.
- [x] Detaching a source preserves documents as searchable `detached` managed copies.

## Chunking, locator, and integrity verification

- [x] Lists, fenced code, tables, and image-provenance blocks are recognized as structures.
- [x] Oversized tables split at rows and repeat headers only in embedding input.
- [x] Oversized code splits on lines and records continuation metadata.
- [x] Exact configured overlap, final-runt merge, and page-independent boundaries remain enforced.
- [x] Hard cuts never split a UTF-16 surrogate pair.
- [x] Unicode fixtures cover emoji, rare CJK, combining marks, ZWJ, bidi controls, Arabic, and Hebrew.
- [x] Stored chunks independently reproduce from UTF-16 character ranges and UTF-8 byte ranges.
- [x] Verification checks well-formed Unicode, document counts, and page mapping.
- [x] At most one nightly verifier job is scheduled per 24 hours.
- [x] The sweeper checks missing/hash-mismatched originals and Markdown, orphaned files/chunks, and invalid embedding/vision cache references.
- [x] Findings are durable, identity-keyed, visible through admin health, and resolved by a clean rerun.

## Document and silo purge

- [x] Document deletion requires exact `delete` capability plus matching document-ID confirmation.
- [x] Upload-only denial does not reveal document existence.
- [x] A delete-only user can purge a known ID but cannot read or enumerate silo content.
- [x] New work is stopped and live work is cancelled/drained before destructive rows are removed.
- [x] Purge state advances through `marked`, `rows_removed`, `files_removed`, and `completed`.
- [x] A non-complete operation is recoverable even after the document row is gone.
- [x] Fault injection at every destructive boundary resumes the same operation ID to completion.
- [x] File-removal failure remains retryable and records a bounded structured error.
- [x] Chunk and image references are decremented before owned rows are deleted.
- [x] Shared cache content survives the first purge and disappears when its last reference is purged.
- [x] Managed originals, canonical Markdown, and extracted document directory are removed.
- [x] Completed audit/history retains identifiers and counts but no document content.
- [x] Server-admin silo purge requires an exact slug, blocks new work, drains/cancels jobs, purges documents, drops the chunk partition, and removes silo-owned rows.

## API, package, and delivery

- [x] `platform/openapi.m05.json` describes source, job, SSE, health, document purge, and silo purge routes.
- [x] Every browser mutation requires expected Origin, CSRF, and idempotency.
- [x] Job/source reads and mutations narrow through authenticated silo scope.
- [x] Admin health and silo purge require server administration.
- [x] The thin package includes migration 000004 and the M05 OpenAPI contract.
- [x] Non-root package simulation registers/crawls a watched source, searches it, replays SSE, purges an upload, restarts, and re-searches retained source content.
- [x] Two package builds are byte-identical at 1,136,640 bytes and SHA-256 `9a7d111f7f7d9c2317278a7e17cbf2362d68118d274be0f1b1bfe1fafacf579b`.
- [x] Frozen strict-peer install, migrations, TypeScript, lint, format, boundaries, unit, build/smoke, licenses, secrets, and repository hygiene pass locally.
- [x] Four PostgreSQL 17/pgvector integration files pass 28 tests locally.
- [x] M04 CI is manual-only before M05 becomes the active evidence workflow.
- [ ] The implementation commit is pushed to `main` and all four M05 GitHub jobs succeed.
- [ ] `m05-proof.json` records exact implementation workflow and job IDs.
- [ ] The proof-closure and certification commits pass M05 CI.
- [ ] Annotated tag `m05-complete` resolves remotely to the certification commit.

M06 remains unauthorized until every delivery checkbox is complete. No M05 testbed result closes a live DSM register row.
