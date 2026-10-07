# Task Datasets

This folder defines the proposed Task Dataset subsystem: durable,
Task+silo+project-private JSONB datasets that let a saved Task reuse structured
facts compiled from documents and process only previously uncovered document
IDs.

## Current Direction

- The tool is always available while a verified saved Task is running, except
  for a temporary installation rollout bypass. Standalone Ask and standalone
  Extraction keep their current stateless behavior.
- Every saved Task step can enable `strictTaskDataset`. The default remains the
  normal model-directed behavior. A strict step must successfully perform
  meaningful Task Dataset inventory, reuse/search, definition, or staging work
  before it can complete; catalog/describe-only access does not count. The flag
  is snapshotted into the run item and an unmet requirement fails the step so
  the shared transaction cannot commit partial data.
- Each Task + silo + explicit project-or-no-project selection has a separate
  Task Dataset Group containing its own definitions and records. Every step in
  one Task run shares that group and its staging transaction.
- One Task may own several datasets when the record types have different
  schemas, identities, source policies, or retrieval patterns.
- Dataset descriptions, JSON schemas, identity rules, and provenance are
  durable. The model sees the catalog and descriptions when the Task returns.
- Stable document-ID coverage makes previously committed documents a
  zero-formatting path. Re-ingestion under the same document ID does not reopen
  coverage; clear/recreate is required. New document IDs are processed and
  removed documents are deterministically withdrawn.
- Passing a Task Dataset ID to `rag_search` excludes document IDs already
  committed for that dataset before ranking and Top K are applied. The result
  reports a document-only list of what was excluded and issues one search
  receipt that can be attached to the dataset save.
- Records are stored as indexed JSONB rows, not as one large JSON file.
- Swarm workers write staged, source-owned contributions through atomic,
  idempotent operations. They never append concurrently to a shared blob.
- The staged-template rebuild separates durable build checkpoints from active
  dataset publication. Fully validated requirement/document checkpoints survive
  a failed Task and accelerate the next compatible run, while a building
  generation becomes active only when all required sources are complete or
  explicitly not applicable. The staged executor now captures and restores
  those checkpoints while retaining the same atomic Task transaction boundary.
- Conflicts preserve source variants, source document dates when available,
  and dataset commit dates.
- Clearing removes the selected definition—or every definition in a group—and
  all of its data so the model designs it again on the next run. Task deletion
  is visibly asynchronous and purges every related group.
- Bounded semantic/vector search over declared record projections is available
  alongside exact, filtered, full-text, hybrid, and paged reads. Exact filters
  are applied before vector Top K, and run-local reads include the current
  Task's staged overlay.
- Template ingestion may compile persistent-data suggestions into a template's
  execution plan, including optional `task-dataset:` author hints, but those
  suggestions create or use a Task Dataset only when the template is executed
  inside a saved Task.
- A saved Task step that explicitly selects a template uses the staged executor.
  The one visible step expands into persistent internal inventory, relevance,
  extraction, assembly, gap-check, and optional render nodes. A no-file template
  step stops after dataset preparation so later template steps can consume its
  shared Task Dataset Group.
- The staged Task compiler inventories every stable document ID, uses a
  conservative relevance gate, extracts every period from each new relevant
  source, and consolidates requirements across templates only when their
  compatibility digests match exactly.
- Runtime gap checks may create immutable successor manifest revisions. They do
  not edit a pinned revision in place. Schema/identity changes build a complete
  replacement while the prior active dataset remains readable.
- Staged Task runs persist proof snapshots with per-requirement covered versus
  uncovered sources, restored and newly processed sources, workers, model
  turns, Swarm slot grants/waits, queue position, gap-check firings, and wall
  clock. The Task-run APIs and both operator Task-run views aggregate and expose
  the measurements without double-counting shared requirements.
- A top-level Task Datasets tab lets operators choose silo, Task,
  project/no-project group, and dataset to inspect records, coverage,
  conflicts, bounded summaries, snapshot exports, transactions, search
  behavior, quotas, measured indexes, table health, and purge state.

## Reading Order

