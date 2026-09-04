# Milestone 11 Checklist — Zero-Downtime Rebuilds and Model Lifecycle

Status: testbed complete

## Immutable planning and staging

- [x] Model manifests have a canonical digest and reject changes to model, artifact, tokenizer, quantization, dimension, pooling, normalization, prefix, and license inputs.
- [x] Builds freeze the chunk profile, model digest, dimensions, activation class, and confirmed proposal linkage.
- [x] Proposal creation estimates source characters, chunks, embed duration, vision reuse, temporary bytes, reserve, and currently available bytes without creating build work.
- [x] A non-expired, capacity-valid proposal requires a separate administrator confirmation before staging tables or jobs are created.
- [x] Each selected silo receives a detached, bound-constrained staging table and durable low-priority document jobs with frozen build configuration.
- [x] Embedding-cache reuse requires the exact embedded-text digest, model-manifest identity, and vector dimension.
- [x] Every token-count and embedding request carries the frozen model-manifest digest and dimension; the embedder separates testbed model spaces and a fixed production runtime rejects an unavailable manifest or dimension.

## Durable work and verification

- [x] Completed documents record durable build/silo/document checkpoints with Markdown, embedded-text, and model-manifest digests.
- [x] Pause, resume, cancellation, and retry preserve completed checkpoints; discard requires the exact destructive phrase and an audit event.
- [x] HNSW, GIN, and document/ordinal indexes are created only after population under the database resource gate.
- [x] Verification records document coverage, current source/checkpoint hashes, row count, locator validity, vector dimension, finite values, index existence, and sampled exact-versus-HNSW recall.
- [x] A failed verification leaves the staging table detached and unsearchable.

## Atomic activation, rollback, and cleanup

- [x] Search joins only per-silo `active` build state and rejects a request spanning incompatible active model manifests.
- [x] Search holds the shared cutover lock across active-model resolution, query embedding, and retrieval; activation takes the exclusive lock so an old-model query vector can never reach new-model rows.
- [x] Same-model profile changes can swap a verified silo independently while retaining its former table for rollback.
- [x] Model/revision changes require every active silo and update partitions plus active model metadata in one transaction.
- [x] Dimension changes build a separately typed partitioned parent and rename the complete parent plus metadata atomically.
- [x] Rollback restores the prior tables/model metadata before any old data may be removed.
- [x] A silo cannot accumulate ambiguous rollback chains: another activation is rejected until its prior activation is rolled back or cleanup-authorized, and rollback verifies that its build is still active.
- [x] Cleanup requires a separate typed authorization, is transactionally retryable, records progress, and writes authorization/completion audit events; after rollback it removes only the rejected new tables/parent, never the restored active data.
- [x] Keyword and vector search remain available during same-model and all-silo model activation rehearsals, with queries bound to whichever complete active model is visible to their transaction.

## Contracts, packaging, and certification

- [x] Migration `000009_zero_downtime_rebuilds` is forward-only, checksummed, and the expected migration head.
- [x] The public admin lifecycle is represented in `platform/openapi.m11.json` and the authorization inventory.
- [x] The package uses the M11 OpenAPI contract and includes migration 000009 plus its checksum manifest.
- [x] Unit tests pass locally.
- [x] The full PostgreSQL integration suite passes locally, including same-model, revision, dimension, rollback, cleanup, and active-search cases.
- [x] Typecheck passes locally.
- [x] GitHub M11 workflow is green on the implementation commit.
- [x] Proof-only commit is green on GitHub.
- [x] Final evidence commit is green and annotated tag `m11-complete` resolves to the certification commit remotely.

## Claims boundary

This checklist certifies the WSL/Docker and Linux CI testbed. The deterministic test runtime honors immutable model digests and dimensions so revision and parent-swap behavior is exercised without representing synthetic vectors as release-model evidence. Continuous search and atomic database behavior are proven there; installed multi-artifact runtime availability, NAS I/O contention, real DSM service responsiveness, thermal behavior, reboot timing, and Package Center lifecycle remain in DSM-022 for final certification.
