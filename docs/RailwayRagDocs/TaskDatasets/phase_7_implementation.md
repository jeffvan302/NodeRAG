# Task Dataset Phase 7 Implementation

## Outcome

Phase 7 adds the Goldilocks retrieval path that was reserved in the original
Task Dataset design: semantic search is available, but only over a deliberate,
bounded projection of each record. It does not embed arbitrary dataset JSON,
evidence excerpts, source documents, or presentation data.

The same implementation adds reciprocal-rank-fused hybrid search and expands
the top-level Task Datasets browser into an operational explorer. A saved Task
can now use semantic or hybrid search against both committed records and the
current run's staged overlay. Operators can navigate the exact silo, Task,
project/no-project group, and dataset and inspect records, source documents,
dated conflicts, coverage, embedding status, transactions, and purge/deletion
progress. Raw vectors are never returned by either the operator endpoint or
the model tool.

The database head for this phase is:

```text
20260826000300_task_dataset_phase_seven
```

The rollout kill switch remains `TASK_DATASETS_ENABLED=false`. It bypasses the
complete Task Dataset runtime, including semantic indexing and retrieval,
without changing standalone Ask or standalone Extraction behavior.

## Product Boundary

Phase 7 preserves the ownership decisions from Phases 1–6:

- a dataset belongs to exactly one saved Task + silo + explicit project or
  no-project group;
- every step in one Task run shares the same group and run transaction;
- another Task cannot search or contribute to that dataset;
- a template suggestion is still inert outside a verified saved Task run;
- semantic search is opt-in per dataset definition, not globally forced;
- the model may continue to use exact filters and text search for deterministic
  identities, totals, dates, statuses, and numeric thresholds; and
- source text and stored records remain untrusted data, never instructions.

Semantic search is therefore an additional bounded read strategy. It does not
replace the stable-document-ID RAG exclusion workflow. The normal recurring
run remains:

1. inspect the exact group's dataset catalog;
2. pass the relevant dataset ID to RAG so committed source document IDs are
   excluded before RAG ranking and Top K;
3. compile only newly returned documents into staged Task Dataset records;
4. semantically or textually query the active-plus-current-run record overlay;
5. generate later Task steps from the compiled records; and
6. publish coverage, records, definitions, and embeddings only when the whole
   Task transaction commits.

## Definition Contract

A definition enables semantic retrieval with a bounded policy:

```json
{
  "semanticSearchPolicy": {
    "enabled": true,
    "embeddingPaths": ["/recipient", "/program", "/summary"]
  }
}
```

Every path must be a non-root RFC 6901 pointer declared by the record schema.
The same maximum of 24 policy paths applies. An enabled policy must contain at
least one path. The server renders only these values into semantic text, in
configured order, with the JSON pointer retained as a field label. Individual
values are bounded and the complete projection is capped at 12,000
characters.

This contract is intentionally different from embedding the complete payload:

- identifiers can remain exact/filter-only when they add no relevance value;
- large evidence arrays and conflict variants cannot enter the vector input;
- undeclared future fields cannot silently expand embedding cost;
- presentation-owned template data remains excluded; and
- the dataset definition itself explains why the semantic index exists.

Template ingestion may now propose `enabled: true` when the retrieval-planning
specialist identifies a later saved-Task step that benefits from relevance
retrieval. Its prompt explicitly keeps semantic paths deliberate and bounded.
The deterministic definition validator still verifies every path, and the
semantic policy is included in the template suggestion's semantic digest.

## Persistence Model

Migration `20260826000300_task_dataset_phase_seven.sql` adds two tables.

### `task_dataset_record_embeddings`

This is durable, portable dataset content. One row identifies:

- tenant, group, dataset, generation, and originating run transaction;
- record ID and exact record revision;
- semantic-policy digest;
- SHA-256 digest of the bounded semantic text;
- embedding provider, model, dimensions, and version;
- the vector;
- `staged`, `active`, or `superseded` visibility; and
- creation, update, and reindex timestamps.