1. [Task Dataset Tool proposal](task_dataset_tool_proposal.md)
2. [Phase 1 implementation](phase_1_implementation.md)
3. [Phase 2 implementation](phase_2_implementation.md)
4. [Phase 3 implementation](phase_3_implementation.md)
5. [Phase 4 implementation](phase_4_implementation.md)
6. [Phase 5 implementation](phase_5_implementation.md)
7. [Phase 6 implementation](phase_6_implementation.md)
8. [Phase 7 implementation](phase_7_implementation.md)
9. [Phase 8 implementation](phase_8_implementation.md)
10. [Phase 9 implementation](phase_9_implementation.md)
11. [Staged Extraction Rebuild](staged_extraction_rebuild.md)
12. [Staged Extraction Phase 6 implementation](staged_phase_6_implementation.md)
13. [Staged Extraction Phase 7 implementation](staged_phase_7_implementation.md)

The proposal is the source of truth for the intended design. It records the
product boundary, persistence model, tool contract, concurrency rules, API
surface, template integration, rollout plan, and acceptance criteria.

## Implementation State

**Phases 1 through 9 implemented on `dev`.** Persistence, stable-document-ID
inventory, generation/publication fencing, atomic Task-run commit/discard,
committed catalog/search/list/get APIs, signed cursors, definition/group clear,
bounded resumable purge, dedicated API scopes, and the operator browser are
present. The staged model create/claim/heartbeat/skip/upsert/seal/fail tool,
dataset-aware receipt database contract, active-plus-run overlay, dated conflict
variants, native/JSON-loop schemas, recoverable failures, and redacted tool
telemetry are also present. Saved Tasks now share one signed, atomic dataset
transaction across every step; dataset-aware RAG excludes committed stable
document IDs before ranking and binds claimed retrieval to one source. Bounded
swarm refresh assigns one server-owned claim per worker, enforces exact
worker/epoch/lease ownership, heartbeats and retries recoverable work, and
reconciles completed receipts under a separate dataset-worker capacity.
Template ingestion now compiles validated, semantic-digest-pinned persistent
data suggestions, including trusted `task-dataset:` Word-comment hints.
Standalone generation keeps them inert; verified saved Task template execution
can server-verify and reuse/create/recreate them in the exact Task Dataset
Group. Declared record projections now receive revision- and policy-fenced
embeddings. Semantic and reciprocal-rank-fused hybrid reads apply exact filters
before Top K, support active-plus-current-run staged records, and report index
catch-up explicitly. The top-level explorer now exposes records, source
documents, dated conflicts, coverage, embedding status, transactions, and
clear/purge/deletion progress without returning raw vectors.
Phase 8 adds schema-authorized aggregate reads, measured hot-path expression
index jobs, race-safe configurable quotas, table bloat/autovacuum visibility,
snapshot-fenced JSON Lines and CSV exports, read-only side-by-side conflict
review, and visible asynchronous Task deletion. Silo/project deletion is fenced
inside the database. Partitioning remains deliberately disabled until measured
row counts or table bytes cross the documented review threshold.
Phase 9 adds coalesced silo/project source-scope revisions, commit-safe
per-definition inventory checkpoints, idempotent receipt-level RAG exclusion
metrics, and a bounded reuse/freshness dashboard. The model catalog can now
recommend inventory only when the advisory source revision is ahead while the
trusted inventory remains authoritative. The operator explorer shows measured
unchanged reuse, incremental refresh, rebuild behavior, and readiness without
exposing raw vectors or source-derived record content.

The staged-extraction rebuild's Stages 1 through 7 are also implemented. Saved
Task runs are durable leased worker jobs rather than detached web promises;
expired workers reclaim the same run and publication transaction with rotated
secret leases. The compiler persists one exact-digest execution graph for all
pinned Template steps. The orchestrator inventories stable documents, restores
compatible complete checkpoints, dispatches only uncovered
document/requirement pairs under shared Swarm capacity, assembles read-only
dataset results into validated field payloads, performs a bounded gap check,
and renders once. Durable checkpoints remain separate from active dataset
generations, so failed partial work can accelerate a retry without becoming
visible as a complete dataset. Versioned run proof now makes requirement-level
reuse, new source work, model turns, Swarm admission, gap checks, and wall clock
visible in the run APIs and operator interfaces.
