# Staged Extraction Phase 6 Implementation

## Outcome

Phase 6 activates the staged Template route for saved Tasks. A selected
Template is no longer handed to one long free-form extraction conversation.
The server compiles every pinned Template step in the Task into one immutable
run plan, refreshes only uncovered Task Dataset sources, assembles field and
collection payloads from compiled records, validates the result, and renders
the Word document once.

The performance boundary is now the Task Dataset record set. On a compatible
second run over an unchanged document scope, inventory finds no uncovered
documents and the source-extraction stage makes no document RAG reads. New
documents create only new document/requirement work. Re-ingesting an existing
stable document ID does not reopen it; an operator-requested clear/rebuild is
required, matching the Task Dataset stable-ID contract.

## Persistent Task Plan

`task-execution-plan.ts` compiles all Template run items before model work:

1. load each pinned immutable Template version and manifest revision;
2. verify the manifest belongs to the pinned version and exactly represents
   the version's persistent-data suggestions;
3. verify every Template search-plan query and served segment is represented by
   at least one persistent dataset source query;
4. consolidate requirements only when their exact requirement and semantic
   digests match;
5. reject two requirements that reuse a dataset key with different extraction
   meaning;
6. expand each visible Template step into `manifest`, `inventory`, `relevance`,
   `extract`, `assemble`, `gap_check`, and `render` nodes as applicable; and
7. persist the plan digest, manifest-set digest, dependency keys, node input
   digests, attempts, progress, results, and timings.

Build compatibility uses the stable saved Task-step ID, not the new run-item ID
created for each execution. The per-run graph still uses run-item IDs for
observability, but a paused compatible build can therefore be found and reused
by the next Task run.

A no-output Template step terminates at its extraction dependencies. A later
Template step in the same Task, silo, and optional project reads the same
current-run dataset overlay. Exact-compatible requirements shared by several
steps have one producer chain, not duplicate extraction chains.

The migration creates:

- `extraction_task_run_plans`;
- `extraction_task_run_plan_nodes`;
- `start_extraction_task_plan_node(...)` for atomic attempt accounting; and
- checkpoint payload columns needed to restore searchable records without
  asking a model to recreate their summaries.

## Stage 1: Inventory And Conservative Relevance

For each non-`run_supplied` requirement, the orchestrator applies the immutable
Template suggestion through the Task Dataset tool, inventories every stable
document in the Task's silo/project scope, restores compatible durable
checkpoints, and reads coverage.

The implemented relevance policy is deliberately conservative. It never marks
an ambiguous document irrelevant merely to save work. Existing active coverage
and restored complete checkpoints are excluded; all other eligible documents
remain candidates for extraction. A later tuning phase may add a zero-model
metadata/vector shortlist for clearly irrelevant documents without weakening
this correctness boundary.

`run_supplied` requirements never create inventory or extraction nodes. Their
facts come only from the Task run's bounded input data during assembly.

## Stage 2: Source-Restricted Swarm Extraction

The server dispatches up to twelve workers per round, bounded by the shared
Swarm route configuration and slot ledger. Internal staged dispatches may
contain one task when only one source remains; the public model-facing Swarm
contract continues to require at least two tasks.

Before a worker model starts, the server claims exactly one uncovered source
for the requirement. The worker receives the exact stable document ID, schema,
identity/source policies, extraction instructions, and source queries. RAG is
automatically restricted to that claimed document. The claim token remains
server-side. The worker may write bounded schema-validated batches and must end
by sealing, skipping as explicitly not applicable, or failing that source.

The orchestrator repeats bounded rounds until coverage reports zero pending
sources. A round that makes no progress fails visibly instead of looping
forever.

## Durable Failure Checkpoints

`capture_task_dataset_build_checkpoints(...)` copies only terminal
`sealed`/`not_applicable` source work into the compatible build session. Each
checkpoint is one exact requirement/document pair and stores bounded individual
records, not one growing JSON blob. Payload, evidence, summaries, search text,
document dates, digests, provenance, counts, and approximate size are retained.

Checkpoint capture runs after every Swarm round, including the failure path.
The Task Dataset transaction is still the publication boundary: a failed Task
discards its staged generation and never exposes partial records as active.
The compatible build session is paused rather than marked ready.

On the next compatible run,
`restore_task_dataset_build_checkpoints(...)` validates the Task Dataset Group,
plan/build identity, requirement digest, definition digest, current transaction,
and current stable document inventory. It rehydrates records in bounded batches,
materializes the run-local overlay, and seals the restored sources. Unfinished
sources remain pending and are the only sources sent to models.

After every Task item and output succeeds, the coordinator seals and commits the
Task Dataset transaction first, then atomically marks the build and plan
ready/succeeded. Once active records are durable, completed checkpoint payloads
are released so successful runs do not permanently duplicate the full dataset;
the build retains historical committed checkpoint counts in bounded metadata.

## Stage 3: Deterministic Assembly

For file-producing steps, the server opens the pinned DOCX contract and computes
topological layers from the persisted Template execution plan. Up to twelve
independent segment workers run concurrently per layer. They receive read-only
Task Dataset authority and may use `catalog`, `describe`, `coverage`,
`source_documents`, `list`, `search`, `get`, and `aggregate`.

Assembly workers cannot run RAG, mutate a dataset, claim a source, or write the
document. Each writes one JSON cache payload containing only the segment ID and
`set_field`/`set_collection` operations. The server validates and applies these
payloads through `applyTemplateFieldPayloads`. Dependency layers see already
applied values from their predecessors.

Task input data is appended last to assembly context and has factual precedence
when it conflicts with other system data. It does not change dataset or plan
identity, so a new report date range can reuse the same source extraction.

## Gap Check And Render

After assembly, the server computes exact required and outstanding bindings.
When bindings remain, one bounded three-turn gap pass targets only the affected
segments and may read compiled Task Dataset records plus Task input. It cannot
reopen RAG or mutate the pinned manifest during the current run. Missing
required fields or collections fail with their exact IDs; optional absent facts
remain empty rather than being fabricated.

The server then inspects and finalizes the document once. The render node stores
the generated-file ID, allowing a same-run resume to verify and reuse an
existing completed output. A no-output Template step never creates a DOCX
workspace or generated file.

## Operational Rollback And Observability

Template selection routes to staged execution by default.
`STAGED_TEMPLATE_EXECUTION_LEGACY_FALLBACK=true` is the installation-level
emergency rollback and is intentionally not stored on a Task.

Run-item progress reports the current phase, plan and Template identities,
requirement key, uncovered-source count, extraction round, assembly layer, and
Swarm queue/slot state. The persistent plan and source child nodes preserve
attempt and terminal state for debugging. Phase 7 now adds aggregate proof and
tuning views without changing the Phase 6 correctness boundary.

## Verification

Phase 6 is covered by:

- compiler tests for exact consolidation, incompatible key rejection,
  `run_supplied` exclusion, and incomplete-manifest rejection;
- the complete web test and type-check suites;
- fresh Railway PostgreSQL installation acceptance for the new plan tables and
  atomic node-start function;
- the platform migration checksum, ownership, resource, release, and schema
  play-forward contracts; and
- application/worker production builds before deployment to `dev`.