The unique namespace is record + revision + policy digest + embedding version.
The current embedding configuration is part of the version, so a provider or
model change can build a new index profile without deleting the prior record
meaning. Supported dimensions are 384, 768, 1024, and 2560. The first three
use typed HNSW vector cosine indexes; 2560 uses the existing half-vector cosine
strategy to remain within pgvector's index-width boundary.

The table is included in portable backups after `task_dataset_records`, which
preserves foreign-key restore order. It cascades with its record, definition,
group, transaction, and tenant ownership.

### `task_dataset_record_embedding_jobs`

This is ephemeral worker coordination state. A job contains the bounded
semantic text and its digest, exact record revision and policy digest,
requested/current embedding profile, attempt count, lease owner/expiry, state,
error, and timestamps.

Jobs use `queued`, `processing`, `completed`, `failed`, or `discarded`. They
are excluded from portable backups and declared ephemeral in the redaction
contract. Restored durable records can be re-queued for the installation's
current embedding profile.

Both tables have service-role-only RLS policies. Scope-guard triggers reject a
row unless its tenant, group, definition, generation, transaction, record, and
record revision agree. Ownership fields are immutable after insertion.

## Record Lifecycle And Namespace Fencing

The record lifecycle trigger maintains semantic correctness without asking
the model to track jobs:

1. A staged or active record under an enabled semantic policy produces a
   bounded projection and policy digest.
2. If a matching ready embedding already exists, its visibility is aligned to
   the record's staged or active state.
3. A changed record revision, semantic payload, or policy digest supersedes
   the old ready embedding and discards stale queued/processing jobs.
4. A missing namespace queues an idempotent embedding job.
5. A deleted, superseded, or otherwise hidden record supersedes its embeddings
   and discards outstanding work.
6. Commit changes the staged record to active inside the existing atomic Task
   publication transaction; the matching embedding becomes active in the same
   transaction.
7. Failed/cancelled run discard deletes staged records and their embeddings or
   jobs through the existing transaction cascades.

Changing a dataset's semantic policy changes its policy digest. Old vectors
therefore cannot satisfy a query under the new definition even if their record
IDs and embedding model still match. Clear/recreate also changes the visible
definition/generation namespace, makes old signed cursors stale, and queues a
fresh build. Re-ingesting a source document under the same stable document ID
still does not reopen source coverage; as agreed, a clear/recreate is required
for that refresh contract.

## Worker Pipeline

The existing worker poll loop now claims Task Dataset embedding jobs after its
document/template queues. Claiming uses `FOR UPDATE SKIP LOCKED`, so Railway
worker replicas can process jobs concurrently without duplicating ownership.
A claim:

- validates the worker key and bounded lease duration;
- prioritizes staged records so later steps in the current Task run can use
  them quickly;
- reclaims expired processing leases;
- increments attempts; and
- rejects records that are hidden, deleted, stale, or no longer semantically
  enabled.

For `auto` jobs, the worker uses the tenant's current embedding configuration.
For a search-triggered profile job, it resolves and verifies the requested
provider/model/dimensions/version. It embeds the server-built semantic text
through the same provider and fallback path used by document embeddings, then
completes the job only if the lease, record revision, and policy digest still
match.

Retryable failures return the job to `queued` until the fifth claim. Terminal
failures become visible as `failed`. A completion that discovers a changed
record or policy is discarded rather than publishing a stale vector.

## Semantic And Hybrid Retrieval

Record reads now accept:

```text
mode=text|semantic|hybrid
```

`text` remains the default and preserves the Phase 2 behavior. `semantic` and
`hybrid` require non-empty query text and an enabled semantic policy.

The retrieval sequence is deliberately ordered:

1. verify tenant + group + dataset + active/current-run definition scope;
2. build the query vector with the current embedding profile;
3. queue only visible records missing that exact profile/revision/policy;
4. give the worker a short bounded catch-up window;
5. create the active-plus-current-run overlay;
6. apply record visibility, snapshot watermark, conflict state, and every
   allowlisted typed JSON filter;
7. only then calculate semantic and/or lexical candidates;
8. limit each candidate window; and
9. rank, page, project, and apply the response-byte ceiling.

This means a record outside an exact region/date/status/budget filter cannot
consume semantic Top K and displace an eligible record. Filters are never
applied after vector ranking.

