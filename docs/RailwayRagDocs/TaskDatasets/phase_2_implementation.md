# Task Dataset Phase 2 Implementation

Phase 2 turns the Phase 1 persistence foundation into a safe committed-data
read plane. It provides catalog, describe, coverage, record/source retrieval,
operator visibility, and logical clear backed by resumable physical purge. It
does not expose model-authored writes or modify RAG ranking yet.

## Delivered Boundary

Implemented:

- catalog groups by tenant + saved Task + silo + explicit project/no-project;
- describe group and definition contracts, including the model-facing purpose
  description and extraction/search/identity policies;
- stable-document-ID coverage summaries with digest-change diagnostics;
- committed record list, full-text search, exact logical-key lookup, declared
  JSON-field filters, safe projections, conflict listing, and record detail;
- committed source-document/source-snapshot paging and diagnostics;
- publication transaction and purge-job inspection;
- API-key capabilities `task-datasets:read` and `task-datasets:write`;
- optimistic name/description revision updates;
- immediate logical definition/group clear;
- bounded, resumable physical purge in maintenance and scheduled maintenance;
- a top-level Task Datasets operator browser; and
- direct fixture, schema, cursor, service, worker, API documentation, and build
  validation.

Deferred deliberately:

- model create/claim/upsert/source-seal/fail operations (Phase 3);
- passing a dataset ID to RAG and excluding covered stable document IDs before
  rank/Top K (Phase 3 database receipt work and Phase 4 Task wiring);
- saved Task transaction opening and atomic final commit integration (Phase 4);
- template ingestion suggestions (Phase 5); and
- record vector/hybrid search (Phase 6).

This boundary is important. Phase 2 can be tested against direct committed
fixtures without granting a model any durable write capability.

## Read Consistency Model

### Committed visibility

Definition lists require `state=active`; record queries require `state=active`;
source reads permit only `committed` and `not_applicable`. Open, claimed,
processing, staged, sealed, failed, superseded, removed, and deleting data is
not part of the public committed record/source plane.

Operational coverage may count all source states so an operator can understand
the group, but covered/uncovered decisions use only committed and
not-applicable stable document IDs.

### Snapshot watermarks

The first record page captures the greatest visible `record_seq`. Every later
page is constrained to that watermark. A record added after page one therefore
cannot appear halfway through the traversal.

The signed cursor contains:

- cursor version and kind;
- group and definition IDs;
- group active generation;
- canonical hash of query/filter/projection/page-size/sort;
- page number and expiration; and
- source ID or record sequence continuation state.

The token is HMAC-SHA256 signed with the installation admin-session secret and
base64url encoded. It expires after 15 minutes. Tampering, use against another
dataset, or use with another query returns a bounded client error. A generation
change returns `410 task_dataset_cursor_stale`.

### Bounded payloads

- Record pages contain at most 200 records and 512 KiB of serialized records.
- Source pages contain at most 200 source snapshots.
- Projection contains at most 20 declared JSON pointers.
- Filters contain at most 12 scalar comparisons on declared filterable paths.
- Record detail returns at most 100 source contributions and reports
  `provenanceTruncated` when the cap is reached.
- Evidence returned for a contribution is independently bounded.

List/search returns stored summaries or declared projections. It never returns
every full payload and all provenance by default.

## Search Contract

The Phase 2 record endpoint supports:

1. full-text search over the definition's configured `searchablePaths` and the
   materialized `search_tsv` index;
2. exact canonical logical-key lookup;
3. conflict-state selection;
4. scalar `eq`, `neq`, `gt`, `gte`, `lt`, and `lte` JSON filters over declared
   `filterablePaths`;
5. projections limited to declared `summaryPaths`; and
6. forward or reverse stable record-sequence traversal.

A model or caller cannot invent an expensive arbitrary JSON path. The stored
definition remains the allowlist. Vector search policy is present in the
definition contract but is not executed in this phase.

## Coverage Contract

`task_dataset_coverage_summary` locks coverage to the group's established
scope:

- no project: every ready, non-deleted document in the silo;
- explicit project: only ready, non-deleted documents with a matching
  `document_project_memberships` row.

It returns scope and definition identity, generation/revision, source-state
counts, ready documents in scope, committed covered IDs, uncovered IDs, and
changed observed Markdown digests.

Coverage remains based on the stable document ID. A re-ingestion that changes
the Markdown SHA-256 does not make that ID pending. The diagnostic count lets
an operator/model decide that the dataset is no longer sufficient and perform
the explicit clear/recreate behavior selected for this product.

## Logical Clear

Clear is a database transaction, not a row-by-row API loop. The
`task_dataset_clear` function:

1. verifies tenant, Task, group, and optional active definition;
2. takes the same deterministic group advisory lock as publication;
3. row-locks the group and active publication transactions;
4. resolves every physical definition revision in the selected logical key,
   or every definition in the group;
5. records counts for definitions, records, sources, claimed sources, and
   invalidated transactions;
6. discards open/sealed/committing/commit-failed transactions and removes their
   publication authority;
7. changes selected definitions to `deleting`, immediately removing them from
   catalog/read eligibility;