Semantic scoring uses cosine similarity. Hybrid mode builds independent
semantic and full-text candidate ranks and combines them with reciprocal rank
fusion using the stable constant 60:

```text
hybrid_score = 1 / (60 + semantic_rank) + 1 / (60 + text_rank)
```

A candidate present on only one side remains eligible. The final order is
hybrid score, semantic score, text score, then stable record ID. Returned
record summaries may include the three scores, but never the query vector or
stored record vector.

## Current-Run Overlay And Catch-Up Behavior

The model tool passes the shared Task Dataset run transaction into queue,
status, and ranking functions. The visible record set is:

- staged records belonging to this exact current run; plus
- committed active records whose logical identity is not shadowed by a staged
  record in the same run.

The worker prioritizes the staged jobs. A model read waits for at most about
1.5 seconds, while the operator/public committed read waits about 1.2 seconds.
These are responsiveness windows, not transaction timeouts.

If indexing is still incomplete, the response explicitly includes:

- `semanticIndexPending: true`;
- the current eligible/ready/pending counts and job states;
- `semanticFallbackAvailable: true`;
- the requested and actual retrieval mode; and
- embedding wait and query-vector latency diagnostics.

Hybrid mode continues with its lexical candidates and reports
`retrievalMode: hybrid_partial`. Semantic mode returns only records that are
ready for the exact namespace and tells the model that deterministic
`mode: text` with the same allowlisted filters remains available. If the
semantic path itself errors, hybrid mode automatically returns the bounded
text fallback; pure semantic mode returns a recoverable tool error with the
same next step.

Continuation is withheld while an index is incomplete so one ranked snapshot
cannot silently change between pages.

## Paging, Bounds, And Cursors

Semantic/hybrid reads use a new signed `ranked_records` cursor containing only:

- group and dataset IDs;
- active/target generation;
- query hash;
- snapshot record-sequence watermark;
- bounded offset;
- requested mode;
- embedding version;
- page and expiration.

It contains no vector. The query hash binds query text, filters, projection,
conflict state, page size, embedding profile, and current run transaction.
Changing any of these rejects cursor reuse. Clear/recreate or generation
change returns the existing stale-cursor behavior.

Phase 7 retains the 200-record page maximum and 512 KiB record-response limit.
The semantic ranked window is capped at 10,000 and the cursor offset cannot
exceed that bound. Missing-index queue calls are capped at 500 records per
request, while the database hard ceiling is 2,000.

## Model Tool Behavior

The `task_dataset.search` operation accepts `mode: text`, `semantic`, or
`hybrid`. Its model-facing description now encourages the intended division:

- use catalog descriptions before designing new storage;
- use RAG with the dataset ID to exclude committed document IDs;
- use exact filters/text for known values and deterministic reads;
- use semantic/hybrid for relevance retrieval over large compiled datasets;
- use the same group from every Task step; and
- treat index-pending responses as a reason to use text/filter fallback or
  retry, never as evidence that records do not exist.

The tool response preserves source-document summaries for records returned by
ranked search. The document summary remains document-level; evidence pages are
available through record detail/provenance rather than being copied into the
RAG exclusion list.

## Public And Internal Read Surface

The existing public record endpoint now supports:

```text
GET /api/v1/task-dataset-groups/{groupId}/datasets/{datasetId}/records
  ?mode=hybrid
  &query=grant%20programs%20for%20rural%20hospitals
  &filters=[{"path":"/status","op":"eq","value":"open"}]
  &select=/grant_id,/recipient,/summary
  &pageSize=50
```

It retains the `task-datasets:read` API-key scope, signed cursor, allowlisted
projection/filter enforcement, and byte ceiling. Responses now report
`requestedMode`, `retrievalMode`, `semanticIndexPending`, embedding status and
profile, and ranking scores when applicable.

The authenticated internal explorer route additionally exposes an embedding
overview: current profile, readiness counts, job-state summary, and recent
embedding metadata. Its explicit `vectorsExposed: false` contract prevents the
vector column from entering browser JSON.

## Operator Explorer

The top-level **Task Datasets** page now supports the complete requested
navigation hierarchy:

1. silo;
2. saved Task;
3. project-specific or explicit no-project Dataset Group; and
4. dataset definition.

Project IDs are resolved to project names. The group selector retains visible
state and generation so operators can distinguish active, empty, and deleting
scopes.

Each selected dataset exposes six views:

- **Records** — text, semantic, or hybrid query; advanced exact-filter JSON;
  score and fallback telemetry; signed paging.
- **Documents** — paged committed source-document/snapshot summaries.
- **Dated conflicts** — conflicted records with preserved variants and source
  or dataset dates.
- **Coverage** — stable-document-ID coverage and digest diagnostics.
- **Embeddings** — current profile, eligible/ready/pending totals, job states,
  and recent metadata without vectors.
- **Transactions & deletion** — publication history, group state, purge jobs,
  and visible cleanup progress.

Definition/schema/policy JSON remains available behind a details disclosure.
Dataset-level and whole-group clear actions remain separate, confirmed, and
generation-fenced. The page explains that logical removal is immediate while
physical purge is resumable in the background.

## Security And Trust Boundaries

- All new tables and RPCs are service-role-only.
- The browser/public API cannot select the vector column through the Phase 7
  service contract.
- Query vectors are generated server-side and are not placed in cursors,
  traces, or model responses.
- Only schema-declared embedding paths enter semantic text.
- Exact filter and projection paths must be allowlisted by the definition.
- Dataset ownership is revalidated at the database boundary, including staged
  transaction ownership.
- Record revision and policy digests prevent stale embeddings from being read.
- Embedding-profile equality prevents one model's vector from being compared
  with another profile's query vector.
- Stored summaries and source-derived fields retain explicit untrusted-data
  notices in the model tool.
- Swarm workers cannot choose dataset ownership or bypass their existing
  assignment/lease fences to write records.

## Operational And Backup Contract

Phase 7 updates all installation-level contracts:

- expected migration head;
- required Supabase tables and functions;
- environment default for the expected head;
- portable backup and restore table order;
- ephemeral-table/redaction declarations for embedding jobs; and
- migration checksums.

The staging Supabase workflow applies the migration and runs the Phase 1–5 and
Phase 7 SQL smoke suites. A staging release is accepted only after the normal
repository test/type/build/documentation checks, database workflow, and all
Railway staging services succeed.

## Tests And Release Gate

The Phase 7 SQL integration smoke proves:

- every new RPC is executable only by `service_role`;
- semantic projection contains only configured paths;
- staged records queue and complete embedding jobs;
- readiness reaches eligible = ready with no pending records;
- exact typed filters reduce the candidate set before semantic Top K;
- hybrid RRF merges semantic and lexical candidates;
- Task commit promotes staged embeddings atomically with records;
- a record revision supersedes the old embedding and queues a new namespace;
  and
- a semantic-policy/definition revision makes all old-policy embeddings
  ineligible and queues a bounded rebuild.

Shared contract tests cover semantic definition validation, semantic/hybrid
read modes, model-tool schemas, template suggestions with bounded semantic
paths, and vector-free signed ranked cursors. Worker prompt tests ensure only
the retrieval specialist may recommend semantic persistence and only for a
deliberate bounded projection.

The release gate is:

1. formatting and TypeScript checks;
2. repository unit/integration tests;
3. production application builds;
4. documentation and platform-contract checks;
5. local Phase 7 migration and SQL smoke;
6. commit and push to `dev`;
7. successful GitHub **Tests** and **Deploy Supabase Staging** workflows;
8. successful Railway deployment of every staging-project service; and
9. live web/worker/settings/maintenance health verification.

## Deferred Scale Work

Phase 7 deliberately does not add cross-Task dataset sharing, arbitrary
embedding of the entire payload, unbounded nearest-neighbor export, or
automatic same-document-ID refresh. Those would violate the established
ownership and freshness contract.

The measured Phase 8 work remains aggregate/report queries, expression indexes
for frequently used real definitions, quota and bloat dashboards, purge and
autovacuum tuning, dataset export/conflict-review workflows, full
Task/silo/project deletion integration at large scale, and partitioning only
if production table sizes justify it.