8. recalculates group counters from remaining active definitions;
9. enqueues a purge job with exact dataset and invalidated transaction IDs;
10. advances active generation, clears the publication lease, and sets the
    group to `ready` or `empty`; and
11. returns the purge job and logical-clear summary.

The transaction either completes all eleven effects or none. Old cursor/run
authority cannot cross the new generation. The next Task run sees no selected
definition and may design it again from scratch.

Both public clear endpoints require `Idempotency-Key` and
`{"confirm":true}`. The operator UI adds an explicit confirmation explaining
that the data disappears now and is deleted physically in the background.

## Bounded Physical Purge

`task_dataset_run_purge_batch(job_id,batch_size)` locks one job using
`FOR UPDATE SKIP LOCKED`, limits a batch to 1-5,000 rows, and proceeds in foreign
key-safe phases:

1. search receipt documents;
2. contributions;
3. contribution batches;
4. search receipts;
5. records;
6. run usage;
7. source snapshots; and
8. definitions.

Every successful batch updates per-table deleted counts, phase cursor, and
heartbeat, then commits. The next invocation resumes from that durable cursor.
When a phase finds no victims, the function advances without inventing work.
Completion marks the job succeeded and repairs `purge_failed` group state.

The maintenance worker:

- accepts an explicit job wake from web after clear;
- also drains jobs on the regular scheduled-maintenance pass;
- selects queued jobs, retryable failures, and running jobs with stale
  heartbeats;
- caps jobs and batches per invocation;
- treats a locked/missing job as non-failure; and
- records bounded errors and a visible `purge_failed` group state on failure.

The API does not wait for physical deletion. If the maintenance wake is
unavailable, it returns `queued=true`, `wakeAccepted=false`, and the wake error.
The durable job remains available for the scheduler. Logical clear never rolls
back because a best-effort wake failed.

## Public API

The canonical route and request reference is in [API usage](../api-usage.md).
Phase 2 adds:

- Task-scoped group and definition catalog routes;
- definition metadata update and definition/group clear routes;
- group-scoped coverage, source, record, conflict, and transaction routes; and
- dedicated API-key read/write scopes.

All dynamic Next.js route parameters are awaited under the current route
handler contract. Route handlers are dynamic and use the established API-key,
readiness, audit, error, and idempotency middleware.

## Operator Browser

The top-level `/task-datasets` screen provides the inspection path requested
for staged testing:

1. select a silo;
2. select a saved Task;
3. select its project-specific or whole-silo no-project group;
4. select one of the active definitions in that group;
5. inspect definition purpose/schema/policies, counters, coverage, committed
   sources, projected/searchable records, transactions, and purge jobs; and
6. clear one definition or the complete group with a visible confirmation.

Project scope is displayed on the group. No dataset is shared between Tasks,
even when the descriptions look similar. All steps within the same saved Task,
silo, and project selection resolve to the same group.

## Security and Concurrency

- Durable tables and coordinator/read/clear/purge RPCs remain service-role-only.
- API key scopes are checked before the service-role client is used.
- Every service query includes tenant and owning group/definition constraints.
- Public reads never accept arbitrary schema/tool execution behavior.
- JSON schema and pointer limits are shared in `@bubble-rag/rag-core`.
- Signed cursors prevent clients from forging traversal state.
- Optimistic `expectedRevision` prevents silent metadata lost updates.
- Group advisory locks serialize publication and clear.
- `SKIP LOCKED` permits several maintenance instances without double-deleting.
- Clear stores exact UUID arrays in an internal purge cursor rather than using
  unresolved names or broad tenant deletes.

## Validation

The Phase 2 SQL smoke verifies:

- the three new RPCs are executable only by `service_role`;
- a committed fixture produces one stable-ID covered document and no uncovered
  document;
- logical clear returns exact counts, advances generation, immediately hides
  the active definition, sets the group empty, and queues a purge;
- a one-row bounded batch loop reaches succeeded; and
- physical purge deletes definition, source, and record while retaining the
  reusable generation-fenced group shell.

Unit/integration tests cover schema/pointer bounds, projection behavior,
cursor round-trip, tampering, query binding, expiry, stale-generation error
mapping, purge queue draining, maintenance scheduling, and the existing web
and core suites. Release validation additionally runs database lint, all
workspace tests, lint, typecheck, production builds, documentation coverage,
platform-contract checks, hosted migration, and staging SQL/API smoke.

The local database reset currently applies every migration including Phase 2.
The repository's general seed then reports its pre-existing missing
`rag_settings` relation; Phase 1 and Phase 2 rollback-only SQL smokes run
successfully against the fully migrated database before seed content is needed.

## Phase 3 Entry Point

Phase 3 is implemented in
[Phase 3 implementation](phase_3_implementation.md). It adds database
claim/heartbeat/upsert/source-seal/receipt-seal/fail operations, dataset-aware
RAG receipt creation, model tool schemas, idempotent contribution batches, and
overlay materialization without weakening Phase 2's committed visibility,
generation fencing, signed cursor binding, or bounded responses.
