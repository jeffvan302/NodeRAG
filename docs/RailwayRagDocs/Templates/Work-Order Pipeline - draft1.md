# Deferred Work-Order Pipeline for Template Extraction

Status: implementation plan

Revision: 5

Last reviewed: 2026-09-02

Repository: `D:\Dev\BubbleAPI`

Target: saved Task steps that use an ingested DOCX template

This document replaces the earlier architecture evaluation with an implementation-grade plan. It describes how a template Task step should plan source work once, hand that work to durable server-managed workers, compile reusable Task Dataset records, prepare date-specific report data, and fill the preserved DOCX template.

Related specifications:

- [Template execution plan](template_execution_plan_spec.md)
- [DOCX template authoring language](template_authoring_language.md)
- [Writing a template](writing_a_template.md)
- [Template DOCX ingestion and storage](template_docx_ingestion_and_storage_spec.md)

---

## 1. Executive decision

The new path is a four-phase deferred pipeline:

1. **Plan source work** — the server inventories sources, restores compatible Task Dataset coverage, and runs the required document-matrix retrieval only for the remaining work. It skips the planner when no retrieval-backed work remains; otherwise it obtains one valid structured plan, normally in one provider attempt, with at most one transient transport retry/failover and one syntax-only repair. The planner is coverage-aware but data-blind: it receives a compact server-authored coverage summary and only actionable document/requirement candidates, never the stored Task Dataset record payloads.
2. **Compile source data** — after the planner call has ended, durable workers call the configured Swarm models directly. Each call receives a human-readable data title, the immutable extraction query, the exact structured-data format, and the complete canonical Markdown for one document, plus the remaining extraction policies. Validated results are written by server code into the Task Dataset bound to the exact saved Task, silo, and nullable project.
3. **Prepare report data** — the server creates an immutable, run-specific snapshot. Date filtering, conflict handling, sorting, totals, source-register rows, and output formatting happen here.
4. **Fill and render** — the system fills fields and collections in dependency order, performs only bounded semantic synthesis where necessary, validates required bindings, and renders through the deterministic DOCX engine.

The planner is not a Swarm coordinator. It must not receive or invoke `swarm_task`, a proposed `swarm_enqueue`, `rag_search`, `rag_documents`, Task Dataset mutation tools, cache tools, or DOCX tools. The server runs document discovery first and supplies the planner with the persisted, bounded candidate matrix. The planner returns one schema-constrained plan and its model session ends.

Phase 1 uses the tenant's configured primary Extraction provider/model/reasoning/timeout. Phase 2 uses the separate configured Swarm route pool. Both normalized configuration digests are pinned in the accepted plan so the two roles cannot be confused and a mid-run settings edit cannot silently change execution.

The worker service owns every action after that boundary:

- validating and persisting the plan;
- claiming and retrying work orders;
- selecting configured provider/model routes;
- reserving parallel capacity;
- loading exact document Markdown;
- validating model results;
- writing and sealing Task Dataset records;
- waking the parent Task when the extraction barrier is complete;
- cancellation and late-result fencing.

The configured Swarm routes remain useful as a provider/model/capacity pool. The model-facing Swarm tool is not used in this pipeline.

---

## 2. Why this change is necessary

The current staged executor is durable at the outer Task level, but it still performs extraction as a synchronous in-process Swarm conversation:

- `runStagedTemplateStep()` executes manifest, inventory, extraction, assembly, gap check, and render in one call;
- `extractUncoveredRequirementSources()` creates generic source tasks;
- `executeStagedSwarm()` waits for `createSwarmDispatcher().execute()`;
- the worker model claims an arbitrary uncovered source and uses RAG and Task Dataset tools in a multi-turn loop;
- assembly and gap checking start more synchronous Swarm calls.

This structure has several costs:

- a coordinating execution remains open while every child finishes;
- the model spends turns discovering source state, writing datasets, and checking whether it may finish;
- a timeout or malformed response can fail work at requirement scope rather than one document assignment;
- the same document can be read repeatedly for different requirements;
- the existing retrieval path ranks chunks, but it does not create a durable multi-query document-candidate matrix that can be validated, resumed, and audited;
- extraction, report-period selection, narrative formatting, and document filling are not separated strongly enough;
- a two-hour run can be mostly orchestration latency rather than useful model work.

The target architecture turns a source document into a bounded model-call envelope. With 15 available slots, 15 documents can be processed in one wave instead of through a long coordinator loop.

---

## 3. Goals and measurable outcomes

### 3.1 Functional goals

- A selected template Task step is visibly divided into the four phases in this plan.
- Phase 1 makes zero planner provider attempts when no retrieval-backed work remains, or produces one valid plan normally in one attempt and within an absolute maximum of three attempts (initial, one transient retry/failover, and one syntax-only repair), then releases that model session.
- Every uncovered retrieval-backed requirement passes through mandatory server-owned document discovery before it can be planned.
- Previously completed, still-compatible document/requirement work is reused.
- The planner sees enough aggregate coverage to avoid already-completed work without receiving existing record payloads or deciding whether coverage is reusable.
- Phase 2 workers receive the exact source document chosen by the plan, its complete Markdown, the authoritative extraction query, the structured output format, and the human-readable data title.
- Phase 2 results can be persisted only to the server-pinned Task Dataset scope for the current saved Task, silo, and nullable project.
- Source extraction is independent of the requested report period.
- Phase 3 is the only phase that applies a report date or date range.
- Phase 4 never reopens broad source discovery.
- Every material factual output can be traced to a Task Dataset record and source evidence.
- A single failed document does not discard successful work from other documents.
- A process restart, provider timeout, or transient database interruption resumes from durable state.

### 3.2 Performance targets

Use two fixed benchmarks so the target is testable:

- **Typical one-wave benchmark:** no more than 15 full-Markdown model-call envelopes, no more than two high-volume extraction contracts per envelope, every document within the selected route's safe context limit, and 15 available `template_work_order` slots.
- **Scale two-wave benchmark:** 30 equivalent envelopes under the same limits and capacity.

Initial service-level objectives:

| Stage                                            | Target                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Document discovery, 12-query reference benchmark | p95 at or below 5 seconds, or a measured corpus-specific bound approved before rollout |
| Planner call                                     | p95 at or below 90 seconds                                                             |
| Plan validation and persistence                  | p95 at or below 2 seconds                                                              |
| Eligible order to provider-call start            | p95 at or below 10 seconds when capacity is available                                  |
| One document envelope                            | p50 at or below 2 minutes; p95 at or below 6 minutes                                   |
| Phase 2, typical one-wave benchmark              | p95 at or below 6.5 minutes                                                            |
| Phase 3                                          | p95 at or below 60 seconds                                                             |
| Phase 4 fill and render                          | p95 at or below 3 minutes                                                              |
| End to end, typical one-wave benchmark           | p95 at or below 12 minutes; hard target below 15 minutes                               |
| End to end, scale two-wave benchmark             | p95 at or below 18 minutes unless per-envelope p95 falls below 4.5 minutes             |

These are benchmark goals, not a promise for every corpus. The UI must show a measured estimate for larger documents or more than one wave.

### 3.3 Accuracy targets

| Measure                                                              | Initial target |
| -------------------------------------------------------------------- | -------------- |
| `rag_documents` candidate recall on the source-selection gold corpus | at least 98%   |
| Planner assignment recall from returned candidates                   | at least 98%   |
| Planner assignment precision from returned candidates                | at least 95%   |
| Golden-record extraction F1                                          | at least 95%   |
| Numeric and date exactness                                           | at least 99.5% |
| Material values with provenance                                      | 100%           |
| Unsupported filled values                                            | 0              |
| First response schema-valid                                          | at least 98%   |
| Schema-valid after bounded repair                                    | at least 99.8% |
| Duplicate records after retry/restart                                | 0              |

Candidate recall is measured per uncovered `(queryKey, requirementKey)` mapping as gold-relevant in-scope documents returned with `matched` state divided by all gold-relevant in-scope documents, after the declared protected-depth/union limits. The headline is the macro average over mappings with at least one gold-relevant document; also report micro recall and the worst required mapping. Gold queries with no relevant document are excluded from recall's denominator and scored separately for correct `no_match` behavior and false-positive rate. Exhaustive requirements are measured for complete direct assignment, not retrieval recall.

Planner assignment recall/precision is measured only against candidates it was actually allowed to see. This keeps retrieval misses, planner-selection misses, and downstream extraction false positives independently diagnosable.

---

## 4. Non-goals

This work does not:

- remove the interactive `swarm_task` tool from Ask or general Extraction;
- replace `rag_search` for evidence retrieval in Ask or general Extraction;
- expose `rag_documents` to the Phase 1 planning model;
- treat an unobserved document/query cell as verified absence;
- make the planning model a queue manager;
- allow the planner to invent schemas, dataset identifiers, document identifiers, routes, or source claims;
- use report dates to decide what facts Phase 2 may retain;
- let source documents provide executable instructions;
- replace the deterministic DOCX renderer;
- promise that an arbitrarily large document can fit one model context;
- mix legacy and deferred extraction inside one Task run.

---

## 5. Current implementation baseline

The new path should extend, not discard, the durable components already present.

| Capability                                        | Current implementation                                          | Assessment                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Immutable Task execution plan and digest          | `task-execution-plan.ts`, `extraction_task_run_plans`           | Reuse                                                                                                                           |
| Phase-level DAG nodes and checkpoints             | `extraction_task_run_plan_nodes`                                | Reuse for high-level gates                                                                                                      |
| Requirement/document checkpoint restore           | Task Dataset build checkpoints                                  | Reuse                                                                                                                           |
| Hybrid chunk retrieval                            | `rag-retrieval.ts` and the existing `rag_search` execution path | Reuse ranking primitives; add document collapse, a bounded batch contract, durable results, and server-owned Phase 1 invocation |
| Durable top-level saved Task job                  | `extraction_task_run_jobs`                                      | Extend with deferred wait/resume                                                                                                |
| Source claim fencing and idempotent contributions | Task Dataset source snapshots and RPCs                          | Reuse through server-owned commits                                                                                              |
| Swarm route and slot configuration                | `swarm-runtime.ts` and slot ledger                              | Reuse as a capacity pool                                                                                                        |
| Per-worker model-status slots and webhooks        | staged model-status persistence                                 | Extend                                                                                                                          |
| Staged Task progress and ETA display              | `staged-task-proof.ts`, `TaskRunProof.tsx`                      | Replace estimates with work-order truth                                                                                         |
| Deterministic template editing and rendering      | DOCX workspace/engine                                           | Reuse                                                                                                                           |

Important current limitations:

- `MAX_SWARM_TASKS` and the staged extraction/assembly batches are currently 12, not 15.
- current Swarm model routes carry provider, model, parallel calls, and reasoning effort, but not a per-route work-order timeout; staged dispatch therefore inherits provider defaults and can repeat the earlier 180-second OAuth timeout failure.
- Source nodes created by `syncSourceNodes()` are status mirrors; they are not independently claimable execution units.
- `lease_owner` and `lease_expires_at` on plan nodes do not provide token/epoch fencing or a claim/settle workflow.
- `markStagedTaskPlanNode()` recalculates counts by reading all node rows. That is unsafe once many nodes settle concurrently.
- the saved Task job has no nonterminal `waiting` or `deferred` outcome;
- the current job claim count doubles as retry accounting and is capped at three, so normal phase resumptions cannot consume that counter;
- the public document-Markdown tool caps a slice at 40,000 characters. The internal work-order loader needs a different full-document contract and must never silently truncate.
- the current `document_markdown` storage keeps one mutable Markdown row per document; the new path needs a content-addressed/versioned Markdown artifact before an active run can promise immutable full-Markdown input;
- Task Dataset definitions already provide the dataset-level title through `name`, while records currently expose `logical_key`, `payload`, `summary`, and `search_text` but no first-class record title; an optional schema-owned derived record-title field/policy requires an additive change;
- the current requirement digest includes source-query wording. Version 2 must move retrieval wording into `sourceSelectionDigest` while the immutable extraction query, schema, and semantic title policy belong to `extractionContractDigest`;
- `retrieveRankedRagChunks()` globally slices passage results to `topK`; keyword candidate loading is capped before query-aware document ranking, and the vector RPC over-fetch is capped at 50 chunks. A verbose document can therefore starve distinct documents from a candidate window.
- the current vector-match RPC has no explicit frozen candidate-document allowlist; Phase 1 needs an additive query-aware RPC that ranks the best bounded chunks per distinct document inside the exact frozen snapshot scope.
- the current shared `rag_search` schema intentionally accepts only one to three unkeyed queries. It should remain unchanged; document discovery needs a separate keyed schema up to the manifest's 60-query ceiling.
- `task_dataset_rag_eligible_documents` currently reasons about prior coverage by stable document identity and is not the authoritative Phase 1 scope until fingerprint-aware reuse is repaired. Discovery must start from the current run's frozen source snapshots.
- current source mirrors do not preserve per-query document rank, observation state, coverage exclusion, anchor, or retrieval-version evidence;
- current reuse is not yet strict enough for changed content: inventory can treat a previously covered stable document ID as covered while only reporting a changed observed digest, checkpoint restore does not require the checkpoint's source/Markdown hashes to match the current snapshot, and mirrored source-node input digests omit the content fingerprint. These checks must be repaired before the new path is allowed to skip prior work.

---

## 6. Target ownership and sequence

```text
Parent Task worker
  -> pin Task, template version, manifest, source scope, and input
  -> restore compatible Task Dataset coverage
  -> if no uncovered source work remains, persist a zero-order batch and skip planning
  -> otherwise run mandatory server-owned rag_documents discovery against the frozen scope
  -> persist and digest the bounded document x query candidate matrix
  -> call the planning model once, with the persisted matrix, strict structured output, and no tools
  <- receive DeferredExtractionPlan
  -> validate every candidate/query/requirement against the allowlist
  -> atomically persist the batch, document orders, and requirement assignments
  -> keep the Task item running with phaseKey = compile_source_data; defer the job with waitKind = template_work_orders
  -> release the parent job lease without failure

Work-order worker lane
  -> reserve template_work_order capacity
  -> claim eligible document orders with FOR UPDATE SKIP LOCKED
  -> load and fingerprint-check canonical Markdown
  -> call configured model routes directly
  -> validate structured records and evidence
  -> persist validated output and commit Task Dataset assignments idempotently
  -> settle, retry, split, fail, or cancel each order
  -> final barrier settlement requeues and wakes the parent exactly once

Parent Task worker resumes
  -> build an immutable ReportDataSnapshot
  -> apply report period, filters, conflict policy, sorting, and aggregates
  -> create field/collection operations in dependency order
  -> run one bounded completeness gate
  -> render the preserved DOCX package
```

There is no live planner session during Phase 2. A work-order failure is durable worker state, not a tool result sent back to the planner.

---

## 7. Phase 1 — Determine files and extraction requests

### 7.1 Inputs pinned before the call

The server pins:

- tenant, saved Task, Task run, and Task item;
- silo and project scope;
- Template Group, template, immutable template version, and source DOCX version;
- `sourceSelectionDigest`, `extractionContractDigest`, `reportShapingDigest`, and `presentationDigest`;
- data-manifest revision and digest;
- execution-plan digest;
- Task Dataset Group and target transaction/generation;
- the exact Task Dataset scope tuple: tenant, saved Task, silo, nullable project, Task Dataset Group, and stable `datasetKey`;
- active dataset-definition revision/digest, pinned base-publication watermark, and current transaction overlay/imported-artifact state;
- source-scope integer revision and frozen-snapshot digest;
- retrieval/index revision, document-discovery contract version, and retrieval configuration digest;
- stable query-set/source-selection digest and configured per-query/union/response limits;
- the exact document × requirement coverage exclusions and their digest;
- the complete server-owned coverage-ledger digest and a bounded planner-summary digest;
- raw Task request, run input, timezone, and supplied report-period text for audit/Phase 3 only;
- a server-compiled date-independent source intent for discovery/planning;
- planner provider/model/reasoning configuration and planner-contract version.

The report period, final report/output-file format, and presentation wording are removed from the source intent and are not supplied to discovery or the planner. This does not remove the requirement's Phase 2 `json_records` data contract. The raw request remains pinned for audit and later phases. Thus a different report month against unchanged template requirements and sources produces the same source-selection identity.

### 7.2 Restore prior coverage first

“Processed in the past” is not based on a filename alone. A requirement assignment is reusable only when all of the following remain compatible:

- stable document identity;
- observed source/content fingerprint;
- source-file and canonical-Markdown hashes;
- requirement semantic digest;
- dataset semantic-definition/record-schema digest, excluding display-only title/description metadata;
- extraction-contract version;
- `extractionContractDigest`; umbrella manifest, source-selection, report-shaping, and presentation identities do not independently invalidate Phase 2 coverage.

A prior `not_applicable` result is reusable only for the same source fingerprint, requirement semantics, extraction policy, and schema. It must not become a permanent global exclusion for a document.

The existence of Task Dataset records is not itself proof of coverage. Reuse requires an accepted and sealed logical-assignment receipt whose scope and identity are compatible with the current run:

```text
tenant + saved Task + silo + nullable project + Task Dataset Group + datasetKey
+ stable source-document identity
+ source/content/canonical-Markdown hashes + canonicalizer version
+ requirementKey + extractionContractDigest
+ record-schema/identity/temporal/evidence-policy digests
+ accepted terminal settlement
```

`extractionContractDigest` includes the immutable extraction query and any semantic record-title rule. Retrieval wording, report dates, provider/model choice, presentation, and a display-only dataset-title rename do not invalidate this coverage identity.

The server—not the planning model—classifies every candidate document × requirement mapping as:

- `covered`: a compatible complete, committed, and sealed result exists;
- `uncovered`: no compatible result exists;
- `stale`: a result exists, but its source or extraction contract changed;
- `in_progress`: another fenced run currently owns the same logical coverage work;
- `failed`: no reusable successful terminal result exists.

Only `covered` is reusable coverage. `uncovered`, `stale`, and `failed` mappings may be planned. An `in_progress` mapping becomes a durable wait/import dependency rather than a duplicate provider call; after its owner settles, the waiting run imports the validated artifact or reclassifies the mapping for bounded recovery. Legacy records without the required fingerprint and settlement receipt remain uncovered.

The provider or model name is retained as provenance but does not invalidate a valid record automatically. An operator can still choose rebuild mode to force re-extraction.

Changed content, changed requirement semantics, or a changed schema produces new work. A different report month against unchanged source data should produce no new Phase 2 work.

Phase 1 may also import a successful validated logical-assignment artifact from a prior failed/unpublished run. Before treating it as coverage, revalidate the exact document/content/Markdown fingerprint, `extractionContractDigest`, record schema, evidence policy, result digest, and terminal-success/fencing state. Stage the records into the new transaction and exact source snapshot with an idempotent import receipt derived from prior artifact digest × target transaction. Cancelled, late, partial, unsealed, or failed artifacts are never importable. A valid import creates no provider order and lets successful siblings survive a later required-gap failure without publishing the failed run itself.

This requires code changes, not only a new work-order digest. Task Dataset inventory must stage changed fingerprints as uncovered, checkpoint restore must compare the current source/content/Markdown identity before restoring, and any source-node/work-order input digest must include that identity. The existing `changedObservedDigests` diagnostic alone is not a coverage guarantee.

Do not stage every uncovered candidate as a pending Task Dataset source snapshot before source selection. Freeze candidates in the pipeline's own source-inventory rows, then create Task Dataset source claims only for planner-selected or direct all-in-scope logical assignments. Otherwise unselected documents would prevent sealing, while marking them `not_applicable` would incorrectly turn ranking absence into reusable coverage.

#### 7.2.1 All-in-scope and no-source requirements

The server handles these without model source selection:

- `selectionPolicy = all_in_scope`: create one direct logical assignment for every uncovered document × requirement in the frozen source scope, then bundle compatible assignments by document;
- `selectionPolicy = none`: satisfy the requirement from deterministic/run-derived inputs and create no source work order;
- `selectionPolicy = relevance_ranked`: continue into `rankDocumentsForQuerySet()` and the planner.

Every persistent requirement also declares an ingestion-authored refresh policy. The accuracy-first default, `new_or_changed_sources`, evaluates all credible new or changed sources even when a minimum record count is already satisfied. `minimum_sufficient` may stop after its declared satisfaction contract is met. `all_in_scope` behavior belongs to `selectionPolicy`, not `refreshPolicy`. The planner may not invent or weaken either policy.

An all-in-scope-only run may therefore contain nonzero Phase 2 work while making zero discovery and planner calls. A mixed run persists direct all-in-scope assignments beside the planner-selected retrieval assignments in one atomic Phase 1 batch. The planner never partitions or filters all-in-scope sources.

#### 7.2.2 Coverage-aware, data-blind planning boundary

Phase 1 must know what has already been compiled, but the planning model must not read the Task Dataset record bodies. Before discovery, the server restores compatible coverage, calculates requirement-level rollups, removes non-actionable mappings, and creates the base compact coverage summary. After discovery, it appends the actionable candidate count and sends that bounded summary with the candidate matrix. This prevents duplicate work deterministically without spending planner context on old facts or allowing a model to reinterpret coverage.

A bounded planner summary has this shape:

```json
{
  "requirementKey": "grant_portfolio",
  "datasetKey": "grant_records",
  "datasetTitle": "Grant and Funding Updates",
  "coverageState": "partially_covered",
  "compatibleRecordCount": 83,
  "coveredDocumentCount": 4,
  "inProgressDocumentCount": 0,
  "uncoveredSourceCount": 5,
  "actionableCandidateCount": 2,
  "minimumCardinalitySatisfied": true,
  "refreshPolicy": "new_or_changed_sources"
}
```

The summary communicates workload state, not stored facts. The model receives no existing record payload, Task Dataset UUID, Task/silo/project UUID, mutation tool, or authority to declare a mapping covered. Fully covered requirements are omitted from the actionable planner list. A document returned because it remains actionable for requirement B may carry a non-selectable `covered` cell for requirement A, but the full coverage ledger stays server-side.

Existing records from document A never prove that document B contains nothing new. Cross-document records with the same logical identity are merged or retained as an evidenced conflict after extraction. Meeting a minimum cardinality also does not suppress new credible sources unless the manifest explicitly uses `minimum_sufficient`.

### 7.3 Required document-matrix retrieval

Phase 1 requires a reusable multi-query document-ranking service. The implementation name should be `rankDocumentsForQuerySet()`; its separate model-facing tool name is `rag_documents`.

This is not an alternative spelling of the existing `rag_search`:

| Capability        | `rag_search`                              | `rag_documents`                                                                |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| Primary question  | Which passages answer this query?         | Which documents are candidates for each query?                                 |
| Result unit       | Ranked chunks/text/original files         | Document × query matrix                                                        |
| Typical consumer  | Answering/extraction model                | Phase 1 server planner input                                                   |
| Query count       | Existing one-to-three evidence searches   | One-to-sixty stable keyed planning queries, evaluated with bounded concurrency |
| Coverage behavior | Optional single Task Dataset/source fence | Per-query requirement coverage exclusion                                       |
| Output            | Evidence content                          | Scores, ranks, observed state, and anchors                                     |

The Phase 1 server calls `rankDocumentsForQuerySet()` once as one logical, digested discovery operation. The service may execute its independent keyed searches concurrently under the configured bound. The planning model receives the completed persisted matrix and never sees or invokes `rag_documents`.

Expose the same service as a read-only, parallel-safe `rag_documents` tool to Ask and general Extraction when their configured tool policy allows RAG. Keep the keyed document-discovery schema separate from `rag_search`, and never expose it to this pipeline's Phase 1 planner or Phase 2 workers. The Phase 1 server still calls the shared function directly rather than asking a model or making an HTTP round trip.

#### 7.3.1 Inputs

The internal server contract is shown below. Tenant, silo, project, Task run, and live Task Dataset identifiers come from trusted server context and are deliberately absent from the caller payload.

```json
{
  "version": 1,
  "sourceScopeRevision": 42,
  "sourceScopeDigest": "sha256",
  "indexRevision": "sha256",
  "queries": [
    {
      "queryKey": "grant_updates",
      "query": "grant awards, expenditures, compliance status, and project updates",
      "assignments": [
        {
          "requirementKey": "grant_portfolio",
          "requirementDigest": "sha256",
          "datasetKey": "grant_records",
          "selectionPolicy": "relevance_ranked"
        }
      ]
    },
    {
      "queryKey": "capital_projects",
      "query": "capital project risks, milestones, schedule, and budget status",
      "assignments": [
        {
          "requirementKey": "capital_risk",
          "requirementDigest": "sha256",
          "datasetKey": "capital_project_records",
          "selectionPolicy": "relevance_ranked"
        }
      ]
    }
  ],
  "coveredAssignments": [
    {
      "candidateKey": "doc_009",
      "queryKey": "grant_updates",
      "requirementKey": "grant_portfolio",
      "contentFingerprint": "sha256",
      "coverageDigest": "sha256"
    }
  ],
  "protectedDepthPerAssignment": 3,
  "perQueryDocumentLimit": 50,
  "unionDocumentLimit": 60,
  "searchMode": "hybrid",
  "embeddingVersion": "configured-version",
  "includeAnchors": true,
  "maxAnchorsPerMatch": 1,
  "maxResponseBytes": 524288
}
```

Requirements:

- accept a manifest-v2 global registry of 1–60 stable keyed queries, each mapped to one or more requirements through `assignments[]`;
- reject duplicate `queryKey` values;
- require duplicate normalized query text to share one stable `queryKey`, execute that shared query once, and preserve every requirement mapping that references it;
- validate every requirement/query mapping against the pinned manifest;
- resolve `datasetKey` to an authorized Task Dataset server-side;
- restrict ranking to the frozen source scope and exclude compatible coverage per document × requirement before ranking;
- collapse chunk hits to each document's best match before applying document limits, while over-fetching chunks so one verbose document cannot consume the shortlist;
- run the independent query searches concurrently under a bounded retrieval limit;
- enforce query-length, query-count, concurrency, document-query-signal-cell, query/requirement-assignment-state-cell, anchor, and serialized-response limits;
- retain the exact retrieval configuration revision in the result digest;
- label keyword/vector fallback explicitly;
- return a query-specific error on partial backend failure and never reinterpret that failure as no match;
- never accept silo, project, source-batch, or raw Task Dataset identifiers from a model-facing call.

`sourceScopeRevision` is the frozen silo/project source-corpus revision, not a Task Dataset generation. `sourceScopeDigest` cryptographically covers the ordered frozen snapshot IDs and expected source/Markdown/content fingerprints. `indexRevision` covers the retrieval schema/algorithm, keyword-index watermark, vector-index watermark, embedding model/version, and committed indexing generation. The ranking RPC must join or verify each candidate's expected indexed-artifact/content fingerprint (or use an immutable versioned index snapshot); if live chunks no longer match the frozen snapshot, it fails with stale input rather than scoring new content under an old plan.

If any required query still fails after its bounded retry, the logical discovery attempt fails. Successful subquery cells may remain in the internal cache, but the server must not persist or present an incomplete matrix as a succeeded result; the next attempt reruns only the missing/invalid subqueries under the same request digest.

Each query summary has terminal `success | no_match | failed` status and a nullable bounded structured error. Planning is eligible only when every required query is `success` or `no_match`; a `failed` query is diagnostic state on a failed discovery attempt, never an input to planning.

`unmatchedMappings` is authoritative because coverage and eligibility are requirement-specific. Query-level `no_match` means every uncovered requirement mapping for that query is no-match; otherwise the query status is `success` and each mapping reports its own `noMatch` value.

For a general model-facing `rag_documents` call, query entries may omit requirement and dataset keys. Scope still comes from the authenticated execution context. `sourceBatchId` is not part of Phase 1 discovery.

#### 7.3.2 Response

```json
{
  "version": 1,
  "requestDigest": "sha256",
  "sourceScopeRevision": 42,
  "sourceScopeDigest": "sha256",
  "indexRevision": "sha256",
  "documents": [
    {
      "candidateKey": "doc_014",
      "documentId": "uuid",
      "fileName": "Grant Register FY2026.pdf",
      "title": "Grant Register FY2026",
      "contentFingerprint": "sha256",
      "markdownCharacters": 84210,
      "pageCount": 32,
      "matches": [
        {
          "queryKey": "grant_updates",
          "score": 0.88,
          "bestAnchor": {
            "chunkId": "uuid",
            "pageNumber": 7,
            "markdownStart": 18220,
            "markdownEnd": 18910
          },
          "supportingChunkCount": 4,
          "distinctPageCount": 2,
          "assignmentStates": [
            {
              "requirementKey": "grant_portfolio",
              "state": "matched",
              "eligibleRank": 1,
              "eligiblePercentile": 0.98
            }
          ]
        },
        {
          "queryKey": "capital_projects",
          "score": null,
          "bestAnchor": null,
          "supportingChunkCount": 0,
          "distinctPageCount": 0,
          "assignmentStates": [
            {
              "requirementKey": "capital_risk",
              "state": "unobserved",
              "eligibleRank": null,
              "eligiblePercentile": null
            }
          ]
        }
      ]
    }
  ],
  "querySummary": [
    {
      "queryKey": "grant_updates",
      "status": "success",
      "error": null,
      "retrievalMode": "hybrid",
      "fallbackMode": null,
      "candidateDocumentsSearched": 140,
      "candidateChunksScored": 760,
      "observedDocuments": 28,
      "assignments": [
        {
          "requirementKey": "grant_portfolio",
          "eligibleObservedDocuments": 16,
          "returnedDocuments": 16,
          "excludedCompatibleCoverage": 12,
          "noMatch": false,
          "truncated": false
        }
      ]
    },
    {
      "queryKey": "capital_projects",
      "status": "no_match",
      "error": null,
      "retrievalMode": "keyword",
      "fallbackMode": "vector_unavailable",
      "candidateDocumentsSearched": 140,
      "candidateChunksScored": 510,
      "observedDocuments": 0,
      "assignments": [
        {
          "requirementKey": "capital_risk",
          "eligibleObservedDocuments": 0,
          "returnedDocuments": 0,
          "excludedCompatibleCoverage": 0,
          "noMatch": true,
          "truncated": false
        }
      ]
    }
  ],
  "unmatchedMappings": [
    {
      "queryKey": "capital_projects",
      "requirementKey": "capital_risk"
    }
  ],
  "excludedCompatibleAssignments": 12,
  "backendSearchCount": 2,
  "cacheHitCount": 1,
  "signalCellCount": 36,
  "assignmentStateCellCount": 36,
  "responseBytes": 28411,
  "truncated": false,
  "resultDigest": "sha256"
}
```

The Phase 1 planner receives opaque `candidateKey` values. The server retains the document IDs and fingerprints for validation and work-order creation.

The service persists the validated request, dense bounded result matrix, contract version, configuration digests, and request/result digests before invoking the planner. A zero-document result is a successful discovery result; a retrieval exception after bounded retries leaves the discovery node retryable or failed. It must never fall back to title-only or unranked planning.

Compute digests from canonical JSON with stable key ordering. `requestDigest` includes trusted scope/fingerprint identities that are not exposed to the model. `resultDigest` excludes its own field and volatile timing/cache counters, but includes every candidate, cell, anchor, coverage state, limit/truncation flag, retrieval mode, and index/configuration revision that can affect planning.

#### 7.3.3 General model-facing adapter

The Ask/general Extraction `rag_documents` adapter uses the same ranking core but a simpler scope-bound contract: one to twelve keyed/unkeyed query strings plus document limit, search mode, and anchor options. It accepts no requirement, dataset, source-batch, tenant, silo, or project identifiers from the model. The internal Phase 1 service supports the manifest's larger 60-query registry because the server, not a model, constructs that request.

Its result returns each document's query-level `score`, distinct-document `rank`, percentile, observation state, and bounded anchors for every requested search term. This is equivalent to one synthetic uncovered mapping per query; it does not expose Phase 1 coverage states. The adapter description must say that score is not calibrated confidence, `unobserved` is not verified absence, and `rag_search` remains the tool for retrieving answer passages.

#### 7.3.4 Score and observation semantics

The word “confidence” must not be used for the retrieval value. The current hybrid value is a ranking score, not a calibrated probability and not a proof that a document does or does not contain an answer.

- `score` and anchors are query/document signals computed once over the frozen corpus;
- `eligibleRank` is the document's position for one `(queryKey, requirementKey)` after that requirement's compatible-coverage exclusions;
- `eligiblePercentile` is computed over that mapping's pre-limit, uncovered, distinct-document result set before candidate-union trimming;
- each `assignmentStates[]` entry is keyed by `(queryKey, requirementKey)` and owns eligible rank/percentile because one stable query may serve several requirements with different coverage exclusions;
- `state: matched` means the document entered that query's measured shortlist for an uncovered assignment;
- `state: unobserved` means it did not enter the bounded shortlist for that uncovered assignment. Its score is unknown and therefore `null`, not zero; this is not verified absence;
- `state: covered` means that exact document/query/requirement/fingerprint assignment was excluded because compatible output already exists. The assignment state is covered even if the document has a query score because another requirement using the same query remains uncovered;
- changed content or an incompatible contract is uncovered again and can return `matched` or `unobserved`.

Scores from different queries are not assumed comparable. A rare, precise query and a broad query can produce different score distributions. Eligible rank and percentile are the primary cross-query planning signals until a runtime calibration exists.

If a validated calibration is introduced later, add a separately versioned nullable `calibratedProbability` plus calibration ID/sample metadata. Never rename the current score to confidence or synthesize a confidence percentage from rank alone.

Corpus-specific calibration belongs to runtime and should be cached by:

```text
template/source-selection digest
+ tenant/silo/project scope
+ query digest
+ retrieval configuration revision
+ source-scope/index revision
```

Portable template ingestion may evaluate query quality and preserve synonyms, but it must not store one silo's score distribution as a universal threshold.

#### 7.3.5 Candidate-set construction

Build the planner candidate set as the union of each uncovered `(queryKey, requirementKey)` mapping's highest-ranked eligible documents after that requirement's coverage exclusions. Do not aggregate with a hard AND, minimum score across queries, or one global average.

Protect each uncovered mapping's configured depth first using deterministic rank round-robin. If the union still exceeds its cap, order the remaining shared candidates with reciprocal-rank fusion over per-query ranks, followed by deterministic document identity. RRF is only a candidate-union ordering signal; it is not confidence and never replaces the retained per-query rank/score cells.

Preflight requires `uncovered query/requirement mappings × protectedDepthPerAssignment <= unionDocumentLimit` and the resulting dense cell estimate to fit its byte/cell budgets. If not, ingestion/runtime returns a capacity recommendation to consolidate queries or explicitly raise compatible limits; it never reduces protected depth silently. This conservative invariant also handles one query shared by requirements whose coverage exclusions differ.

Rules:

- each query contributes candidates independently;
- a document strong for one query remains visible even if it is weak for every other query;
- every returned document carries a dense entry for every query;
- low/no observation is explicit rather than silently omitted;
- all-in-scope requirements are absent from ranking because the server creates their direct assignments before discovery;
- compatible covered assignments are excluded for that document × requirement before ranking and before a query's document limit;
- a document covered for one requirement may still appear for another uncovered requirement;
- the final list is capped only after per-query representation is protected;
- deterministic per-query tie-breaking uses score descending, then document ID ascending, then chunk ID ascending.

For a small retrieval-backed inventory, every uncovered document may be included. For a large inventory, use the bounded protected/RRF union. Exhaustive assignments are persisted separately and are never added to planner input. The inventory is frozen for the run; documents added afterward wait for the next run unless an operator explicitly restarts planning.

An all-in-scope requirement is never silently clipped by the ordinary union limit. If its direct assignments exceed the configured hard work-order limit, Phase 1 stops with an explicit capacity/review state instead of pretending omitted documents were irrelevant.

Serialized-size handling is deterministic. First remove optional anchor excerpts/secondary anchors while retaining safe IDs/page/ranges. Next reduce the relevance-ranked union in RRF order without dropping any uncovered query/requirement mapping below `protectedDepthPerAssignment`. Rebuild the dense requirement-state cells after each reduction. If the required dense matrix still exceeds the configured byte/cell cap, fail discovery with `candidate_matrix_capacity_exceeded` and a `needs_review` recommendation; never omit a query, requirement state, or cell silently.

#### 7.3.6 Anchors and evidence

The returned anchor is a planning hint, not the Phase 2 evidence record. It helps explain why a document was selected and can help a worker validate document relevance, but Phase 2 still receives and reviews the full canonical Markdown or its explicit shard.

Return at most a small configured number of anchors per document/query so the matrix remains bounded. A planner must not treat an anchor excerpt as the complete source.

#### 7.3.7 Incremental retrieval cache

Cache document/query ranking cells independently so adding one document does not require rescoring every unchanged document.

The raw document/query signal cache stores corpus-independent lexical/vector components and bounded anchor candidates—not final max-normalized hybrid score, rank, or percentile. Its identity includes:

- tenant/silo/project scope;
- normalized individual query/source-selection digest;
- document ID, current content fingerprint, and its own indexed keyword/vector artifact digests;
- search mode, embedding version, retrieval configuration revision, and discovery-contract version.

A separate assembled-result cache includes source-scope revision/digest, complete query-set digest, covered-assignment digest, union/anchor/response limits, retrieval/scoring/configuration/contract versions, and an ordered digest of the exact raw-signal identities/results used. Coverage changes therefore rebuild the bounded matrix without unnecessarily recomputing unchanged document/query signals, while an embedding/scoring/indexed-artifact change cannot reuse a stale assembled matrix.

For each assembled result, recompute the final query/document score distribution plus eligible rank/percentile for every uncovered query/requirement mapping over its pre-limit distinct-document set. A new or changed document creates only new raw signals; a changed query invalidates only that query's signals. A report-period or DOCX-layout change invalidates neither raw signals nor the assembled discovery result.

#### 7.3.8 Zero-work fast path

After fingerprint-aware coverage restoration:

- if no requirement has an uncovered assignment, no changed/new document requires ranking, and no required mapping is `in_progress` elsewhere, skip `rankDocumentsForQuerySet()`, skip the planning model, create a zero-order completed batch, and advance directly to Phase 3;
- if all remaining neutral document/requirement mappings have compatible source-selection receipts and no source/selection/retrieval/planner input changed, reuse the prior selection outcome without treating it as factual coverage, skip discovery/planning, and reproduce the prior satisfied/gap decision;
- if the remaining work is entirely `in_progress` under compatible fenced coverage reservations, skip discovery/planning/provider calls, persist wait/import dependencies, and resume only after those receipts settle or expire into bounded recovery;
- if uncovered work is all-in-scope-only, skip ranking and planning, persist the deterministic direct assignments, and enter Phase 2;
- if only a small new/changed delta lacks selection receipts, compute only its new raw signals, assemble rankings against compatible cached corpus signals where ranking semantics require it, and expose only actionable delta candidates to the planner;
- never rerun the complete first-time corpus search merely because the report date changed.

### 7.4 Zero or one valid plan with bounded provider retries

When required document-matrix retrieval completes for uncovered requirements, the model receives its persisted allowlist and matrix, including a valid zero-candidate matrix:

- the immutable template data requirements;
- stable requirement and query keys;
- dataset titles, short descriptions of required output, expected cardinality, and immutable refresh policy;
- the allow-listed candidate keys and relevance matrix;
- one compact requirement-level coverage summary and only actionable uncovered candidate cells; any covered cell retained because the document is actionable for another requirement is explicitly non-selectable;
- hard maximums for documents, requests per document, and total logical assignments;
- the server-compiled date-independent source intent, only when it adds factual scope beyond the manifest.

The model receives no database UUID that it needs to reproduce. The server assigns opaque `candidateKey` values and maps them to pinned rows.

The planner's job is narrow:

- decide which candidate documents can serve each still-uncovered requirement;
- group compatible requirements by document;
- reference the exact existing query keys and set bounded scheduling priority;
- identify requirements that have no credible source candidate;
- order high-value or prerequisite work first.

It must not extract facts, choose a model, choose concurrency, alter a schema, apply a report date, enqueue work, or invoke a retrieval tool.

It also must not inspect existing Task Dataset record bodies, decide whether a prior result is reusable, or infer that an already-populated dataset makes every new source redundant. Those are server-owned coverage and merge decisions.

The planner may select only document/query/requirement triples represented by an exact `matched` assignment-state cell. It never selects direct all-in-scope assignments and may not promote an `unobserved` cell to evidence merely from a title or filename.

### 7.5 Planner response contract

```json
{
  "version": 1,
  "documentPlans": [
    {
      "candidateKey": "doc_014",
      "priority": 80,
      "requests": [
        {
          "requirementKey": "grant_portfolio",
          "queryKeys": ["grant_updates", "grant_finance"],
          "reason": "The register is the strongest candidate for both grant queries."
        }
      ]
    }
  ],
  "unassignedRequirements": [
    {
      "requirementKey": "capital_risk",
      "reasonCode": "no_credible_candidate",
      "explanation": "No supplied candidate carries a meaningful match."
    }
  ],
  "notes": []
}
```

The model cannot emit:

- document UUIDs;
- dataset IDs or source-snapshot IDs;
- record schemas;
- claim tokens;
- provider/model routes;
- slot counts;
- report-period filters;
- Task Dataset write commands;
- new query or requirement keys;
- free-form worker extraction instructions or schema changes.

### 7.6 Validation and hardening

Before any row becomes claimable, the server:

1. validates the response schema;
2. resolves every opaque candidate from the exact supplied allowlist;
3. resolves every requirement and query key from the pinned manifest;
4. validates every planner-selected candidate/query/requirement triple against the exact persisted `matched` assignment-state cell, and validates server-created all-in-scope assignments separately;
5. rejects out-of-scope or newly changed documents;
6. attaches authoritative schemas, temporal rules, identity policy, evidence policy, dataset/source identities, and bounded discovery anchors;
7. removes duplicate document/requirement assignments;
8. checks maximum assignments, documents, estimated input tokens, and estimated output records;
9. rejects any selected mapping already marked `covered` or `in_progress` in the pinned coverage ledger;
10. binds every accepted assignment to the exact server-owned Task Dataset Group, dataset definition, transaction/generation, and coverage identity.
11. requires every required requirement to be covered, already satisfied, or explicitly unassigned;
12. includes discovery request/result digests in plan and envelope-attempt provenance without changing stable logical-assignment identity;
13. writes the complete batch atomically.

The server must reject the whole plan rather than insert a partial fan-out. A timeout, connection loss, 429, or provider 5xx may receive one transient retry/failover under the same planner input digest. Separately, one bounded JSON-repair provider attempt may correct syntactically malformed output. The absolute maximum is three planner provider attempts. Semantic errors, unknown keys, out-of-allowlist selections, or invalid source claims are not repairable by prompting and fail planning explicitly. No retry or repair is a return to the planner after Phase 2 begins.

### 7.7 Phase 1 gate

Phase 1 succeeds only when:

- document discovery is explicitly skipped because no retrieval-backed assignment remains, or its durable node has succeeded and its bounded request/result matrix and digests are persisted;
- every uncovered retrieval-backed query/requirement mapping is represented in the discovery result, including explicit no-match results;
- the planner node is explicitly skipped for the zero-work/all-in-scope-only path, or has durable input and output digests derived from that discovery result;
- all IDs and keys are server-resolved;
- the work batch, every logical assignment, and every requirement rollup are committed;
- no order is claimable until the complete batch/assignment transaction commits;
- a batch with at least one claimable work order keeps the parent Task item `running`, sets its durable `phaseKey = compile_source_data` and `waitKind = template_work_orders`, and defers the separate queue job. A zero-order terminal batch resolves synchronously and never enters the waiting queue state.

If every assignment is already covered, Phase 1 creates a zero-order completed batch and immediately makes Phase 3 eligible.

If discovery succeeds but the planner returns only unassigned requirements, Phase 1 has no child settlement to close the batch. It atomically finalizes the zero-order batch as `completed_with_gaps` for optional gaps (and, only when policy permits, creates a diagnostic Phase 3 snapshot with `publishable = false`) or as `failed_required` for required gaps. It never leaves a zero-order batch in `ready` or `running`.

---

## 8. The deferred hand-off

Ending the planner call is necessary but not sufficient. The parent saved-Task job must yield its worker lease so the same worker installation can process child work.

Add an explicit non-error defer/resume path:

1. `defer_extraction_task_run_job()` verifies the current lease token.
2. It marks the job `waiting`, clears the lease, stores `wait_kind = 'template_work_orders'` and the batch ID, and leaves the Task run/item nonterminal.
3. Work-order workers process the child queue independently.
4. The settlement RPC for the final barrier condition changes the parent job from `waiting` to `queued` exactly once.
5. It wakes the worker service.
6. The resumed parent loads the already-succeeded discovery/planner nodes and batch; it reuses discovery by digest and never repeats Phase 1 unless the query set, source scope, index revision, compatible-coverage identity, or another pinned input changed, or the user chose a full restart.

Job claim count and failure count must be separate:

- `lease_epoch` or `total_claims` is monotonic and used for fencing/telemetry;
- `consecutive_failure_attempts` controls retry exhaustion;
- a successful defer/resume boundary resets consecutive failure attempts;
- normal phase resumptions do not consume the three existing whole-job retry attempts.

`processExtractionTaskRunJob()` must accept a `deferred` disposition instead of treating every nonterminal Task status as an error.

---

## 9. Phase 2 — Compile date-independent file data

### 9.1 Unit of tracking versus unit of model dispatch

Two granularities are needed:

- **logical assignment:** one document fingerprint × one requirement digest. This is the unit of coverage, idempotency, validation, and retry;
- **document envelope:** one model call containing one or more compatible logical assignments for the same document. This lets the model read the full Markdown once.

A document with one requested item normally creates one assignment and one model call. A document serving several compatible requirements normally creates one envelope with several assignments. The recommended initial cap is two high-volume requirements per envelope; several small bounded scalar requirements may share an envelope when the token/output estimate remains safely below its limit. Split an envelope when:

- the complete document plus contracts exceeds the route's safe input budget;
- the combined response could exceed the safe output budget;
- contracts require incompatible response modes;
- deterministic document sharding is required.

Progress must show both counts. “18 of 20 assignments complete” and “9 of 10 model envelopes complete” are not interchangeable.

### 9.2 Worker scheduling

Use a new capacity kind such as `template_work_order`.

The worker loop:

1. counts eligible orders;
2. requests up to `min(15, eligible orders, route capacity, tenant fair share)` slots;
3. claims exactly the granted number with `FOR UPDATE SKIP LOCKED`;
4. releases unused slots if fewer rows are claimable;
5. executes the claimed envelopes with `Promise.allSettled`;
6. heartbeats leases while provider calls are active;
7. releases every slot in a `finally` path.

Claim capacity before rows so an order does not sit leased while waiting for a model slot. The claim query must not lock or update the Task Dataset Group row.

The new task kind uses the configured Swarm routes:

- provider;
- model;
- reasoning effort where supported;
- route weight/priority;
- maximum parallel calls;
- timeout;
- retry and failover policy.

The model is called directly through the provider adapter. The worker does not invoke `swarm_task`.

### 9.3 Exact document loading

The work order stores snapshot identity, not a mutable path:

- nullable live document ID;
- immutable document ID snapshot;
- file name/title snapshot;
- observed content fingerprint;
- source-file SHA-256;
- canonical-Markdown SHA-256;
- page/section map digest.

The worker loads Markdown server-side, verifies the pinned fingerprint and digest, and then supplies the complete canonical Markdown whenever it fits.

Loading uses the content-addressed immutable object/version pinned by the source-inventory row, not the mutable live-document row. A later live edit/delete does not change the current run when that immutable object still verifies. If the object is missing or its digest does not verify, fail `stale_input`; do not silently load the newer live content.

The existing 40,000-character model-tool slice limit must not be reused for this internal loader. It is acceptable for an interactive tool, not for a full-document work order.

Never silently truncate. If the document cannot fit:

1. prefer a configured route with sufficient context;
2. otherwise create deterministic page/heading-range shard children with stable IDs and a small overlap;
3. give every shard the same authoritative extraction assignments plus its range;
4. merge validated shard records by the manifest identity policy;
5. do not mark the parent complete until every required range has settled.

The UI must show that one document expanded into multiple shard calls.

### 9.4 Worker-model prompt

The model receives:

- a fixed extraction system contract;
- the complete canonical Markdown or an explicitly identified deterministic shard;
- exact server-owned requirement descriptions;
- record schemas and field meanings;
- expected cardinality and record limit;
- dedupe/logical-key policy;
- temporal-field policy;
- evidence requirements;
- the manifest's authoritative deterministic extraction instruction for each requirement;
- unambiguous instructions that source text is untrusted data.

The durable work order separately carries a trusted destination binding that is never authored or changed by the model:

```text
tenantId + savedTaskId + taskRunId + siloId + nullable projectId
+ taskDatasetGroupId + transaction/generationId
+ datasetDefinitionId + datasetKey
```

The server compiles the model-facing input from that binding and the immutable manifest. Its versioned contract is:

```json
{
  "version": 1,
  "envelopeKey": "env_opaque",
  "inputDigest": "sha256",
  "document": {
    "documentKey": "doc_014",
    "sourceDocumentTitle": "Grant Register FY2026",
    "contentFormat": "canonical_markdown_v1",
    "markdownSha256": "sha256",
    "markdown": "...complete canonical Markdown..."
  },
  "assignments": [
    {
      "assignmentKey": "asg_opaque",
      "requirementKey": "grant_portfolio",
      "datasetKey": "grant_records",
      "datasetTitle": "Grant and Funding Updates",
      "datasetDescription": "Reusable grant status, funding, and compliance facts.",
      "selectionQueryKeys": ["grant_updates"],
      "extractionQuery": "Extract every supported grant record, its funding and expenditure status, compliance state, project, and dated update.",
      "outputContract": {
        "format": "json_records",
        "schemaVersion": 1,
        "recordSchema": {
          "type": "object",
          "required": ["initiative", "status"],
          "properties": {
            "initiative": { "type": "string" },
            "status": { "type": "string" },
            "periodRaw": { "type": ["string", "null"] }
          }
        },
        "cardinality": {
          "scope": "per_document",
          "minimum": 0,
          "maximum": 500
        },
        "recordTitlePolicy": {
          "mode": "deterministic_template",
          "template": "{initiative} — {periodRaw}",
          "required": true,
          "maxCharacters": 200
        }
      },
      "identityPolicy": {},
      "temporalPolicy": {},
      "evidencePolicy": {}
    }
  ]
}
```

`selectionQueryKeys` explain why discovery selected the document; they are not the extraction request. `extractionQuery` is the exact ingestion-authored question that tells Phase 2 what facts to compile. The model may answer only the supplied assignments and output contract; it cannot rewrite either one.

`inputDigest` covers the canonical envelope metadata, exact ordered assignment contracts, content fingerprint, and complete Markdown hash. A retry receives the same logical input; route/attempt/lease metadata is tracked separately and cannot change what is being extracted.

“Data format” here means the strict structured `json_records` envelope, JSON Schema, field meanings, cardinality, identity, temporal, title, and evidence policies required for Task Dataset persistence. Markdown, CSV, and final DOCX formatting belong to later report preparation/rendering, not Phase 2 source extraction.

Three titles have distinct roles:

- `sourceDocumentTitle` is immutable source metadata used for provenance;
- `datasetTitle` is the template-authored human name of the Task Dataset definition;
- `recordTitle` is the human-readable name of one returned record.

`datasetKey` and `logicalKey`, never titles, provide stable identity. Prefer a deterministic `recordTitlePolicy` derived from validated fields. If semantic model-generated titles are genuinely required, their rules and validation become part of `extractionContractDigest`. A display-only dataset-title rename updates metadata without forcing source re-extraction.

The extraction instruction must say:

- extract every period present for `period_scoped` data;
- retain raw period/date labels and normalized values;
- do not apply the current report period;
- preserve conflicting supported facts rather than silently choosing one;
- never invent a value;
- never emit “Not Available from Source” as a field value;
- return `not_applicable` only with a specific source-supported reason;
- attach page, section, heading, or chunk evidence to every material record.

### 9.5 Minimal tool surface

The fast path should use provider-native structured output or one strict final JSON response. The extraction model does not receive:

- Swarm tools;
- `rag_search`, `rag_documents`, or any other RAG tool;
- Task Dataset tools;
- DOCX editing tools;
- general cache tools.

Server-owned statuses are authoritative: queued, loading document, calling model, validating, persisting, retrying, and completed. If the provider can use `model_status` without breaking structured output, the model may also publish bounded narrative updates. Status is optional for correctness and must not force extra reasoning turns.

For an unusually large response, a future bounded `submit_extraction_records` channel may accept chunks, but it must be specific to the current work order and validated by the server. It is not a general cache or dataset tool.

### 9.6 Result contract

```json
{
  "version": 1,
  "envelopeKey": "env_opaque",
  "inputDigest": "sha256",
  "results": [
    {
      "assignmentKey": "asg_opaque",
      "outcome": "records",
      "records": [
        {
          "logicalKey": "grant:water-main:fy2026",
          "data": {
            "initiative": "Water Main Replacement",
            "amount": 450000,
            "status": "Awarded",
            "lastUpdateDate": "2026-07-18",
            "periodRaw": "FY 2026"
          },
          "evidence": [
            {
              "pageNumber": 7,
              "tableLabel": "Grant Awards",
              "markdownStart": 8420,
              "markdownEnd": 8612
            }
          ]
        }
      ]
    }
  ]
}
```

The version-1 result schema is a discriminated union:

- a full-document assignment returns `records` with at least one validated record, or `not_applicable` with a bounded reason and evidence proving the complete assigned source was reviewed;
- a shard returns `records` with at least one validated record, or `no_records_in_range` with its exact range key;
- a shard may never claim whole-document `not_applicable`; only the deterministic merge after every range settles may derive that result;
- `records: []` is never a terminal outcome.

The initial evidence locator aligns with the existing Task Dataset contract: optional `pageNumber`, `tableLabel`, `markdownStart`, `markdownEnd`, `excerpt`, and `excerptSha256`, with at least one verifiable location required by the Manifest-v2 evidence policy. Phase 2 may add versioned supported-field paths and a shard-range key, but it must not substitute ad hoc `page`/`heading`/`anchor` names. The server attaches immutable artifact/document identities and verifies offsets against the exact Markdown hash.

The server checks:

- the envelope key, input digest, assignment keys, and result count exactly match the fenced work order;
- every record matches the immutable record schema;
- record count is within the manifest limit;
- logical keys are canonical or derivable;
- every required `recordTitle` is deterministically derived or validated against the pinned title policy, and no title is used as a dedupe key;
- dates and numbers are parseable without lossy coercion;
- evidence points into the assigned document/range;
- placeholder/fallback strings are rejected;
- no unknown assignment appears.

With a deterministic title policy, the model omits `recordTitle` and the server derives it after schema validation—for example, `Water Main Replacement — FY 2026` from the sample fields. A `model_semantic` policy may require a returned `recordTitle`, but the server still bounds and validates it. The model never returns a dataset destination, dataset title, Task ID, silo ID, project ID, or write command; the server resolves those from `assignmentKey`. A bare empty `records` array is not success: the result must use an explicit evidenced `not_applicable` outcome with a bounded reason, or remain incomplete and retry/fail under policy.

### 9.7 Server-owned Task Dataset persistence

The model does not claim, write, or seal Task Dataset sources.

The destination is resolved under exactly:

```text
tenant + saved Task + silo + nullable project + Task Dataset Group + datasetKey
```

Records that happen to exist under another Task, silo, project, group, or dataset definition can never satisfy or receive this assignment. The settlement RPC rejects any mismatch among the batch, Task run, pinned Task Dataset Group, transaction/generation, dataset definition, logical assignment, and source snapshot.

The existing Task Dataset definition `name` is the persisted `datasetTitle`; its existing description and record schema carry the human explanation and data format. If templates require a separately displayed title for each record, add an optional `record_title` column (or an equivalent indexed derived projection) rather than overloading `logical_key`. Keep `summary` and `search_text` available for retrieval, but do not treat either as stable identity.

After validation:

1. persist the validated assignment result and its digest on the work-order child row;
2. claim the exact Task Dataset source snapshot for that requirement and document;
3. verify its observed fingerprint and generation;
4. attach the authoritative dataset title/description and derive or validate each record title from the pinned definition;
5. write deterministic contribution batches with idempotency keys derived from the stable logical-assignment digest, canonical record key, and shard-merge identity—not the title or envelope/work-order attempt digest;
6. retain record/source evidence, extraction/schema provenance, and the immutable source-Markdown pointer and hashes without copying the complete Markdown into every record;
7. seal the source or mark it `not_applicable` with an explicit reason;
8. mark the assignment succeeded only after the Task Dataset operation commits.

An evidenced `not_applicable` result also records the originating discovery rank/mode as a source-selection false positive. This feeds query-quality and candidate-precision telemetry without changing the current run's immutable discovery result.

Current source snapshots are unique per dataset/generation/document. Manifest version 2 therefore enforces one canonical extraction requirement per `datasetKey`; multiple source-query keys and report bindings may feed that requirement, but two distinct requirement contracts may not target the same dataset. A document envelope containing several requirements consequently maps to several dataset-scoped source snapshots. If future requirements must share one dataset, first migrate snapshot identity and settlement to include the requirement/contract digest. There is no single global document claim.

To avoid dual authority between the work-order state and Task Dataset source state, add a targeted settlement RPC. It must verify the work-order lease token/epoch and update the exact source snapshot and assignment settlement in one idempotent boundary. A partial multi-requirement commit is recoverable: already committed assignments remain complete and retry resumes only the uncommitted children.

### 9.8 Reuse and idempotency

A logical assignment digest should include:

```text
template work-order pipeline/extraction-contract version
+ Task Dataset scope identity (tenant, saved Task, silo, nullable project, group, and datasetKey)
+ extractionContractDigest (including extraction query, requirement, schema, identity, cardinality, semantic title, temporal extraction, and evidence semantics)
+ document snapshot identity
+ observed source/content/Markdown fingerprints
```

Source-query text and discovery/plan digests are selection provenance, not logical coverage identity. If an instruction change alters which facts or fields workers must extract, ingestion must place that change in `extractionContractDigest`; changing retrieval wording or a display-only title alone must not invalidate otherwise compatible extracted records.

Envelope-attempt and shard-child digests are separate. They include the stable logical-assignment digest plus grouping, provider-contract, and deterministic shard-range identity. Sharding therefore does not create a second logical assignment or a second Task Dataset contribution identity.

It must not include:

- the report month/date range;
- a random worker ID;
- lease tokens;
- a provider response ID.

Every retry uses the same logical digest. A changed source or requirement creates a different digest. Late results from an older lease epoch are rejected.

### 9.9 Retry and failover

Classify errors rather than matching only message text:

| Failure                                             | Worker action                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Connection interruption, 429, provider 5xx, timeout | retry with jitter; rotate to a compatible route when configured                                            |
| Invalid structured output                           | one corrective schema retry, then route failover or terminal failure                                       |
| Input too large                                     | route to larger context or create deterministic shards                                                     |
| Output too large                                    | split compatible assignments or use bounded result chunks                                                  |
| Immutable source pointer/fingerprint mismatch       | terminal `stale_input`; require an explicit new/restarted run and plan epoch—never replan inside version 2 |
| Source deleted/out of scope                         | terminal scoped failure; never erase the audit row                                                         |
| Explicit, evidenced irrelevance                     | mark the exact assignment `not_applicable`                                                                 |
| Repeated empty result for a required assignment     | terminal gap requiring review                                                                              |
| Cancellation                                        | abort, fence, and mark cancelled                                                                           |

Use a default maximum of three provider/failure attempts per envelope, configurable within a safe bound. Track claim/lease epochs and the one schema-repair attempt separately: reclaiming an expired lease before a provider request does not exhaust extraction retries. A syntax repair consumes its own bounded repair counter and also counts against provider/cost telemetry. Failure never reopens the planner model.

### 9.10 Canary and circuit breaker

New or recently changed routes should run a small canary wave, normally three envelopes. Release the remaining capacity when:

- the route responds;
- the result schema-valid rate meets the minimum;
- no systemic authorization/context error occurs.

Healthy routes with recent successful telemetry may skip the canary delay.

Pause a route or batch when:

- no order completes for twice the current p95 duration;
- schema-invalid responses exceed 2%;
- terminal failures exceed 0.5%;
- the same provider error repeats across the canary;
- active calls remain below 70% of grantable concurrency for at least 60 seconds while an eligible queue is nonempty. For the measured scope, `grantable concurrency = min(route cap, tenant fair-share cap, activeForScope + freeGlobalSlots, activeForScope + eligibleQueued)`, and utilization is `activeForScope / grantableConcurrency`. Including current active calls prevents impossible percentages above 100%; the denominator is not the global 15-slot ceiling.

The worker, not a planner model, applies these controls.

### 9.11 Phase 2 gate

Phase 2 is complete when every logical assignment is terminal and:

- every required requirement's aggregate rollup satisfies its declared minimum cardinality/evidence contract across all assigned documents;
- an individual evidenced `not_applicable` candidate is allowed even for a required requirement when other assignments satisfy the aggregate contract;
- a required requirement with no source candidate or an unsatisfied aggregate is an explicit `failed_required` gap, not a successful assignment;
- optional failures are represented as gaps;
- every multi-requirement envelope has a terminal rollup consistent with all child assignments, and every split parent is `superseded_by_children` with all deterministic children settled;
- no active lease remains;
- Task Dataset contribution state matches the work-order state;
- the batch rollup is atomically finalized.

A terminal gap in a required requirement rollup must block trusted completion or set `reviewState = needs_review` with `publishable = false` under diagnostic policy. It must never be converted to covered or `not_applicable` merely to advance the run.

Only `succeeded` and `completed_with_gaps` batches may make normal Phase 3 eligible. `completed_with_gaps` carries `reviewState = needs_review` and `publishable = false` unless the Task's explicit optional-gap policy allows publication. `failed_required` blocks normal Phase 3, though policy may permit a diagnostic snapshot that cannot be rendered/published as complete.

Every terminal batch outcome—`succeeded`, `completed_with_gaps`, `failed_required`, `failed`, or `cancelled`—wakes or resolves the parent exactly once. The resumed parent decides whether to advance, expose review/retry, fail, or acknowledge cancellation. It must not remain waiting merely because Phase 3 is ineligible.

---

## 10. Phase 3 — Prepare data for the report

Phase 3 converts reusable, date-independent Task Dataset records into one immutable run-specific `ReportDataSnapshot`.

### 10.1 Inputs

- pinned template contract and execution plan;
- immutable Task Dataset as-of view at the pinned base publication watermark, including compatible carried-forward records and this transaction's validated/accepted staged contributions from sealed assignments;
- terminal Phase 2 assignment-output digests;
- Task request and factual run input;
- normalized report period and timezone;
- ingestion-authored identity, temporal, filtering, sorting, aggregation, and conflict rules.

`active_generation` is a publication watermark, not a predicate requiring every visible record's own `generation` to equal the newest value. Build and digest an immutable as-of view from all prior active records valid at the pinned base watermark, including unchanged records physically written by earlier generations, plus only this transaction's validated/accepted staged contributions whose assignments are sealed. Exclude pending, failed, or unaccepted rows. A date-only warm run with zero Phase 2 writes must therefore see the same reusable facts rather than an empty dataset, while a first run still sees its newly extracted staged facts before final publication.

Construct that view as a deterministic overlay, not a concatenation: a staged contribution with the same dataset/canonical dedupe key replaces or merges with the base record under the dataset conflict policy, and staged source removals subtract their prior contributions. Compute `datasetViewDigest` after this overlay so warm data, totals, conflicts, and retries cannot be double-counted.

### 10.2 Date handling

Date filtering happens here and nowhere else.

For `static` requirements:

- retain the current compatible facts under the manifest conflict policy.

For `period_scoped` requirements:

- filter using ingestion-declared normalized temporal paths;
- retain raw source labels for display and audit;
- apply explicit calendar/fiscal boundaries and timezone;
- treat incomplete or ambiguous dates conservatively;
- record why each record was included or excluded.

For `run_supplied` requirements:

- use Task input values;
- do not create Phase 2 source orders.

If the Task supplies no date, the template manifest must define `latest`, `current`, `all`, or an explicit no-date policy. A model must not guess silently.

### 10.3 Deterministic preparation

Prefer code for:

- exact filtering;
- stable deduplication;
- conflict grouping;
- sums, counts, averages, and other declared calculations;
- collection sorting and maximum-row enforcement;
- enum/status formatting;
- source/evidence register generation;
- direct field and collection mappings;
- omitted optional-section decisions.

Phase 3 makes no narrative model call. For each declared narrative segment, it deterministically prepares a bounded fact/dependency packet with provenance, ordering, length budget, and unresolved gaps. Phase 4 is the single owner of schema-bound narrative wording.

### 10.4 Snapshot contract

```json
{
  "version": 1,
  "snapshotId": "uuid",
  "taskRunId": "uuid",
  "taskRunItemId": "uuid",
  "templateVersionId": "uuid",
  "extractionContractDigest": "sha256",
  "reportShapingDigest": "sha256",
  "basePublicationWatermark": 41,
  "stagedOverlayDigest": "sha256",
  "datasetViewDigest": "sha256",
  "reportPeriod": {
    "mode": "range",
    "start": "2026-08-01",
    "endExclusive": "2026-09-01",
    "timezone": "America/New_York"
  },
  "datasets": {},
  "bindings": {},
  "sourceRegister": [],
  "conflicts": [],
  "gaps": [],
  "selectionSummary": {
    "considered": 480,
    "included": 74,
    "excludedByDate": 391,
    "excludedByPolicy": 15
  },
  "snapshotDigest": "sha256"
}
```

The snapshot digest covers the immutable dataset-view digest, `extractionContractDigest`, `reportShapingDigest`, normalized period, factual run input, transformation-contract version, and result content. It excludes `presentationDigest` and the umbrella manifest identity. A layout/style-only edit therefore reuses Phase 3 and invalidates only Phase 4.

### 10.5 Phase 3 gate

- every selected value has provenance or is explicitly marked as Task input/calculation;
- all declared deterministic calculations validate;
- conflicts are preserved or resolved under a declared policy;
- required bindings have data or a specific gap;
- the immutable snapshot and digest are persisted.

No broad source-search loop or supplemental Phase 2 cycle is permitted in pipeline version 2. A Phase 3 gap records the exact missing requirement/candidate evidence and ends as review/failure under policy. A later explicit rerun can reuse completed logical assignments and plan only the unresolved delta. Multi-cycle in-run repair can be designed later with ordered batch/cycle identity and exactly-once wake per batch; it is not implicit in this release.

---

## 11. Phase 4 — Fill and render the report

Phase 4 reads only the pinned template contract and the Phase 3 snapshot.

### 11.1 Filling strategy

1. Create the DOCX workspace from the immutable template version.
2. Apply direct scalar and collection bindings deterministically.
3. Follow ingestion-generated dependency layers.
4. For a declared narrative/synthesis segment, call one bounded formatting model with:
   - the exact segment contract;
   - only its prepared bindings and dependencies;
   - its style/length rules;
   - a strict `TemplateFieldPayload` output schema.
5. Apply validated payloads to the single document workspace.
6. Generate source-register rows from Phase 3 provenance.
7. Omit unresolved optional content according to the contract.

The Phase 4 narrative call receives only the Phase 3 fact/dependency packet and the `presentationDigest`-owned prompt/style contract. It never receives the source corpus or retrieval tools, and no segment is modeled once in Phase 3 and again in Phase 4. 8. Run the bounded completeness check. 9. Render once through the deterministic DOCX renderer.

Parallel semantic formatting is safe only for independent dependency-layer segments. The DOCX workspace remains single-writer.

### 11.2 Hard rules

- no RAG search;
- no source-document reopening;
- no Task Dataset mutation;
- no Swarm coordination tool;
- no general cache-file loop;
- no fabricated fallback values;
- no “Not Available from Source” placeholder values;
- no template comments in the output;
- no layout changes outside compiled contract operations.

### 11.3 Required gaps

Gap outcomes are phase-specific:

| Gap                                                                           | Execution outcome                                                             | Publication                                                                                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Phase 2 requirement rollup remains `gap_required`                             | batch `failed_required`; Task item `failed`                                   | no active Task Dataset generation and no report publication; an optional diagnostic snapshot may be retained |
| Phase 2 optional rollup is `gap_optional`                                     | batch `completed_with_gaps`; Task item may continue                           | `reviewState = needs_review`; publish only if the Task's explicit optional-gap policy allows it              |
| Phase 4 required binding/render gap after Phase 2 requirements were satisfied | Task policy chooses `failed` or execution `succeeded` with review-only output | always `reviewState = needs_review`, `publishable = false`                                                   |

If a required field or collection remains missing after the bounded gate:

- do not publish a document as fully trusted;
- retain the prepared snapshot and partial workspace for diagnosis;
- identify the requirement, candidate source, and failure cause;
- set `reviewState = needs_review` with `publishable = false`, or set execution status `failed`, according to the Task's required-output policy.

Optional empty sections follow the ingestion-authored `empty` behavior and may be removed without disturbing layout.

---

## 12. Persistence model

Keep `extraction_task_run_plans` and `extraction_task_run_plan_nodes` for the high-level DAG. Add dedicated normalized tables for the high-volume deferred queue instead of overloading one JSON field on a plan node.

### 12.1 `extraction_template_work_batches`

One version-2 source-planning/extraction barrier for a template Task item. It is created before discovery so Phase 1 artifacts and Phase 2 work share one fenced identity.

Core fields:

- tenant, plan, Task run, and Task item IDs;
- exact Task Dataset Group, transaction, pinned base-publication watermark, target generation, and publication-owner identities;
- nullable discovery/planner node IDs/input/output digests plus explicit `discoverySkippedReason`/`plannerSkippedReason`;
- nullable discovery contract/configuration version, index revision, query-set digest, covered-assignment digest, request digest, and result digest when discovery ran;
- nullable discovered/query/no-match-mapping/candidate/signal-cell/assignment-state-cell counts and bounded discovery error summary;
- source-scope integer revision and frozen-snapshot digest;
- template/manifest/contract identities;
- state: `created | discovering | discovery_retry_wait | planning | planner_retry_wait | prepared_nonclaimable | waiting_on_coverage | ready | running | paused | activation_failed | succeeded | completed_with_gaps | failed_required | failed | cancelled`;
- rollout mode snapshot, activation state/epoch, pipeline/envelope/result versions, activation-failure reason, and emergency claim/publication gate snapshots;
- `reviewState: clear | needs_review` and `publishable` as separate trust/publication outcomes rather than execution statuses;
- discovery/planner transport-attempt counts, syntax-repair count, `available_at`, and structured retry reason;
- plan epoch and nullable validated planner JSON for retrieval-backed work;
- route/configuration snapshot;
- desired and maximum parallelism;
- canary state;
- document, envelope, and logical-assignment counters;
- terminal/retry/error rollups;
- Task Dataset publication-lease custody state, coordinator epoch/token hash, expiry, and last renewal;
- timestamps.

### 12.2 `extraction_template_source_inventory`

One frozen Phase 1 source candidate per batch, separate from Task Dataset source claims.

Core fields:

- batch, tenant, run, item, source-scope revision/digest, and opaque candidate key;
- nullable live document ID plus immutable file/title/date/metadata snapshot;
- source, canonical-Markdown, content, page-map, keyword-index, and vector-index fingerprints;
- content-addressed immutable Markdown/page-map object pointers or retention pins;
- eligibility/removal state and timestamps.

Inventory rows are candidates only. They do not become pending Task Dataset source snapshots and do not participate in Task Dataset sealing. Create/claim Task Dataset source snapshots only for planner-selected or server-created all-in-scope logical assignments (and explicit removal operations). An unselected or unobserved inventory row remains neutral—it is neither covered nor `not_applicable`.

#### 12.2.1 `extraction_template_source_tombstones`

The Phase 1 source-diff step creates staged removal operations when a previously published source leaves the exact Task/silo/project scope, when a stable document receives a new content fingerprint, or when an incompatible dataset definition is explicitly replaced. Each row stores the old contribution/source-snapshot identity, reason, target transaction/generation, replacement reference when present, idempotency digest, state, and audit timestamps.

A tombstone changes only the target transaction overlay. It publishes atomically with replacement contributions, remains inactive if the run fails, and never deletes the old immutable audit artifact or coverage receipt. Retrying the same diff creates no second removal.

### 12.3 `extraction_template_discovery_attempts`

One fenced attempt to build the immutable Phase 1 candidate matrix.

Core fields:

- batch, tenant, run, item, and discovery-node IDs;
- state: `pending | running | retry_wait | succeeded | failed | cancelled`;
- attempt number, maximum attempts, `available_at`, cancellation epoch, and bounded lease/heartbeat data;
- canonical request and result object pointers (or bounded JSON columns), request/result digests, and contract/configuration/index/source-scope revision/digests;
- per-query terminal statuses/errors and query/candidate/matrix/cache/backend-search counters;
- structured failure code/message and timestamps.

The raw cancellation/lease token is never stored on a work order or exposed through inspection. Only a token hash and monotonic epoch are persisted. At most one attempt for a batch may be active; a late result from an older epoch cannot make planning eligible.

### 12.4 `extraction_template_document_query_matches`

One persisted document × query signal from the bounded discovery result. This normalized audit table supplements, rather than replaces, the immutable request/result JSON and digests.

Core fields:

- batch, discovery node, tenant, run, and item IDs;
- opaque candidate key plus nullable live document ID;
- immutable file/title/content-fingerprint snapshot;
- query key/digest;
- nullable query score and retrieval/fallback mode;
- best anchor, supporting-chunk count, and distinct-page count;
- request/result/configuration/index digests;
- timestamps.

The unique identity is batch × candidate × query. Score/anchor data is stored once even when the query serves several requirements.

### 12.5 `extraction_template_document_candidate_assignments`

One requirement-specific state for a document/query match.

Core fields:

- document-query-match and requirement key/digest;
- state: `matched | unobserved | covered`;
- nullable `eligibleRank` and `eligiblePercentile` computed after that requirement's coverage exclusions;
- compatible-coverage identity when state is `covered`;
- request/result digests and timestamps.

The unique identity is batch × candidate × query × requirement. `unobserved` and `covered` never store invented rank, percentile, or zero score. Direct all-in-scope assignments bypass both ranked-candidate tables.

#### 12.5.1 `extraction_template_source_selection_receipts`

One cross-run selection-evaluation receipt per exact Task Dataset scope × stable source/fingerprint × requirement × `sourceSelectionDigest` × retrieval/planner contract. It stores `selected | not_selected | no_match | unobserved`, the discovery/plan/coverage-summary digests, relevant indexed-artifact/configuration identities, evaluated source-scope revision, and timestamps.

These receipts suppress repeated source selection only when every selection input remains compatible. They never create Task Dataset source claims, prove factual absence, or satisfy extraction coverage. New/changed files have no compatible receipt and form the next delta. A query, retrieval/planner policy, indexed artifact, or explicit rebuild change invalidates the affected receipt. Reusing `unobserved` means only that the identical bounded selection process need not be rerun; it must still be displayed as unknown rather than no-match.

### 12.6 `extraction_template_work_orders`

One document envelope, or one deterministic document shard when required.

Core fields:

- batch, tenant, run, item, and high-level node IDs;
- nullable live document ID with `ON DELETE SET NULL`;
- immutable document ID/file/title snapshot;
- source-file, Markdown, content, and page-map fingerprints;
- content-addressed immutable Markdown object/version pointer and page-map pointer, retained or pinned until the batch and its audit-retention period end;
- parent order and shard range;
- envelope/work-order digest and priority;
- state: `prepared_nonclaimable | pending | leased | running | validating | persisting | retry_wait | splitting | superseded_by_children | succeeded | completed_with_failures | cancelled`;
- separate claim count, provider/failure attempts, schema-repair attempts, maximums, and `available_at`; lease reclaim alone does not consume an extraction attempt;
- lease owner, epoch, token hash, expiry, and heartbeat;
- selected provider/model/route and slot lease;
- input/output token and character counts;
- validated result location/digest;
- latest model/server status, lease epoch, monotonic status sequence, and last outbox event ID;
- structured error code/message;
- timestamps.

### 12.7 `extraction_template_logical_assignments`

One batch-level frozen source-inventory row × requirement digest assignment. It is not duplicated when an envelope is split into shards or regrouped on retry, and two distinct source documents with identical bytes remain distinct assignments.

Core fields:

- batch, frozen document snapshot, and source-scope IDs;
- requirement/dataset keys, semantic digests, and refresh policy;
- authoritative dataset title/description snapshots for display, kept separate from stable identity;
- exact extraction query/instruction, output-contract version, and their digests;
- dataset definition, record-schema, identity-policy, record-title-policy, temporal-policy, and evidence-policy references/digests;
- exact server-owned Task Dataset Group, dataset-definition, transaction/generation, and source-snapshot IDs for the pinned Task/silo/nullable-project scope;
- query keys and non-semantic planner selection rationale/priority for audit;
- selected eligible rank/percentile, query score, and anchor reference, or explicit direct-all-in-scope selection policy;
- expected cardinality and limits;
- required/optional flag;
- temporal and evidence policy references;
- state: `pending | waiting_for_coverage | importing | running | succeeded | not_applicable | failed_terminal | cancelled` plus immutable requirement requiredness;
- merged validated result/result digest, derived/validated record titles, and one authoritative Task Dataset commit status;
- record, conflict, and evidence counts;
- Task Dataset batch/seal references;
- result origin (`provider | imported_artifact`), prior artifact reference, and idempotent import receipt when reused;
- gap or error details.

### 12.8 `extraction_template_requirement_rollups`

One batch-level aggregate per requirement, updated atomically as logical assignments settle.

Core fields:

- batch, requirement/dataset keys and semantic digests;
- required/optional flag plus minimum/maximum cardinality and evidence policy;
- total, terminal, succeeded, not-applicable, and failed-terminal assignment counts;
- merged record/evidence/conflict counts;
- state: `pending | satisfied | gap_optional | gap_required | cancelled`;
- structured gap reason, result digest, and timestamps.

This row—not the outcome of any one candidate document—decides whether the requirement is satisfied and whether the batch may advance as trusted, review-only, or failed-required.

### 12.9 `extraction_template_envelope_assignments`

Join each work-order envelope or shard child to one logical assignment. Store its deterministic shard/range identity, provider-attempt result, evidence coverage, and merge state. Many shard rows may feed one logical assignment, but counters and Task Dataset settlement advance that logical assignment exactly once after every required shard succeeds and the deterministic merge validates.

A multi-requirement envelope rolls up child outcomes rather than pretending it has one requirement outcome:

- `succeeded` when every child logical assignment succeeded or has an allowed evidenced `not_applicable` result;
- `completed_with_failures` when one or more child assignments failed terminally; the requirement rollups—not this envelope—decide whether the batch has an optional or required gap;
- `superseded_by_children` when an oversized parent was atomically replaced by deterministic shard/split children.

The durable split operation is idempotent by parent order plus split-plan digest: it creates each child once, marks the parent `superseded_by_children`, adjusts envelope counters atomically, and prevents the parent from being retried as a provider call.

### 12.10 `extraction_template_coverage_receipts`

One cross-run row per stable Task Dataset scope × document snapshot × extraction contract. This is the authority used to skip duplicate Phase 2 calls; Task Dataset record presence alone is not.

Core fields:

- tenant, saved Task, silo, nullable project, Task Dataset Group, dataset definition, and stable dataset key;
- stable source-document identity plus source/content/canonical-Markdown hashes and canonicalizer version;
- requirement key, `extractionContractDigest`, and record-schema/identity/temporal/evidence-policy digests;
- state: `reserved | succeeded | not_applicable | failed | cancelled`;
- owning batch/logical-assignment ID, fencing epoch, reservation expiry, and latest accepted artifact/result digest;
- committed Task Dataset contribution/seal references and timestamps.

Only a compatible `succeeded` or explicitly evidenced and reusable `not_applicable` receipt is `covered`. A live `reserved` receipt produces `in_progress`; a competing run waits for/imports its terminal artifact rather than calling a provider. Expired ownership can be reclaimed with a higher fencing epoch. Failed, cancelled, partial, uncommitted, and unsealed receipts never suppress work.

#### 12.10.1 `extraction_template_coverage_waiters`

One durable dependency per waiting batch/logical assignment × authoritative coverage receipt. Core fields include the observed owner/epoch, `waiting | importable | reclaimable | resolved | cancelled` state, validated artifact/result digest, import receipt, expiry, exactly-once wake marker, and timestamps.

Reservation and waiter creation occur atomically when an accepted assignment is hardened. On owner success, dependents revalidate and import once. On failure/cancellation/expiry, at most one waiter reclaims with a higher epoch while the others remain fenced. A waiter-only batch defers without producing a work order or provider call and wakes exactly once when all dependencies resolve.

### 12.11 `extraction_template_report_snapshots`

One immutable Phase 3 output per Task item/input digest.

Core fields:

- run/item/template-version, `extractionContractDigest`, and `reportShapingDigest` identities;
- Task Dataset generation and terminal Phase 2 digest set;
- pinned base-publication watermark, staged overlay/removal digest, and immutable as-of Task Dataset view digest, including compatible carried-forward records;
- normalized report period;
- input and transformation digests;
- snapshot JSON or bounded object-storage pointer;
- included/excluded/conflict/gap counts;
- snapshot digest and timestamps.

Phase 4 output identity is the Phase 3 snapshot digest plus `presentationDigest` and renderer version.

### 12.12 High-level node changes

Plan version 2 should represent gates such as:

```text
manifest
inventory
discover         <- mandatory for uncovered retrieval-backed requirements
work_plan
extract          <- batch barrier, not a model loop
prepare_report
assemble
gap_check
render
```

Existing plan version 1 remains readable for legacy runs. A run pins one plan version for its full lifetime.

### 12.13 Required uniqueness and idempotency constraints

- one batch per Task run item × plan epoch × extraction cycle;
- one source-inventory row per batch × frozen source-snapshot/stable-document identity; identical bytes in two distinct source documents remain two candidates;
- one discovery attempt per batch × attempt number and no more than one active attempt;
- one document-query signal per batch × candidate × query;
- one candidate-assignment cell per batch × candidate × query × requirement;
- one reusable source-selection receipt per exact Task Dataset scope × stable source/fingerprint × requirement × source-selection/retrieval/planner identity;
- one work order per batch × envelope/shard digest;
- one logical assignment per batch × source-inventory row × requirement digest; content/Markdown fingerprints remain compatibility and digest inputs, not document identity;
- one requirement rollup per batch × requirement digest;
- one envelope-assignment row per work order × logical assignment × shard identity;
- one active cross-run coverage receipt/reservation per exact Task Dataset scope × stable source document × source/content/Markdown fingerprints × requirement × extraction-contract digest;
- one coverage waiter per waiting batch/logical assignment × authoritative coverage receipt;
- one staged source tombstone per target transaction × prior contribution/source snapshot × replacement digest;
- one report snapshot per Task item × report input digest;
- one Task Dataset contribution per logical-assignment digest × canonical record key × shard-merge version.

These are database constraints, not application-only checks. Conflict handling must return the existing authoritative row so retries and process restarts are idempotent.

---

## 13. Claim, heartbeat, settlement, and wake RPCs

Use the proven saved-Task job queue pattern:

- `FOR UPDATE SKIP LOCKED`;
- opaque lease token returned once and stored only as a hash;
- monotonic lease epoch;
- bounded lease duration;
- independent `available_at` retry time;
- structured settlement outcomes.

Required operations:

### 13.1 `claim_extraction_template_work_orders`

- rejects cancelled/terminal parent runs;
- considers only ready/running batches;
- orders by priority, availability, creation time, and tenant fairness;
- claims no more rows than granted slots;
- verifies dependency/barrier readiness;
- returns the immutable envelope and a lease token.

### 13.2 `heartbeat_extraction_template_work_orders`

- renews only the exact token/epoch set;
- reports parent cancellation;
- uses a roughly 90–120 second lease with a heartbeat near 30–45 seconds;
- does not touch group rollup rows on every heartbeat.

### 13.3 `settle_extraction_template_work_order`

- fences stale tokens/epochs;
- validates the parent is not cancelled;
- records structured timing/result/error state;
- updates counters atomically with database-side arithmetic;
- never reads all node statuses into application memory to recalculate totals;
- detects every terminal batch-barrier outcome;
- requeues or resolves the parent exactly once on terminal settlement, even when Phase 3 is not eligible;
- emits a worker wake signal.

### 13.4 `defer_extraction_task_run_job`

- changes the leased parent from running to waiting without failure;
- records the batch/wait reason;
- releases the lease;
- keeps the run and item nonterminal.

### 13.5 Targeted Task Dataset settlement

Add a server-owned operation that binds one requirement assignment to its exact dataset source snapshot and fingerprint. It must support idempotent replay and prevent a work-order row from saying succeeded while the source remains unsealed.

### 13.6 Deferred publication-lease custody

The current Task Dataset publication lease can expire while the parent job is yielded. Add a server-owned batch-coordinator claim/renew RPC rather than persisting the original one-time plaintext publication token:

1. a service-role coordinator claim verifies the active run/item/batch/transaction and rotates a monotonic coordinator epoch plus hashed one-time token;
2. the coordinator renew RPC accepts that batch token, fences older epochs, and renews the exact Task Dataset publication lease through Phase 4 and final commit;
3. another process may reclaim coordinator custody after expiry/restart and receive a new token without reading an old plaintext secret;
4. work-order claims pause if custody is lost or too near expiry;
5. recovery revalidates the pinned transaction/generation and all committed assignment digests before resuming; if a conflicting publication owner exists, fail closed and preserve audit artifacts.

The coordinator heartbeat is independent of work-order leases. Raw coordinator/publication tokens never appear in ordinary database rows, logs, webhooks, or inspection payloads.

---

## 14. State machines

### 14.1 Parent template Task item

```text
execution status: queued -> running -> succeeded | failed | cancelled

while status = running, phaseKey:
  planning_inventory
  -> discovering_sources
  -> planning_model
  -> validating_plan
  -> compile_source_data
  -> preparing_report_data
  -> filling_report
  -> rendering

reviewState: clear | needs_review
publishable: true | false
```

`waiting` is a saved Task queue-job state, not a Task-item execution status. The existing `processing_job_status` enum remains authoritative unless a separate migration changes every commit/RPC/API consumer. A successfully validated run may have `status = succeeded`, `reviewState = needs_review`, and `publishable = false`; this preserves Task Dataset commit semantics while preventing an untrusted document from being presented as final.

When a required requirement rollup remains `gap_required` after all eligible assignments settle, the item is `failed` and the in-progress Task Dataset generation is not published. One failed candidate does not fail the item when other assignments satisfy the aggregate contract. Validated logical-assignment artifacts remain durably auditable and may be imported into a later compatible rebuild by fingerprint/contract identity; they are never exposed as active Task Dataset records merely because a sibling succeeded.

### 14.2 Work batch

```text
created -> succeeded                                                   (zero uncovered work)
created -> prepared_nonclaimable                                      (all-in-scope-only work)
created -> discovering -> planning -> prepared_nonclaimable
               |              |                |-> waiting_on_coverage
               |              |                |-> activation_failed
               |              |                |-> ready -> running
               |              |                              |-> paused -> ready | running
               |              |                              |-> succeeded
               |              |                              |-> completed_with_gaps
               |              |                              |-> failed_required
               |              |                              |-> failed
               |              |-> planner_retry_wait -> planning
               |-> discovery_retry_wait -> discovering
               |-> failed
any nonterminal state -> cancelled
```

`prepared_nonclaimable` can reach `ready` only through the single fenced activation RPC after its milestone/rollout prerequisites pass. `waiting_on_coverage` contains durable waiter dependencies and no claimable provider order. `activation_failed` retains the structured failed predicate and requires a new compatible activation attempt/epoch rather than an application-side status edit. `paused` resumes to `ready` or `running` only after the operator/circuit-breaker condition clears. `discovery_retry_wait` and `planner_retry_wait` are durable batch states with `available_at` and a structured retry reason; resumption returns to the corresponding phase under the same input digest.

Discovery failure and planner failure are separate structured states. A transient retrieval failure retries the same digested discovery request; a permanent discovery failure prevents the planner call. A successful empty discovery proceeds to planning so required items can be recorded explicitly as unassigned.

### 14.3 Document work order

```text
prepared_nonclaimable -> pending -> leased -> running -> validating -> persisting -> succeeded
                                          |          |             |-> completed_with_failures
                                          |          |-> retry_wait -> pending
                                          |-> splitting -> superseded_by_children
any nonterminal state -> cancelled
```

Only activation can move an order from `prepared_nonclaimable` to `pending`. Lease expiry returns eligible work to `retry_wait` or `pending` under a new epoch. It never accepts a late result from the expired epoch.

### 14.4 Logical assignment and requirement rollup

```text
logical assignment:
  pending -> waiting_for_coverage -> importing -> succeeded | not_applicable
  pending -> running -> succeeded | not_applicable | failed_terminal | cancelled

requirement rollup:
  pending -> satisfied | gap_optional | gap_required | cancelled
```

Envelope and batch terminal states are deterministic rollups of these rows; models do not choose them.

---

## 15. Cancellation

Cancelling the parent Task must:

1. mark the Task run and active item cancelled;
2. abort and fence active discovery/planner attempts so a late matrix or plan cannot become authoritative;
3. change prepared, pending, retry-wait, and coverage-waiter work to cancelled;
4. fence running orders by incrementing or invalidating their lease epoch/token;
5. abort in-process provider calls through the existing cancellation signal;
6. release capacity slots;
7. prevent Task Dataset settlement after cancellation;
8. discard/unpublish the current Task Dataset transaction according to existing Task semantics;
9. prevent the final-child wake from requeueing the parent;
10. publish cancellation progress and webhook events.

Cancellation delivery is cross-process. Publish a run/batch cancellation notification that active workers subscribe to, and independently poll the cancellation epoch at least every 5 seconds while a provider call is in flight. The polling fallback is separate from the 30–45 second lease heartbeat, so a dropped notification still meets the abort target.

Targets:

- no new work-order claim more than 2 seconds after cancellation is observed;
- active provider calls receive abort within 10 seconds;
- late provider results cannot write data.

---

## 16. Progress, model status, ETA, and webhooks

Numeric progress comes from durable rows. Narrative model status is supplementary.

### 16.1 Task Run Queue display

Show:

- overall phase, such as `Phase 2 of 4 — compiling source data`;
- Phase 1 discovery state: queries completed/total, candidate documents, compatible assignments excluded, no-match query/requirement mappings, cache hits, and elapsed discovery time;
- coverage-ledger counts for reused, imported, waiting-on-concurrent, stale, failed-retryable, and newly planned mappings;
- documents completed/total;
- logical assignments completed/total;
- requirement rollups satisfied/pending/optional-gap/required-gap;
- model envelopes completed/total;
- pending, running, retrying, not-applicable, terminal-failed, and cancelled counts;
- active/granted/maximum slots;
- current source-document and dataset titles, assignment labels, and attempt numbers;
- elapsed time;
- ETA range and confidence;
- required gaps and paused/circuit-breaker state.

The current staged proof UI can be extended, but its numeric source of truth should become the work-batch/order rollup rather than in-process event arithmetic.

### 16.2 Model status

Persist at most the latest status per work order/task key in the existing bounded status structure. Emit server-owned status transitions even when the model does not call `model_status`.

Fence every status update with server-attached `workOrderId`, current `leaseEpoch`, and monotonic `statusSeq`; the model supplies only bounded status content. Reject an expired epoch or non-increasing sequence so a late retry cannot overwrite the current attempt. In the same transaction that accepts a status, write an outbox event with stable `eventId`, then deliver the webhook at least once. Consumers deduplicate by `eventId`.

Suggested statuses:

- queued for extraction;
- loading and validating source;
- sending document to model;
- extracting `Grant and Funding Updates` from `Budget FY2026`;
- validating 42 returned records;
- persisting Task Dataset records;
- retrying after provider timeout;
- completed.

Do not require frequent model tool calls. They increase turns and undermine the single-envelope goal.

### 16.3 ETA

Track duration by:

- discovery query count, unique backend-search count, retrieval mode/fallback, candidate inventory size, and cache-hit ratio;
- planner provider/model and matrix/input-size band;
- provider/model/route;
- document token-size band;
- number and expected cardinality of assignments;
- full document versus shard;
- retry state.

Before completions, use historical medians/p90. During a run, blend toward observed throughput.

```text
phase1 remaining =
  estimated remaining keyed searches / observed retrieval throughput
  + historical planner duration when planning is still pending

phase2 remaining =
  weighted pending/running work / observed effective throughput

overall remaining =
  Phase 1 remaining, when not complete
  + Phase 2 remaining, when not complete
  + historical/observed Phase 3 duration, when pending
  + historical/observed Phase 4 duration, when pending
```

Display a range rather than false precision. At six minutes per envelope:

- 15 envelopes at 15 slots are roughly one six-minute wave;
- 30 envelopes are roughly two waves;
- 40 envelopes are roughly three waves before downstream work.

### 16.4 Webhooks

Extend Task status/webhook payloads with:

- pipeline version and phase;
- batch ID;
- discovery state, queries completed/total, candidate/no-match-mapping/excluded counts, cache hits, latency, and bounded failure reason;
- document, assignment, requirement-rollup, envelope, and coverage-ledger counts, including reused/imported/concurrent-wait mappings;
- bounded current source-document/dataset titles and assignment keys, never full Markdown or stored record payloads;
- slot utilization and queue wait;
- retry and terminal-failure counts;
- latest bounded model/server statuses;
- ETA range/confidence;
- required gaps;
- cancellation state.

Existing model-status webhooks remain active. Server-owned transitions should fire the same update channel so providers without a model-status tool still show progress.

At minimum publish `template_discovery_started`, `template_discovery_progress`, `template_discovery_completed`, and `template_discovery_failed`. High-frequency server-derived numeric progress may follow the existing bounded/coalesced webhook policy. Every accepted explicit model-status update and every state transition creates its own outbox event and is delivered at least once; neither is silently coalesced away.

---

## 17. Template-ingestion additions

DOCX package parsing and the multi-pass ingestion structure remain valid. The needed work is to make the compiled manifest strong enough that execution is cheap and deterministic.

### 17.1 Manifest version 2 additions

Each persistent data requirement should include:

- stable requirement key and semantic digest;
- stable `datasetKey`, human-readable `datasetTitle`, and dataset description;
- references into a global stable named source-query registry;
- requirement-to-query and query-to-segment mappings;
- exact extraction question or bounded instruction;
- versioned `json_records` output contract, record schema, and field descriptions;
- record-title policy: preferably a deterministic expression over validated fields, with bounded semantic fallback only when necessary;
- record identity/deduplication policy;
- expected cardinality and maximum records;
- required versus optional classification;
- evidence requirements;
- `static | period_scoped | run_supplied`;
- normalized temporal JSON paths and raw-label fields;
- no-date behavior;
- conflict policy;
- source-selection hints and direct-all-in-scope flags;
- explicit `relevance_ranked | all_in_scope | none` `selectionPolicy`;
- explicit `new_or_changed_sources | minimum_sufficient` `refreshPolicy`, defaulting to `new_or_changed_sources`;
- safe compatibility/grouping hints for document envelopes;
- report-shaping rules: data normalization, temporal filtering, conflict handling, sorting, aggregation, and fact-level detail-to-summary dependencies;
- presentation rules: direct report-binding mappings, visual/style formatting, narrative prompt/length contract, and presentation dependency layers;
- optional/empty-section behavior;
- estimated output size;
- deterministic context-splitting hints.

Manifest version 2 defines one global, deduplicated source-query registry capped at 60 query entries for the template version. A query entry may map to several requirements; coverage remains requirement-specific. Source-query keys must be stable so discovery, planner selection, and provenance refer to immutable ingestion-authored identities. The planner does not rewrite worker extraction instructions.

Every requirement other than `run_supplied` must reference at least one stable source-query key when `selectionPolicy = relevance_ranked`. `selectionPolicy = none` is valid only for deterministic/run-derived requirements whose input policy can be validated without document search; `selectionPolicy = all_in_scope` creates direct server-owned assignments and needs no ranking query.

Preserve the existing stable `TemplateSearchPlanEntry.searchId` when compiling `TemplatePersistentDataSourceQuery`; do not drop that identity and later key deferred work from mutable query text.

Legacy validation currently permits up to 60 source queries per requirement, not 60 globally. Re-ingestion must deduplicate those into the version-2 registry. If more than 60 semantically distinct queries remain, mark the template `needs_review` and require consolidation or an explicitly versioned higher bound; never truncate the legacy set silently or fabricate mappings through defaults.

Keep four independent digests so a minor presentation edit does not invalidate expensive source work:

| Digest                     | Covers                                                                                                                                                          | Invalidates                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `sourceSelectionDigest`    | query keys/text, synonyms, selection/refresh policy, direct-all-in-scope flags                                                                                  | discovery cache and planner source selection |
| `extractionContractDigest` | exact extraction query, requirement semantics, schema/output contract, identity, cardinality, semantic record-title rules, evidence, temporal extraction policy | document × requirement extraction coverage   |
| `reportShapingDigest`      | date filtering, conflict, sort, aggregate, dependencies                                                                                                         | Phase 3 snapshot only                        |
| `presentationDigest`       | field/collection bindings, formatting, layout instructions                                                                                                      | Phase 4 fill/render only                     |

The manifest digest remains the umbrella identity, but runtime invalidation uses the narrowest affected digest. A layout-only edit or display-only `datasetTitle`/description rename must not rescore documents or re-extract facts. A deterministic record-title expression that can be recomputed from unchanged fields is dataset-projection metadata; a rule that asks the model to infer new semantics belongs in `extractionContractDigest`.

### 17.2 Preparation during ingestion

Move expensive interpretation to ingestion:

1. compile comments, placeholders, collections, and scope;
2. identify data requirements, stable dataset keys/titles/descriptions, reusable record schemas, and record-title rules;
3. classify time variance and exact temporal fields;
4. generate and deduplicate source-query keys;
5. determine which requirements can share one document envelope;
6. define evidence, identity, output-contract, and refresh policy;
7. compile direct bindings and aggregation rules;
8. identify narrative-only bindings;
9. build dependency order so detail data precedes summaries;
10. run static query lint, token/cardinality budgeting, deduplication, dependency, and work-order-shape simulation without assigning corpus-specific rank.

The portable ingestion simulation should identify queries that are too broad, duplicates after normalization, candidate-budget math that cannot protect the configured depth, and all-in-scope requirements likely to exceed limits. It cannot know actual document rank against a future silo. After a Template Group is assigned to a silo, an optional silo-scoped validation run may execute discovery against that current corpus and report likely starvation or low recall as a separate, versioned validation artifact. That artifact never changes the portable manifest or embeds one tenant's score distribution into the template.

Do not calibrate a template's retrieval score against one tenant corpus at global template-ingestion time. If calibration is useful, store query semantics in the template and calculate corpus-specific ranks/thresholds during Phase 1 for the actual silo.

### 17.3 New authoring review findings

The authoring report should flag:

- a requirement with no usable source query;
- two distinct requirement contracts targeting the same `datasetKey`;
- duplicate or conflicting query instructions;
- ambiguous date behavior;
- a period-scoped schema without filterable temporal fields;
- missing evidence expectations;
- an unbounded high-cardinality collection;
- incompatible requirements marked as groupable;
- a requirement that cannot reach any report binding;
- a narrative section without prepared data dependencies;
- a summary scheduled before its detail data;
- missing required/optional classification;
- a direct calculation that is left to a model unnecessarily;
- a collection whose identity policy cannot deduplicate retries;
- a missing/ambiguous dataset title or two requirements reusing a title while targeting different schemas without clear descriptions;
- a deterministic record-title rule that references a missing/non-scalar field, or an unnecessary semantic-title rule where a field expression would suffice;
- a `minimum_sufficient` refresh policy without a testable satisfaction contract.

Where possible, an implemented recommendation creates a new immutable DOCX/template version and a new manifest digest, consistent with the existing ingestion-version model.

---

## 18. Accuracy and provenance controls

Accuracy is maintained by reducing model discretion, not by using longer reasoning everywhere.

### 18.1 Source assignment

- planner chooses only from server-provided candidates;
- every planner-selected document/query/requirement triple resolves to an exact persisted `matched` assignment-state cell;
- server ensures required requirements are assigned, already covered, or explicitly unmatched;
- query/document score and anchor plus requirement-specific eligible rank, percentile, observation state, and retrieval/fallback mode are retained for audit;
- source scope is frozen;
- planner output is sampled against a deterministic baseline during rollout.
- candidate recall, planner selection yield, downstream evidenced relevance, and `not_applicable` false-positive rate are measured independently.

### 18.2 Extraction

- exact document and contract are server-bound;
- full Markdown is supplied or explicitly sharded;
- source text is untrusted;
- final output is schema-validated;
- evidence anchors are mandatory;
- numeric/date values receive deterministic validation;
- empty results need a reason;
- invalid placeholder values are rejected;
- record identity is deterministic.

### 18.3 Report preparation

- date filtering and calculations are code-owned;
- conflicts remain visible;
- included/excluded counts are stored;
- run input is labelled separately from source evidence;
- source-register rows derive from record provenance.

### 18.4 Filling

- simple bindings are deterministic;
- synthesis sees only prepared data;
- dependency order is compiled at ingestion;
- one bounded completeness check replaces open-ended repair loops;
- deterministic DOCX output is inspected before publication.

---

## 19. Security and tenancy

- `rankDocumentsForQuerySet()` enforces tenant, silo, project, and frozen source scope itself; authorization cannot rely solely on its caller;
- the Phase 1 request is compiled from the pinned manifest and server context, never from model-supplied dataset/source-batch identifiers;
- every candidate is validated against tenant, silo, project, and frozen source scope;
- a worker loads source content only by an assigned snapshot identity;
- document deletion uses `ON DELETE SET NULL` for the live reference and retains audit snapshots;
- source text and planner notes are data, never system instructions;
- providers receive only the one assigned document and required contracts;
- claim tokens are hashed at rest and scoped to one epoch;
- service-role RPCs independently verify run, item, batch, and source relationships;
- late, cancelled, or cross-tenant settlements fail closed;
- result payloads follow existing retention and size limits.
- anchor excerpts and source metadata are untrusted data, response-size bounded, and omitted from logs unless the caller has source-inspection permission;
- metrics store query digests/keys by default; full query text is available only in scoped audit data with normal retention controls.

---

## 20. Provider and route compatibility

Document discovery is a server retrieval operation, not a model/provider route. It must produce the same contract regardless of which provider is configured for the planner or Phase 2 extraction.

The deferred executor should call the same provider abstraction used by current model execution, including native tool/structured-output support where available.

Configuration for `template_work_order` should include:

- provider;
- model;
- reasoning effort when supported;
- parallel calls;
- safe input/output token limits;
- request timeout;
- maximum attempts;
- route priority/weight;
- failover route;
- native structured-output capability;
- optional model-status capability.

The accepted batch must snapshot this route configuration. Editing Swarm Configuration during a run affects only later batches; retries within an accepted batch use its pinned timeout/failover policy unless an operator explicitly restarts it.

For providers without structured-output enforcement:

- request JSON with the same schema;
- parse strictly;
- allow one bounded corrective retry;
- do not accept prose wrapped around invalid output.

Do not require a provider-specific feature for correctness. Native support improves latency and schema adherence; the server validator remains authoritative.

---

## 21. Observability

Record:

- discovery request/result/configuration/index digests and cache identity;
- query count, unique normalized backend searches, cache hits, covered-assignment exclusions, and direct-all-in-scope inclusions;
- candidate documents/chunks scored, union size, document-query signal cells, query/requirement assignment-state cells, response bytes, truncation, and retrieval/fallback mode per query;
- per-mapping no-match and eligible-rank/percentile distribution, per-query score distribution, discovery latency, retry reason, and partial-backend failures;
- planner candidate-selection yield and downstream evidenced-relevance/`not_applicable` rate by query key;
- planner latency, tokens, response digest, repair count, and validation rejections;
- frozen, covered, excluded, and planned documents;
- logical assignments and dispatch envelopes;
- queue wait, slot request/grant/utilization, route, and attempt;
- Markdown characters/tokens and shard count;
- provider latency and finish reason;
- returned record/evidence counts;
- schema failures and empty results;
- retries by structured reason and route;
- idempotent replays and dedupe conflicts;
- Task Dataset commit/seal latency;
- Phase 3 filter window and inclusion/exclusion counts;
- bindings filled, omitted, conflicted, and required-missing;
- render duration and file result;
- predicted ETA versus actual duration.

Alerts:

- discovery p95 above its measured SLO or permanent discovery failure;
- source-selection gold-corpus candidate recall below 98%;
- response truncation or matrix-limit rejection above the rollout threshold;
- no completion for twice the route p95;
- schema-invalid rate above 2%;
- terminal failure rate above 0.5%;
- any uncovered required binding at the Phase 3 or 4 gate;
- active calls below 70% of grantable capacity for the configured minimum duration while eligible work is queued;
- a parent waiting after its barrier is complete;
- work-order/Task Dataset state mismatch.

Rate alerts are evaluated per provider/model/route and document-token/cardinality band over both a rolling time window and a minimum sample count. Initial defaults: schema-invalid requires at least 50 attempts in 15 minutes; terminal-failure rate requires at least 200 attempts in 60 minutes. “Twice route p95” uses the matching route/size/cardinality band, not a global mixed-document p95. Canary failures use their explicit small-sample rule rather than these production percentages.

---

## 22. API and UI changes

### 22.1 Task run response

Add a `templateExecution` section:

```json
{
  "pipelineVersion": 2,
  "executionStatus": "running",
  "batchState": "running",
  "reviewState": "clear",
  "publishable": false,
  "phase": 2,
  "phaseKey": "compile_source_data",
  "batchId": "uuid",
  "discovery": {
    "state": "succeeded",
    "queries": { "complete": 12, "total": 12 },
    "mappings": { "noMatch": 1, "total": 14 },
    "candidateDocuments": 18,
    "excludedCompatibleAssignments": 7,
    "cacheHits": 8,
    "latencyMs": 2380,
    "requestDigest": "sha256",
    "resultDigest": "sha256"
  },
  "documents": { "terminal": 6, "successful": 5, "total": 8 },
  "assignments": {
    "terminal": 14,
    "successful": 13,
    "notApplicable": 1,
    "failedTerminal": 0,
    "total": 19
  },
  "requirements": {
    "satisfied": 5,
    "gapOptional": 0,
    "gapRequired": 0,
    "pending": 1,
    "total": 6
  },
  "envelopes": {
    "pending": 1,
    "running": 1,
    "validating": 0,
    "persisting": 0,
    "retrying": 0,
    "succeeded": 6,
    "completedWithFailures": 0,
    "supersededByChildren": 0,
    "cancelled": 0
  },
  "slots": {
    "capacityKind": "template_work_order",
    "activeForBatch": 1,
    "grantedToBatch": 2,
    "activeGlobal": 6,
    "maximumGlobal": 15
  },
  "latestStatuses": [
    {
      "taskKey": "doc_014",
      "source": "server",
      "message": "Extracting grant records",
      "updatedAt": "2026-09-02T14:32:10Z"
    }
  ],
  "eta": {
    "lowMs": 180000,
    "highMs": 420000,
    "confidence": "medium"
  },
  "requiredGaps": []
}
```

`terminal` includes success, evidenced not-applicable, terminal failure, and cancellation; `successful` includes only results eligible to feed the Task Dataset. Requirement rollups separately identify optional versus required gaps. Document terminal/success counts are rollups over their logical assignments, not raw shard rows. Envelope counters are mutually exclusive current states. Slot maximum is global for the capacity kind, while active/granted counts explicitly identify batch versus global scope. These definitions are shared unchanged by API responses, the Task Run Queue, webhooks, and telemetry.

### 22.2 Inspection endpoints

API users and admins with Task access should be able to:

- list work batches for a run/item;
- inspect a bounded discovery summary and its request/result/configuration/index digests;
- inspect candidate versus selected documents with per-query/requirement state, rank, score, coverage exclusion, retrieval mode, and anchor IDs/page/ranges;
- list document orders and requirement assignments;
- inspect bounded planner decisions and validation warnings;
- inspect retry/error/provenance summaries;
- create an audited replacement attempt for exact failed assignments using an idempotency key, without resetting or rewriting successful siblings;
- cancel the parent run;
- request a full rebuild through existing Task semantics.

The API must not expose lease tokens, internal provider credentials, or unrestricted source text. Anchor excerpts/snippets require the separate source-inspection permission; ordinary Task access returns only bounded IDs, page numbers, and ranges.

### 22.3 Task Run Queue

Extend the existing staged proof display rather than create an unrelated panel. Show the four-phase timeline, authoritative counts, latest statuses, ETA, and expandable per-document details.

During Phase 1, show `Discovering sources` separately from `Planning work`. The expandable view should distinguish `matched`, `unobserved`, and `covered`, and it must explain that an unobserved cell is not proof of absence.

---

## 23. Gated phased delivery plan

The delivery milestones in this section are deliberately different from runtime Phases 1–4. A milestone is a code-and-schema delivery boundary; a runtime phase is one step of an executed template Task. Milestones are cumulative and may merge independently, but no milestone may activate behavior owned by a later milestone.

> **Central implementation invariant:** No Phase 2 provider request may occur until immutable source artifacts, exact Task Dataset destinations, coverage ownership, accepted discovery/planning, deferred orchestration, cancellation fencing, publication custody, worker-version compatibility, route preflight, downstream data/render consumers, and observable progress controls have all passed their gates.

### 23.0 Current delivery position

| Item                  | Current value                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Active milestone      | M10 implementation candidate — live allowlisted routing, comparison, publication, and soak gates remain open                           |
| M0 gate               | Closed on 2026-09-02 by the versioned contract module, frozen fixture catalog, v1 baseline, and machine-readable milestone proof       |
| M1 gate               | Closed on 2026-09-02 by fail-closed Manifest-v2 compilation, immutable assessment persistence, inspection, and milestone evidence      |
| M2 gate               | Closed on 2026-09-03 by verified immutable source artifacts, exact destination/route foundations, preflight, and milestone evidence    |
| M3 gate               | Closed on 2026-09-03 by exact coverage/reuse semantics, fenced waiters/import/removal, and live PostgreSQL/PostgREST evidence          |
| M4 gate               | Closed on 2026-09-03 by bounded discovery/planning, live database/API tests, and a passing configured-provider quality probe           |
| M5 gate               | Closed on 2026-09-03 by durable recovery, synthetic queue/custody/cancellation, restart, waiter, and exactly-once wake evidence        |
| M6 gate               | Closed on 2026-09-03 by deterministic snapshot/DOCX fixtures, synthetic receipt persistence, backup/restore, and restart evidence      |
| M7 gate               | Closed on 2026-09-03 by bounded database-derived progress, durable webhooks, cancellation/rebuild, and live inactive-control evidence  |
| M8 gate               | Closed on 2026-09-03 by the isolated quarantined executor, strict result validation, cancellation fencing, and live inactive controls  |
| M9 gate               | Closed on 2026-09-03 by the fenced activation/claim lane, disposable real-claim canary, deployed reconciliation, and inactive controls |
| Required rollout mode | `disabled`                                                                                                                             |
| Allowed v2 work       | An explicitly configured Town Manager/test-silo canary followed by recorded 1→3→15 evidence; saved-Task route integration is complete  |
| Prohibited v2 work    | Unallowlisted routing, publication before its independent gate, expansion without thresholds, and default `enabled` before soak        |

Advance this row only in the same reviewed change that records the preceding milestone's exit evidence. A code merge by itself does not advance the rollout mode.

### 23.1 Fail-closed sequencing rules

1. Keep the existing staged-v1 path authoritative through Milestone M8.
2. Pin `pipelineVersion`, contract versions, and execution mode when a run starts. Never switch an in-flight run between v1 and v2.
3. Persist planner output and work-order candidates as `prepared_nonclaimable`. Creating a row must never make it executable.
4. Exercise queue, barrier, retry, cancellation, and publication behavior with synthetic workers before adding a provider executor.
5. Build Phase 3 snapshot preparation and Phase 4 rendering against synthetic validated Task Dataset records before the real Phase 2 producer.
6. Implement the real Phase 2 executor only as an isolated, quarantined harness at first. Add its polling/claim lane in a later milestone.
7. Require each milestone's automated exit gate and recorded review evidence before beginning behavior from the next milestone.
8. Fail closed when schema head, activation epoch, worker-supported versions, provider route, or platform readiness is incompatible.

### 23.2 Pipeline route and rollout state

Execution route and rollout state are separate from ordinary job status.

The saved Task/run route is one of:

- `staged_v1`: the current staged template executor;
- `deferred_v2`: this new work-order pipeline;
- `legacy_fallback`: the existing emergency legacy path, chosen only when a new run starts.

Use one server rollout mode, not unrelated per-node feature flags:

```text
disabled -> plan_shadow -> orders_shadow -> executor_shadow -> canary -> enabled
```

| Rollout mode      | Allowed behavior                                                                                    | Forbidden behavior                                             |
| ----------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `disabled`        | Manifest/schema development and offline fixtures                                                    | v2 discovery, planning, orders, provider calls, or publication |
| `plan_shadow`     | Read-only discovery and planner comparison; persist shadow artifacts                                | claimable orders, Task Dataset mutation, or v2 publication     |
| `orders_shadow`   | Nonclaimable orders plus synthetic worker/control-plane tests                                       | real Phase 2 provider calls or v2 publication                  |
| `executor_shadow` | Explicit test/admin invocation and quarantined provider results                                     | normal worker polling or v2 publication                        |
| `canary`          | Allowlisted new runs, bounded worker claims, optional publication after the canary publication gate | unallowlisted v2 runs or automatic default routing             |
| `enabled`         | Eligible Manifest-v2 templates use v2 by default                                                    | mid-run fallback to v1                                         |

Retain two emergency controls: `v2_worker_claims_enabled` and `v2_publication_enabled`. The first stops new claims and fences/cancels active calls under policy; the second prevents a completed shadow/canary transaction from becoming active. A changing global mode affects new runs, except that the emergency claim/publication controls may stop unsafe work. Every batch pins the accepted activation epoch, and every worker advertises supported pipeline/envelope/result versions.

### 23.3 Milestone and gate matrix

| Milestone | Outcome                                                                                | Hard exit gate                                                                             | Highest rollout mode     |
| --------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------ |
| M0        | Contracts, routing, storage decisions, fixtures, and rollback are frozen               | All schemas validate fixtures; specification is committed; v1 baseline is recorded         | `disabled`               |
| M1        | Ingestion emits an eligible immutable Manifest v2                                      | Incomplete/legacy manifests cannot route to v2; four digests are deterministic             | `disabled`               |
| M2        | Immutable source/destination and provider-route foundation exists                      | Immutability, scope, purge, reconciliation, and preflight tests pass                       | `disabled`               |
| M3        | Coverage, source-selection reuse, concurrency waiters, and tombstones are correct      | Changed sources re-enter; compatible work skips; concurrent duplicate calls are impossible | `disabled`               |
| M4        | Frozen document discovery and the data-blind planner work in shadow                    | Recall/allowlist/plan-validation gates pass; no work is claimable                          | `plan_shadow`            |
| M5        | Durable deferred control plane works with synthetic children                           | Restart, lease, custody, retry, cancel, waiter, outbox, and exactly-once wake tests pass   | `orders_shadow`          |
| M6        | Phase 3 and Phase 4 consume synthetic validated data end to end                        | Snapshot and DOCX fixtures are deterministic across restart/date changes                   | `orders_shadow`          |
| M7        | Status, API, webhook, UI, cancellation, and operational controls are proven            | Counts equal database truth; operators can inspect/cancel synthetic work                   | `orders_shadow`          |
| M8        | Direct Phase 2 execution works only in an isolated quarantined harness                 | Envelope/result/evidence/shard/provider/idempotency/quality tests pass                     | `executor_shadow`        |
| M9        | The fail-closed activation RPC and worker claim lane are enabled for internal canaries | Every prior gate plus capacity, old-worker rejection, and kill-switch drills pass          | internal `canary`        |
| M10       | Allowlisted production canary expands toward default                                   | Accuracy, latency, cost, duplicate-work, render, and soak thresholds pass                  | `canary`, then `enabled` |

### 23.4 Milestone details

#### M0 — Freeze contracts and preserve the baseline

Complete before implementation changes runtime behavior:

- freeze Manifest v2, planner-input/output, Phase 2 envelope/result, evidence-locator, report-snapshot, pipeline, worker, and webhook schema versions;
- define the full-document result union (`records | not_applicable`) and shard result union (`records | no_records_in_range`), including merge and overlap deduplication rules;
- define canonical identity, cardinality, temporal, evidence, title, conflict, refresh, source-selection, optional-query-failure, removal, and replacement policy schemas;
- reserve `selectionPolicy` for `relevance_ranked | all_in_scope | none` and `refreshPolicy` for `new_or_changed_sources | minimum_sufficient`, avoiding the existing `sourcePolicy` name and overloaded `exhaustive` value;
- define source-selection receipt identity separately from factual extraction coverage;
- define coverage-reservation conflicts, durable waiters, import/reclaim behavior, and exactly-once wake;
- define `sourceScopeRevision` as the frozen silo/project corpus revision, separate from Task Dataset generation;
- decide immutable Markdown/page-map storage, tenant-scoped dedupe, compression/size limits, retention pins, garbage collection, and explicit document/Task/tenant purge behavior;
- decide whether large validated results are inline or content-addressed, and choose the first-class nullable `record_title` projection or an exact equivalent;
- define dataset-definition reconciliation: create missing compatible definitions, accept metadata-only title changes, and fail closed on an incompatible existing `datasetKey`;
- pin the `staged_v1 | deferred_v2 | legacy_fallback` routing contract, disabled rollout mode, worker-version compatibility, and forward-only rollback procedure;
- label the source-selection, extraction/evidence, temporal, binding, layout, and performance gold fixtures, beginning with the Town Manager template and Smyrna sample corpus;
- record the current v1 behavior and performance so later shadow comparisons have a fixed baseline;
- commit the accepted specification before starting M1.

**M0 exit gate:** no correctness-critical placeholder or competing enum remains; all JSON schemas parse representative positive and negative fixtures; v2 is `disabled`; the existing path's tests and baseline fixtures pass unchanged.

##### M0 frozen decision record

The executable source of truth is `packages/rag-core/src/template-work-order-contracts.ts`. M0 freezes pipeline version 2 and version 1 of the discovery, planner input/result, extraction envelope/result, evidence locator, shard plan, report snapshot, progress, webhook, and worker protocols. The route enum is `staged_v1 | deferred_v2 | legacy_fallback`; the rollout enum and fail-closed default are exactly those in Section 23.2. The default is `disabled` with worker claims and publication both false. Every new work order begins `prepared_nonclaimable`.

The following storage and lifecycle choices are closed:

- use one private `task-artifacts` bucket with tenant-scoped, content-addressed create-only objects;
- hash the uncompressed canonical bytes with SHA-256, store canonical Markdown and JSON page maps as gzip, and verify the digest on every read;
- use `tenants/{tenantId}/canonical-markdown/{sha256}.md.gz`, `tenants/{tenantId}/page-maps/{sha256}.json.gz`, and `tenants/{tenantId}/template-work-results/{sha256}.json.gz` object keys;
- cap uncompressed Markdown at 64 MiB, page maps at 8 MiB, and validated results at 32 MiB; a document that cannot fit a safe provider context uses deterministic shards, while an oversized validated result fails explicitly;
- keep validated results inline through 1 MiB and use a content-addressed result object above that limit;
- retain referenced artifacts while a live document, run, coverage receipt, or audit pin needs them; retain terminal audit pins for at least 90 days and garbage-collect unreferenced objects only after a 30-day grace period;
- document/Task deletion stages tombstones and releases only its pins after audit retention; it cannot delete a tenant-local object still referenced elsewhere. Tenant purge fences work, cascades metadata, and hard-deletes its complete object prefix;
- add a first-class nullable `record_title varchar(200)` projection to contribution, checkpoint, and record persistence in the applicable schema milestone. A record title is display/search metadata and never identity.

Dataset-definition reconciliation is also fixed. A missing definition is created from the accepted manifest. A title/description-only change updates display metadata without invalidating extraction coverage. An existing `datasetKey` whose schema, identity, extraction, temporal, evidence, cardinality, or semantic-title contract is incompatible fails closed with `dataset_definition_conflict`; the model cannot redirect or recreate it.

Source-selection receipts and factual coverage receipts are separate identities. Selection reuse pins the exact source fingerprint, `sourceSelectionDigest`, retrieval/index/configuration digests, candidate-matrix digest, planner contract, and frozen `sourceScopeRevision`. Coverage reuse additionally pins the exact Task/silo/nullable-project/group/dataset destination, immutable Markdown/page-map/canonicalizer identities, and `extractionContractDigest`. A waiter references one authoritative receipt and owner epoch; success permits one validated import, while failure/cancellation/expiry permits one higher-epoch reclaim and exactly one barrier wake. `sourceScopeRevision` is the frozen silo/project corpus revision, never Task Dataset generation.

Full-document results are strictly `records` with at least one evidenced record or evidenced `not_applicable`; shard results are strictly `records` with at least one evidenced record or `no_records_in_range`. Shards cannot assert whole-document absence. Merge derives the manifest identity, deduplicates identical payloads while unioning evidence, preserves differing payloads as conflicts, and seals only after every deterministic range is terminal.

The fixture catalog is `docs/Templates/fixtures/work-order-v2/gold-fixture-catalog.json`; the fixed staged-v1 regression baseline is `docs/Templates/fixtures/work-order-v2/v1-baseline.json`; and the representative positive/negative wire fixtures are enforced by `packages/rag-core/src/template-work-order-contracts.test.ts`. Rollback is forward-only: stop shadow processing/claims/publication and route only new runs back to staged v1. Never downgrade the exact-head database or mutate an in-flight run's pinned version.

#### M1 — Manifest v2 and ingestion eligibility

- extend `packages/rag-core/src/template-persistent-data.ts` with stable requirement/query/dataset keys and every frozen M0 policy;
- compile `sourceSelectionDigest`, `extractionContractDigest`, `reportShapingDigest`, and `presentationDigest` with canonical ownership boundaries;
- update the multi-pass template-ingestion models, validation, authoring findings, inspection export, and re-ingestion versioning;
- preserve old template/DOCX/manifest versions immutably;
- allow legacy manifests to remain inspectable, but never synthesize missing semantics or mark them v2-eligible;
- expose one explicit `manifestV2Eligible` decision with structured reasons.

**M1 exit gate:** a template can become v2-eligible only when every extraction query, data format, title, evidence, identity, temporal, selection/refresh, conflict, cardinality, and binding contract validates. Repeated ingestion produces identical narrow digests. No runtime route can execute v2 yet.

##### M1 implementation record

Template ingestion now emits a separate model-authored Manifest-v2 draft and retains the existing version-1 persistent-data plan for the staged runtime. The server resolves query text and ownership only from deterministic `searchId` values, validates every frozen policy and exact template/schema binding, canonicalizes set-like semantics, and signs the four narrow digests plus the umbrella manifest digest. Missing or malformed v2 semantics produce a bounded structured ineligibility decision; they neither abort the legacy ingestion result nor become executable.

The additive `template_manifest_v2_assessments` and `template_manifest_v2_assessment_revisions` tables store immutable, idempotent assessment revisions through one scoped RPC. That RPC cannot mutate the staged-v1 manifest, active template version, rollout setting, or runtime route. The catalog and inspection ZIP expose the v1 manifest, v2 draft, validated v2 manifest, eligibility reasons, and persisted digest metadata. A normal retry resumes its existing version; a full redo copies the preserved source bytes to a new create-only path and creates a lineage-linked child version.

The machine-readable proof is `docs/Templates/fixtures/work-order-v2/m1-milestone-proof.json`. Its gate records deterministic compiler tests, malformed/legacy/binding rejection, persistence isolation, immutable redo behavior, the inspection surface, repository checks, and disposable PostgreSQL acceptance. Rollout remains `disabled`, the staged-v1 runtime remains authoritative, and no v2 discovery, order, provider, or publication path exists.

#### M2 — Immutable source, destination, route, and version foundation

- add content-addressed immutable canonical-Markdown and page-map artifacts using the M0 lifecycle decision;
- freeze artifact pointers and digests before accepting a source-inventory snapshot;
- pin the exact tenant/saved-Task/silo/nullable-project/Task-Dataset-Group/dataset-definition destination and reconcile Manifest-v2 definitions at run start;
- add pipeline/envelope/result/worker versions and the run-pinned route/mode/activation epoch;
- extend configured work-order routes with context/output budgets, timeout, maximum attempts, priority/weight, structured-output/status capabilities, failover, and dedicated template-work-order eligibility;
- implement route preflight without making a provider call: prove the full envelope fits one route or produce an explicit deterministic shard plan;
- add migration-head, checksum, generated ownership, release-contract, retention, and purge tests.

**M2 exit gate:** an accepted source always reloads by immutable pointer and verifies its digest; a model cannot redirect the Task Dataset destination; incompatible definitions fail closed; at least one route or deterministic shard plan passes preflight; old workers cannot accept unknown versions. V2 remains disabled.

##### M2 implementation record

Every supported ingestion path now prepares canonical Markdown plus a complete page map, compresses both without blocking the worker event loop, uploads them create-only under tenant-scoped content addresses, reads them back, enforces compressed/decompressed limits, and verifies exact bytes and SHA-256 before registering and audit-pinning them. Poppler, Mistral OCR, direct-vision PDF, image, text, spreadsheet, and DOCX ingestion all retain verified artifact identifiers in job progress. Invalid Unicode, unsafe page boundaries, cross-document substitution, source-title/file-digest mismatch, and reused tombstoned pins fail closed. Central deletion hooks cover direct document deletion, silo cascades, Task deletion/purge, and run deletion. Expired tombstoned pins release through a bounded RPC; tenant deletion is fenced behind exact-prefix preparation, elapsed retention, and verified empty storage. Staged-v1 ingestion remains authoritative if this inactive v2 foundation is unavailable.

The additive foundation migration creates immutable artifact metadata and lifecycle pins, exact source snapshots, Manifest-v2 dataset-definition reconciliation, immutable provider-route snapshots, bound route-preflight receipts, and `prepared_nonclaimable` run foundations. The foundation pins the tenant, saved Task, run/item, silo, nullable project, Task Dataset Group, run transaction, exact dataset-definition IDs, eligible manifest revision, pipeline/worker contract versions, route configuration, rollout mode, and activation epoch. Compatible pre-existing definitions may be adopted, metadata-only title/description changes do not invalidate extraction compatibility, and incompatible definitions or incomplete reconciliation fail closed. Direct writes are rejected. Shared-owner purge proof now covers tombstone/release ordering, 30-day artifact and 90-day audit retention, exact storage-path/content-digest deletion acknowledgement, idempotent finalization, and permanent rejection of a finalized content address.

Swarm configuration now exposes dedicated template-work-order eligibility, context/input/output budgets, timeout, attempt limit, priority/weight, pinned failover, structured-output mode, and model-status capability while preserving legacy five-field routes as ineligible. Provider-neutral preflight binds the exact envelope, page map, route configuration, estimator options, and shard settings; uses a conservative UTF-8 byte upper bound; proves the full request across the complete failover chain or emits a Unicode-safe deterministic shard plan whose ranges, hashes, page bounds, estimates, and complete coverage are revalidated in pure code. Persisted M2 receipts are bound per exact source snapshot plus manifest, complete source inventory, destination/reconciliation, and route configuration; a run foundation requires accepted full-envelope coverage for every frozen source. Caller-submitted shard receipts remain rejected as `sharded_attestation_unavailable` until M8 can reload and attest the immutable bytes itself. Unknown contract versions are rejected. No work-order executor, provider call, claim path, or publication path exists, and rollout remains `disabled` at activation epoch zero.

The machine-readable proof is `docs/Templates/fixtures/work-order-v2/m2-milestone-proof.json`. It records contract, ingestion, migration, immutable reload, destination isolation, route/preflight, retention/purge, repository, disposable PostgreSQL, and PostgREST acceptance evidence.

#### M3 — Coverage correctness, selection reuse, waiters, and removals

- repair current inventory/checkpoint reuse so source/content/Markdown fingerprints and extraction-contract identity are mandatory;
- add cross-run factual coverage receipts and atomic reserve-or-wait behavior;
- add durable coverage-waiter rows with `waiting | importable | reclaimable | resolved | cancelled` transitions;
- add source-selection receipts with `selected | not_selected | no_match | unobserved`, kept separate from factual coverage and invalidated by exact source/selection/retrieval/planner semantics;
- make unchanged negative selections reusable so warm runs do not repeat discovery/planning, while new or changed files form the delta;
- add idempotent validated-artifact import and higher-epoch reclaim after failure/expiry;
- create staged tombstones for removed documents, changed-fingerprint replacements, and incompatible definition replacement; publish removals atomically with replacement contributions;
- retain immutable audit artifacts and prevent record presence alone from being treated as coverage.

**M3 exit gate:** changed Markdown always re-enters; an unchanged compatible mapping makes no provider call; unchanged rejected sources do not force another planner call; a new file alone becomes the delta; two concurrent runs create one coverage owner; failed/cancelled/expired ownership is safely reclaimed; cross-scope records never count; removal/replacement overlay tests pass.

##### M3 implementation record

M3 adds canonical, versioned coverage identities for source scope, individual source bytes, extraction semantics, reconciliation policy, source selection, validated results, imports, persisted Task Dataset contribution sets, source seals, and committed publication bindings. Document-level selection decisions bind that document's exact keyword/vector indexed-artifact digests and treat the corpus revision only as provenance, so one unrelated new document becomes the delta without invalidating prior `selected | not_selected | unobserved` decisions. A scope-level `no_match` binds the complete frozen source-scope and index watermark and therefore invalidates when the corpus changes. Coverage classification requires the same tenant/destination scope, document, requirement, source fingerprint, extraction identity, and a committed/sealed publication proof; an uncommitted but verified terminal result remains importable and is never mislabeled as factual coverage.

The additive M3 coverage migration persists immutable factual-coverage receipts, nonclaimable durable waiters, source-selection receipts, exact validated-result attestations, idempotent import receipts, Task Dataset source proofs, and staged source tombstones. Reservation, failure, higher-epoch reclaim, waiter cancellation/import, selection registration, publication binding, and tombstone transition are fenced through scoped RPCs. The Railway after-all grant layer preserves read-only service-role inspection but explicitly denies direct ledger mutation and direct access to verifier/digest helpers. No attestation-registration RPC exists, so callers cannot self-certify a result. Deletion of a Task or live source cannot erase durable owner snapshots or audit evidence.

The staged-v1 repair migration also makes current source inventory, checkpoint restore, coverage summaries, and template-RAG-cache reuse depend on exact source/content/Markdown/page-map/canonicalizer and extraction-contract fingerprints. A changed document or incompatible definition invalidates only the affected reusable state. Title or display-only metadata changes do not silently become semantic extraction compatibility.

The worker-side M3 validated-result verifier is a provider-free primitive only. It reloads the exact tenant-scoped immutable object, bounds compressed and decompressed bytes, rejects noncanonical or ambiguous JSON, verifies content address/path/version, rebinds the extraction envelope and assignment, validates schema and evidence, and emits deterministic result, schema, persisted-record-set, evidence, and verifier-attestation digests. It neither calls a provider nor registers an attestation, claims work, imports records, or publishes a Task Dataset; those remain gated to later milestones.

The machine-readable implementation evidence is `docs/Templates/fixtures/work-order-v2/m3-milestone-proof.json`. The generated ownership/checksum artifacts, full disposable Railway PostgreSQL chain and behavioral suite, and signed PostgREST acceptance all reflect the frozen migration bytes. The M3 gate is closed. Rollout remains `disabled` at activation epoch zero, staged v1 remains authoritative, and M4 may now add shadow-only discovery and planning; no claimable work, provider execution, or publication path is active.

#### M4 — Phase 1 discovery and planner shadow

- implement and persist frozen-scope `rankDocumentsForQuerySet()` results with query-aware distinct-document ranking and bounded anchors;
- add raw-signal and assembled-result caches with the documented invalidation boundaries;
- compile the coverage-aware/data-blind planner summary and ensure no Task Dataset record bodies enter its context;
- call the planner once with no tools, validate every returned triple against an exact persisted `matched` cell, and reject covered/in-progress/out-of-scope selections;
- create direct all-in-scope assignments server-side and keep them out of planner selection;
- persist shadow plan proposals and source-selection receipts, but create no claimable Phase 2 work;
- compare shadow selections against the labelled corpus and current v1 behavior.

**M4 exit gate:** candidate recall meets the approved target; every planned triple is allowlisted and reproducible by digest; empty/no-match/error behavior is explicit; planner input contains no raw dataset records or tools; fully warm runs make zero discovery/planner provider calls; rollout may advance only to `plan_shadow`.

**M4 implementation record — 2026-09-03.** Frozen discovery, document-fair keyword/vector acquisition, PPB ranking, coverage-aware data-blind planning, strict matched-cell validation, raw/result caches, bounded retry/repair journaling, and nonclaimable proposal/selection persistence are implemented. Database authority reconstructs inventories and actionability; final coverage and selection locks precede authoritative preparation. The generic `rag_documents` tool is available to Ask and ordinary Extraction with bounded raw acquisition. Unicode byte limits, over-cap artifacts, replay, cancellation, warm reuse, and concurrent coverage reservation are covered by automated tests. The full repository suite, build, disposable PostgreSQL chain, signed PostgREST acceptance, and offline Smyrna quality checks pass.

The evidence is `docs/Templates/fixtures/work-order-v2/m4-milestone-proof.json`, with the actual model result in `m4-configured-provider-quality.json`. The administrator-only `/configuration/template-planner-quality` page calls the fixed, labelled, data-blind probe through the saved Extraction provider configuration. On staging commit `310e5d6`, OpenAI OAuth / GPT-5.6 Luna at saved max reasoning selected all 11 expected assignments across 12 cases, with 100% assignment recall/precision, no false positives, and schema-valid output on the first call in 39.728 seconds. This single correctness probe does not certify population schema-validity rates or p95 model latency. The page has no task/dataset publication side effects and does not activate shadow processing. The active database is current at the M4 migration head, its maintenance barrier is open, and deployed claims/publication were verified disabled. **The M4 gate is closed; M5 may begin.** Default rollout remains `disabled`, activation epoch is zero, and staged v1 remains authoritative.

#### M5 — Durable deferred control plane with synthetic workers

**M5 entry criterion:** Before synthetic restart tests can treat an interrupted
Phase 1 planner call as resumable, the worker must recover the exact durable
planner execution token and reconstruct any syntax-repair source response from
content-addressed, bounded storage. M4 deliberately fails closed when that
ephemeral state is lost: it makes no duplicate provider call, creates no claim,
and publishes nothing, but it does not claim restart liveness.

- add batches, immutable source inventory, discovery rows, logical assignments, coverage receipts/waiters, work orders, envelope assignments, requirement rollups, staged tombstones, and report-snapshot metadata through additive migrations;
- create every order as `prepared_nonclaimable`;
- add parent `waiting/deferred` disposition and resume cursor without consuming the provider-failure budget;
- add claim, lease/epoch, heartbeat, retry-delay, settlement, cancellation, slot, and exactly-once barrier-wake RPCs;
- replace in-memory publication-lease custody with fenced server-owned custody that survives parent yield and process restart;
- add transactional status/outbox/webhook events and a centralized platform-readiness guard around every worker queue;
- exercise the entire state machine with synthetic successful, delayed, failed, crashed, cancelled, shard, and waiter-import children; make no provider call.

**M5 exit gate:** fault tests prove restart recovery, stale-worker rejection, cancel-versus-final-settlement fencing, one wake, one contribution, no leaked slots, durable custody, and correct waiter import/reclaim. Claim RPCs still return no real v2 work; rollout is at most `orders_shadow`.

#### M6 — Downstream report snapshot and renderer, fixture-driven

- implement the immutable Phase 3 as-of Task Dataset view and staged replacement/removal overlay;
- apply temporal filtering, conflict handling, sorting, totals, dependencies, and source-register projection deterministically;
- persist and digest `ReportDataSnapshot`;
- make Phase 4 consume only the snapshot, perform direct binding plus bounded narrative synthesis, enforce completeness, and render through the deterministic DOCX engine;
- drive both phases with synthetic validated Phase 2 fixtures, including empty/optional/required gaps and high-cardinality collections.

**M6 exit gate:** identical inputs reproduce snapshot and DOCX digests; a report-date-only rerun performs no source extraction; replacement/removal does not double-count; required gaps cannot publish; golden layouts/assets/comments/evidence registers validate after restart. There is still no real Phase 2 provider execution.

**M6 implementation record — 2026-09-03.** Phase 3 now materializes a
canonical, digest-bound as-of dataset view with staged replacement/removal,
temporal and conflict policy, cardinality, deterministic ordering and totals,
and a source register derived only from included records. A report-period-only
rerun preserves the terminal Phase 2 and dataset-view identities. Required gaps
make the snapshot non-publishable.

Phase 4 accepts only a verified snapshot and compiles direct scalar, aggregate,
collection, source-register, and bounded narrative bindings before invoking the
deterministic DOCX engine. The Town Manager fixture preserves its image and
section structure, removes comments and placeholders, and now normalizes ZIP
timestamps so both logical package and downloadable byte digests remain stable
across clock changes. Synthetic-only database RPCs persist idempotent snapshot
and render receipts, reject changed replays and required-gap rendering, and
cannot publish a generated file. Disposable PostgreSQL proof covers backup,
restore, and process restart with zero provider calls. Staging candidate
`f387b9e` passed GitHub tests, migration, service, public-health, and embedding
checks; the active database is current at the M6 head with matching checksums.
Rollout remains `disabled`, activation epoch is zero, claims and publication are
off, and staged v1 remains authoritative. The evidence is
`docs/Templates/fixtures/work-order-v2/m6-milestone-proof.json`. **The M6 gate is
closed; M7 may begin.**

#### M7 — Observable and controllable synthetic end-to-end path

- expose versioned API progress for phase, documents, assignments, envelopes, requirement rollups, retries, waiters, slots, elapsed time, and ETA;
- display the same database-derived truth in Task Run Queue, including current source/dataset titles and model/server statuses;
- send model-status and server-transition webhooks through the transactional outbox;
- add inspect, cancel, retry/rebuild, and failure-detail controls;
- run long synthetic batches to verify bounded telemetry and context-safe logging without full Markdown or record-body leakage.

**M7 exit gate:** API, UI, webhooks, and database counts agree under concurrent completion; cancellation stops synthetic claims and blocks late writes; a user can identify the exact phase, remaining work, retry reason, and gap. Rollout remains `orders_shadow`.

**M7 implementation candidate — 2026-09-03.** A strict `templateWorkV2`
contract now projects bounded database truth for all four phases, counts,
requirements and gaps, retries, waiters, slots, elapsed time, ETA, current
source/dataset titles, model/server messages, failures, report state, and
controls. Task-run list and detail APIs use that contract, and the Task Run Queue
renders the same values without including source Markdown or extracted records.

The existing transactional event outbox now has fenced leases, stable delivery
identities, durable retry scheduling, and terminal receipts. A worker dispatcher
sends signed `template_execution.*` model and server transitions only in
synthetic `orders_shadow`; it is inert under the required staging mode
`disabled`. Run-level cancellation reaches every nonterminal synthetic batch,
releases slots, and fences late writes before the v1 run is marked cancelled. A
rebuild endpoint and queue control create a clean replacement with the original
Task scope and saved settings without copying webhook credentials. The
disposable `--m7-observability` proof covers 15 shards, count agreement,
webhook retry/lease fencing, run cancellation, bounded telemetry, and zero
provider calls.

**M7 gate closed — 2026-09-03.** Candidate `1b6e468` passed the complete
repository workflow and the staging migration workflow, and all affected
Railway services deployed successfully. Live health reports the M7 migration
head and all 137 pinned checksums; the private embedding smoke returns 1,024
dimensions. A read-only query against the active Supabase control row confirms
rollout remains `disabled`, activation epoch remains zero, worker claims and
publication remain false, and staged v1 remains authoritative. The durable
evidence is
`docs/Templates/fixtures/work-order-v2/m7-milestone-proof.json`. **M8 may begin
only through its isolated test/admin harness; the normal worker lane remains
forbidden.**

#### M8 — Isolated Phase 2 executor shadow

This is the first milestone that implements a real Phase 2 provider request. It is not connected to the normal worker polling lane.

- extract provider routing/direct-call/capacity primitives into a server-safe shared module rather than importing the web Swarm runtime into the worker;
- compile the exact full-Markdown or deterministic-shard envelope from immutable artifacts;
- implement native structured output or one strict JSON response, bounded syntax repair, timeout/retry/failover, and cancellation propagation;
- validate the discriminated result/evidence schema, title/identity/temporal/cardinality policies, and shard `no_records_in_range` semantics;
- persist only into a quarantined shadow transaction through targeted server-owned settlement;
- expose execution solely through a test/admin harness that must still obtain a quarantined durable lease through the same claim/settlement contract, start at concurrency one, and compare records/evidence against gold fixtures.

**M8 exit gate:** schema, evidence, destination isolation, idempotency, shard merge, kill-before/during/after-commit, provider failure, context budget, token/cost, and golden accuracy tests pass. Shadow data cannot publish and the normal worker cannot poll these orders. Rollout is at most `executor_shadow`.

##### M8 implementation candidate

The implementation now uses a server-safe core executor with no database,
Storage, web Swarm, or worker dependency. An explicit authenticated admin
harness must first obtain a targeted durable lease for one synthetic-shadow
order; it then verifies the immutable canonical Markdown/page map, rebuilds the
exact full or deterministic-shard envelope, invokes only the frozen provider
route/failover chain, validates all result/evidence semantics, and stores the
result solely as an audit-pinned artifact plus an immutable quarantine receipt.
Semantic-result and artifact-byte digests are distinct. One bounded JSON repair
is allowed, provider failure/cost telemetry is retained, and cancellation or
lease loss aborts the provider path. The normal worker imports none of this
harness and still has no Phase 2 claim lane.

Disposable PostgreSQL acceptance proves concurrency one, capacity release,
heartbeat and lease fencing, exact replay, conflicting replay, expiry/reclaim,
run cancellation, rejection of the old synthetic claim path under
`executor_shadow`, and no Task Dataset, generated-file, logical-assignment, or
publication mutation. Core/web tests cover full and shard contracts, strict
evidence, unavailable-value rejection, context budgets, retry/failover,
bounded repair, and provider usage telemetry.

**M8 gate closed — 2026-09-03.** Candidate `a75b4bb` passed the complete
repository workflow and staging migration workflow, and all seven Railway
services deployed successfully. Live health reports the M8 executor-shadow
migration head, the matching 138-checksum core ledger, and the exact candidate
commit; the private embedding smoke returns 1,024 dimensions. A read-only
query against the active Supabase control row confirms rollout remains
`disabled`, activation epoch remains zero, worker claims and publication remain
false, and staged v1 remains authoritative. No live provider execution was
invoked while the control remained disabled. Durable evidence is recorded in
`docs/Templates/fixtures/work-order-v2/m8-milestone-proof.json`. **M9 may now
implement the only activation boundary and dedicated internal claim lane; no
M10 allowlist, publication, or default-routing behavior is authorized.**

#### M9 — Activation gate and internal claim lane

- implement `activate_extraction_template_work_batch()` as the only transition from prepared to claimable;
- add the dedicated bounded `template_work_order` worker lane and capacity kind without starving ingestion or saved Task jobs;
- require the centralized platform-readiness guard plus RPC-side eligibility on every claim;
- reject unsupported workers before lease acquisition;
- enable explicit internal canaries at concurrency one, then three, with publication still disabled initially;
- run kill-switch, drain, restart, and rolling-deployment compatibility drills.

**M9 exit gate:** every M0–M8 proof is recorded; no alternate query can bypass activation; older workers claim zero v2 rows; active/granted slots remain within the configured bound; disabling claims stops new work and fences active calls; internal canaries complete end to end with no duplicate or cross-scope writes.

##### M9 implementation candidate

The M9 candidate introduces the only verified activation RPC, immutable
activation and worker receipts, a dedicated worker claim lane, and fenced
heartbeat/settlement/cancellation contracts. Activation now materializes and
validates every exact Task Dataset source destination before any work becomes
claimable. Claims advertise and verify the worker build, installed migration
head, worker protocol, pipeline, envelope, and result versions before acquiring
a lease, and both the worker and database recheck centralized platform
readiness. The first live-capable bound is one or three claims per batch with a
hard three-claim verified tenant ceiling and shared provider-capacity claims.

The worker loads and digest-verifies immutable Markdown/page-map artifacts,
uses the frozen provider route through a private tool-free provider bridge,
validates the result through the quarantined M8 executor, and converts it into
server-owned Task Dataset contributions. The planner/model cannot provide
destination IDs, generation, logical keys, deduplication hashes, or persisted
record digests. Exact replay is idempotent; conflicting replay, cross-scope
writes, expired leases, cancellation, and old workers fail closed. M9 accepts
only full-document preflights. Deterministic persisted shard merging remains an
explicit M10 gate.

The canary control always leaves publication false. Disabling it first cancels
and fences active verified batches, releases source and provider slots plus
publication custody, advances the activation epoch, and then returns rollout to
`disabled`. The disposable PostgreSQL proof exercises an old-worker rejection,
one real verified claim, Task Dataset persistence, exact replay, and the kill
switch without committing the transaction; worker tests separately exercise
three concurrent claims. The implementation checklist is recorded at
`docs/Templates/fixtures/work-order-v2/m9-implementation-checklist.md`. M9 is
closed only by the deployed evidence below; the candidate by itself did not
authorize M10 until staging controls were verified disabled in the durable
milestone proof.

**M9 gate closed — 2026-09-03.** Candidate `e476cdf` plus deployment-recovery
commit `b2549f1` passed the complete repository workflow, disposable
PostgreSQL real-claim canary, PostgREST acceptance, backup/restore/restart
coverage, and hosted reconciliation. The live database reports the exact M9
head and 139 pinned core checksums with the installation operational and its
maintenance mode clear. Settings, Maintenance, the worker, web, PostgREST,
embeddings, and the scheduler are healthy or safely sleeping. The active
control row remains `disabled` at activation epoch zero with worker claims and
publication false. Staging had zero safely prepared verified batches, so no
user workload was fabricated or activated solely for evidence; the bounded
real claim, Task Dataset settlement, idempotent replay, old-worker rejection,
and kill-switch proof ran in the disposable acceptance database. Durable
evidence is recorded in
`docs/Templates/fixtures/work-order-v2/m9-milestone-proof.json`. **M10 may now
implement the separately gated allowlisted canary and publication path; this
does not authorize publication, unallowlisted routing, or default enablement.**

#### M10 — Allowlisted canary, publication, and gradual default

- allowlist the Town Manager template in one test silo and compare v2 against v1 on selection recall, record/evidence accuracy, binding/render accuracy, latency, cost, and duplicate work;
- enable canary publication only after its independent publication gate passes;
- expand from 1 to 3 and then up to 15 parallel calls while monitoring provider, worker, database, and queue health;
- exercise rollback before every expansion;
- keep v1 authoritative for ineligible manifests and new-run emergency fallback until the full acceptance window passes;
- make v2 the default only for eligible Manifest-v2 templates after Section 27 and soak targets are met.

**M10 exit gate:** the documented accuracy, security, cancellation, latency, cost, no-duplicate, and DOCX-quality thresholds hold throughout the agreed observation window. Only then may rollout become `enabled`.

##### M10 implementation candidate — activation not authorized

The candidate adds an exact tenant/silo/nullable-project/template-group/
template/version/Manifest-assessment allowlist, a fail-closed new-run route
resolver, immutable v1-versus-v2 comparison receipts, and a single fenced
release-control RPC. The database itself enforces the Section 27 accuracy,
provenance, schema, unsupported-value, duplicate, DOCX, cancellation, security,
latency, cost, provider-error, and capacity-leak thresholds. Expansion requires
three passing comparisons at concurrency 1, a rollback drill, three at 3, a
second rollback drill, and three at 15. Publication has a separate gate, and
default routing additionally requires a server-timed 24-hour soak with no
failed comparisons.

The dedicated worker can claim up to 15 only when the durable control permits
it. A rollback advances the activation epoch, fences/cancels active work,
releases capacity, and returns claims, publication, and default routing to
off. Railway's provider-tail grants now explicitly preserve select-only access
to all M5–M10 ledgers and remove remote execution from private helpers and the
superseded M9 switch.

Disposable PostgreSQL acceptance exercises exact allowlisting, route fallback,
one real verified claim and Task Dataset settlement, the full
1→rollback→3→rollback→15 control sequence, independent publication
authorization, premature-default rejection, backup/restore, and restart. It
ends `disabled` and rolls all fixture data back. This is implementation proof,
not the required live observation window.

The normal saved-Task entry point now pins the database-resolved route once per
item. Only an exact current-epoch allowlist can enter deferred v2. The server
derives the complete ready-source inventory, validates immutable artifacts,
reconciles Task Dataset destinations, runs the durable Phase 1 coordinator,
binds a verified batch, transfers publication custody with a hidden token, and
atomically activates plus defers the parent. Barrier completion clears the
queue wait pointer before requeue. If rollback closes the Phase 1 gate before
activation, the item safely continues through staged v1. Disposable acceptance
executes this real bridge and proves immutable route replay and the wake path.

Template Ingestion configuration exposes a requested work-order parallelism of
1, 3, or 15, with 1 as the fail-closed default. This value is a target rather
than an authority: batch activation takes the minimum of the configured
request, the immutable route ceiling, and the live certified release ceiling.
An administrator can therefore configure 15 without bypassing a 1-slot canary;
the same setting begins using 3 and later 15 only after the database accepts
the required comparisons and rollback evidence for those stages.

This wiring does not configure a live allowlist, authorize publication, or
claim soak evidence. The deployment must remain `disabled`. The detailed
checkpoint and administrator API contract are in
`docs/Templates/fixtures/work-order-v2/m10-implementation-checklist.md`.
**The M10 exit gate remains open.**

### 23.5 Single fail-closed activation boundary

`activate_extraction_template_work_batch()` must atomically verify all of the following before assigning an activation epoch and promoting any `prepared_nonclaimable` order:

- an accepted and eligible immutable Manifest v2 with supported contract versions;
- verified immutable Markdown/page-map artifacts for every selected range;
- exact, compatible, and locked Task/silo/nullable-project/Task Dataset destinations;
- one owned coverage reservation or durable waiter for every logical assignment;
- persisted successful discovery and accepted planner output, or the valid zero-planner/direct-assignment path;
- parent defer/resume and exactly-once barrier-wake support;
- live fenced Task Dataset publication custody;
- noncancelled parent/run/batch and current cancellation epoch;
- successful provider route/context/output/timeout/failover/shard preflight;
- compatible worker pipeline/envelope/result versions;
- current platform/schema readiness and an enabled activation mode;
- emergency claims kill switch enabled for new work.

The claim RPC must independently recheck the activation epoch, rollout permission, supported worker version, parent cancellation, custody, and order state. Workers must have no alternate select/update path that can bypass these predicates.

### 23.6 Migration, CI, and milestone evidence

Every schema milestone uses a new timestamped additive migration; never edit an already-applied migration. Each such milestone must also:

- update the expected migration head, migration checksum ledger, data-plane release/schema package, environment contract, and generated application-ownership artifacts;
- add or extend a head-pinned SQL test, including a dedicated `template_work_orders_v2.sql` suite;
- verify fresh schema creation and known-head forward play-through;
- pass `pnpm docs:check`, `pnpm phase9:check`, typecheck, unit tests, build, and the relevant Railway PostgreSQL/PostgREST acceptance suites;
- include a bounded post-migration smoke test before runtime mode advances;
- attach the exact test/benchmark evidence to the milestone review.

Do not rely only on the application feature flag for correctness. Database constraints/RPC predicates must keep later-milestone behavior unavailable to earlier binaries and modes.

### 23.7 Rollback boundaries

- **M0–M7:** turn off shadow processing; v1 remains authoritative and no v2 provider result can publish.
- **M8:** disable the isolated harness, fence/cancel active calls, and retain or purge quarantined artifacts under policy; normal queues are unaffected.
- **M9–M10 before publication:** disable new claims, stop publication, and drain or explicitly cancel pinned v2 runs. New runs route to v1; in-flight runs never change pipeline version.
- **After v2 publication:** use a compensating Task Dataset generation or explicit v2 rerun. Do not downgrade the database, deploy an incompatible old binary, or relabel a published v2 run as v1.

Rollback is forward-only because the platform requires an exact migration head. Old workers must fail closed rather than claim rows whose versions they do not understand.

---

## 24. Test strategy

### 24.1 Unit tests

- document-search request limits, unique keys, normalized-query dedupe, deterministic ordering, and stable digests;
- version-2 global query-registry dedupe/cap, shared-query multi-requirement mappings, and no silent truncation of legacy per-requirement query sets;
- chunk over-fetch and best-hit document collapse so duplicate chunks cannot starve distinct documents;
- per-mapping protected-depth/rank-round-robin union, RRF trimming, direct all-in-scope assignment, and response/signal/assignment-state size caps;
- dense cells distinguish `matched`, `unobserved`, and `covered`; unknown scores remain `null`, never zero;
- compatible coverage is excluded per document × requirement before ranking, while a changed fingerprint/contract re-enters;
- coverage-ledger classification is scope-bound and distinguishes `covered`, `uncovered`, `stale`, `in_progress`, and `failed`; a populated dataset without a compatible sealed receipt is not covered;
- planner-summary compilation exposes counts, titles, declared format/cardinality, and refresh policy but no stored Task Dataset record payloads;
- retrieval mode/fallback/truncation summaries and partial-backend failures are preserved accurately;
- planner schema parsing and allowlist validation;
- unknown/duplicate candidate and query rejection;
- work-order/assignment digest stability;
- report-date exclusion from extraction digest;
- display-only dataset-title/description rename exclusion from extraction coverage, while a semantic model-title-rule change invalidates the extraction contract;
- context-budget and shard decisions;
- provider-result schema and evidence validation;
- Phase 2 envelope compilation includes the exact source title, dataset title/description, immutable extraction query, `json_records` schema, title policy, and complete verified Markdown;
- deterministic record-title derivation, bounded semantic-title validation, and proof that titles do not participate in record identity;
- fallback-string rejection;
- date filtering and fiscal/calendar boundaries;
- deterministic aggregates and source-register mapping;
- as-of Task Dataset overlay, staged replacement/merge, source removal, and `datasetViewDigest` stability without double counting;
- ETA calculation and rollup arithmetic.

Primary files should include new `rag-document-ranking.test.ts` and `template-work-order-planner.test.ts`, plus extensions to `task-execution-plan.test.ts` and the staged template coverage/orchestration tests. Also extend the `rag-core` tool allowlist/schema tests, native retrieval-tool tests, text-fallback parser tests, and extraction model-execution tests for the model-facing `rag_documents` adapter.

### 24.2 Database tests

- discovery request/result and candidate rows commit before the planner is eligible;
- unselected/unobserved source-inventory rows create no pending Task Dataset source claim, do not block sealing, and do not create false `not_applicable` coverage;
- persisted discovery rows are isolated by tenant/silo/project and frozen source scope;
- raw-signal cache invalidates only for its individual query/document/indexed-artifact/retrieval-version identity; assembled discovery-result cache also invalidates for ordered raw-signal result, query-set, coverage, source-scope/index watermark, configuration, and limit changes—but neither invalidates for report-date/layout-only changes;
- cancellation fences late discovery and planner results;
- stale/out-of-order model-status epochs/sequences are rejected and each accepted status has one transactional outbox event ID;
- concurrent claims never return the same order;
- stale token/epoch cannot heartbeat or settle;
- atomic counter updates under parallel settlement;
- final barrier queues the parent once;
- cancelled parents cannot claim or settle children;
- source fingerprint mismatch fails closed;
- Task Dataset scope mismatch across saved Task, silo, nullable project, group, transaction, or dataset definition fails closed;
- Task Dataset commit and assignment settlement cannot drift;
- retry replay creates no duplicate records;
- a concurrent compatible logical assignment waits/imports or recovers after its owner; it never launches a duplicate provider call;
- validated artifact import from a failed prior run creates one new-transaction receipt and no provider call; cancelled/late/partial/incompatible artifacts are rejected;
- source deletion retains audit rows;
- no hot claim path locks `task_dataset_groups`.

The new ranking-RPC integration test must include a source with more than 50 strong chunks and prove it cannot starve other relevant documents; it must also verify query-aware FTS ordering, exact frozen allowlist fencing, current-run Task Dataset snapshots, deleted-live-document audit behavior, and service-role permissions.

### 24.3 Worker fault tests

- retrieval interruption/timeout retries the same digested request and never falls back to unranked planning;
- a successful empty discovery proceeds to explicit unassigned-requirement planning;
- a permanent discovery failure prevents a planner call and leaves no claimable work order;
- kill before provider call;
- kill during provider call;
- kill after validated result persistence but before Task Dataset commit;
- kill after Task Dataset commit but before order settlement;
- provider timeout/429/5xx and route failover;
- invalid JSON then successful corrective retry;
- oversized document routed or sharded;
- live document edited/deleted after planning still loads the verified immutable Markdown object; a missing/corrupt pinned object fails `stale_input` without loading newer content;
- cancellation during queue wait and during model streaming;
- dropped cross-process cancellation notification with the ≤5-second polling fallback still aborting/fencing the call;
- last-child settlement while two workers finish concurrently.
- parent yield with children running longer than 15 minutes, worker-process restart, publication-lease renewal, and successful fenced resume;
- cancel racing the final child settlement produces one terminal outcome and at most one parent wake;
- deterministic shard split creates children once, does not overcount the logical assignment, and settles only after merge;
- mixed success/not-applicable/optional-failure/required-failure children produce the exact envelope and batch rollups;
- capacity never exceeds 15 active `template_work_order` calls and every failure/cancellation path releases its slot.

### 24.4 End-to-end fixtures

- gold source-selection corpus with exact expected candidate documents per query;
- duplicate query semantics normalized to one shared stable key, mapped to distinct requirements, and executed once;
- a document covered for requirement A but still eligible for requirement B;
- a previously `not_applicable` document changed on disk and re-entering discovery;
- a no-match query/requirement mapping and an all-in-scope requirement in the same batch;
- all-in-scope-only nonzero work with zero discovery/planner calls, plus a mixed direct-all-in-scope/planner-selected batch;
- partially selected/no-match inventory sealing with no pending or false-covered Task Dataset source snapshots;
- keyword/vector fallback with the mode visible in inspection and telemetry;
- one document and one scalar requirement;
- a partially covered requirement where only uncovered document/requirement mappings reach the planner and Phase 2;
- a dataset populated under another Task, silo, or project that provides zero coverage to the current run;
- a new document containing an already-known logical record that is still extracted, then merged with both sources' provenance retained;
- a Phase 2 fixture asserting the exact extraction query/data title/schema/full-Markdown digest and the absence of raw Task Dataset records from Phase 1;
- one document serving several requirements;
- many documents at 15-way parallelism;
- unchanged rerun with zero extraction calls;
- date-only warm rerun with zero Phase 2 writes whose as-of dataset view still includes compatible records physically written in prior generations;
- same sources with a different report month;
- same sources with a display-only dataset-title rename and zero Phase 2 provider calls;
- changed source fingerprint;
- changed template requirement digest;
- period-scoped records spanning the date boundary;
- conflicting source values;
- repeating table with high cardinality;
- narrative summary depending on later detail sections;
- source/evidence register;
- optional missing section;
- required terminal gap producing the configured failed or review-only/non-publishable outcome;
- exact preserved layout, images, comments removed, and valid DOCX ZIP.

### 24.5 Retrieval quality, performance, and security gates

- measure candidate recall independently from planner assignment precision/recall; `rag_documents` must reach at least 98% candidate recall on the approved gold corpus;
- benchmark broad, precise, and no-match queries, including a 12-query batch, and record p50/p95 latency plus backend search count;
- verify 100% of planner-selected document/query/requirement triples resolve to an exact persisted `matched` assignment-state cell;
- fuzz query and matrix limits and prove the serialized result never exceeds the configured cap;
- verify the 60-query registry and protected-depth budget either preserve every uncovered mapping's floor or return explicit `candidate_matrix_capacity_exceeded` without planning;
- attempt cross-tenant/silo/project candidate IDs and confirm the retrieval service fails closed;
- verify metrics contain query keys/digests rather than unrestricted query/source text.

### 24.6 Milestone interlock tests

- prove `disabled` permits no v2 discovery, planner, work-order claim, provider call, Task Dataset mutation, or publication;
- prove `plan_shadow` can persist discovery/planner artifacts but cannot create a claimable order;
- prove `orders_shadow` exercises synthetic claims/settlements only and rejects real provider execution;
- prove `executor_shadow` permits only explicit test/admin harness execution into a quarantined nonpublishable transaction;
- prove every new order starts `prepared_nonclaimable` and only the fenced activation RPC can promote it;
- independently attempt every activation prerequisite failure and confirm zero orders become claimable;
- run an older/unsupported worker against v2 rows and confirm it obtains no lease;
- disable the emergency claims switch during active work and confirm new claims stop, active calls are aborted/fenced under policy, and slots are released;
- disable publication after successful shadow execution and confirm no v2 generation becomes active;
- prove a global rollout-mode edit does not mutate an in-flight run's pinned pipeline version or silently route it to v1;
- exercise the centralized platform-readiness guard and prove no worker queue, including saved Task jobs and template work orders, bypasses it;
- attach a machine-readable milestone proof containing contract/migration versions, test results, benchmark IDs, reviewer, and activation epoch before the next mode is permitted.

---

## 25. Resolved architectural decisions

These decisions are part of the target design:

1. `rankDocumentsForQuerySet()` is a mandatory server-owned Phase 1 prerequisite whenever retrieval-backed work is uncovered; it is never a planner tool.
2. The planning model is skipped when no retrieval-backed work remains; otherwise it produces one valid structured plan against the persisted discovery matrix in at most three provider attempts (initial, one transient retry/failover, and one syntax-only repair) and receives no tools.
3. There is no `swarm_enqueue` model tool for this pipeline.
4. The worker service owns dispatch, retries, persistence, cancellation, and phase wake-up.
5. The parent Task item remains `running` with `phaseKey = compile_source_data`; its separate queue job yields in `waiting` with `waitKind = template_work_orders` and resumes after the durable barrier.
6. Logical progress is tracked per document × requirement.
7. Compatible logical assignments are bundled into document-level model envelopes so Markdown is read once.
8. Full canonical Markdown is used when it fits; otherwise the system reroutes or explicitly shards and never truncates silently.
9. Phase 2 models do not perform RAG searches or Task Dataset writes.
10. The server validates and writes Task Dataset records.
11. Phase 2 extracts all supported periods; report-date filtering happens only in Phase 3.
12. Phase 3 is persisted as an immutable report-data snapshot.
13. Phase 4 consumes that snapshot and cannot reopen broad retrieval.
14. The configured Swarm routes/slot ledger are reused under a distinct `template_work_order` capacity kind.
15. Numeric progress comes from durable rows; model status is supplementary.
16. A Phase 2 `gap_required` fails the batch/item and prevents publication; a later Phase 4 binding/render gap follows the explicit failed-versus-review-only Task policy but is never publishable as trusted. Optional gaps may continue only under explicit policy.
17. A run uses one pipeline version from beginning to end.
18. Source inventory is frozen at planning time; newly arrived documents wait for a new/restarted plan.
19. Ask and general Extraction may use the read-only `rag_documents` tool; the deferred pipeline uses the shared server function directly and never gives that tool to its planner or Phase 2 workers.
20. Requirements with `selectionPolicy = all_in_scope` create direct server-owned assignments; they never enter retrieval or planner selection.
21. Frozen source inventory is separate from Task Dataset source claims; only planner-selected or direct all-in-scope assignments create claims.
22. Requirement-level cardinality/evidence rollups decide satisfaction; a failed candidate document alone does not fail a required requirement.
23. Phase 3 prepares facts deterministically; Phase 4 owns the single schema-bound narrative wording step.
24. Pipeline version 2 has no in-run supplemental extraction cycle; an explicit later rerun plans only the unresolved delta.
25. Task item execution status remains the existing processing enum; review/trust and publication eligibility are separate fields.
26. A fenced server coordinator renews Task Dataset publication custody across the deferred boundary without persisting plaintext lease tokens.
27. The Phase 1 planner is coverage-aware but data-blind: the server decides reusable coverage and supplies only bounded counts/state plus actionable candidates, never stored record payloads.
28. Every Phase 2 worker receives a server-compiled envelope containing the immutable extraction query, strict structured-data format, data/source titles, and full verified Markdown; the model cannot choose the Task Dataset destination.
29. Compatible document × requirement receipts prevent repeat work. Existing records or minimum cardinality alone do not suppress a credible new/changed source under the default `new_or_changed_sources` refresh policy.
30. Implementation follows Milestones M0–M10 in order; the existing staged-v1 path remains authoritative until an allowlisted v2 canary is explicitly activated.
31. Planner-created work orders begin as `prepared_nonclaimable`. Only the fenced activation RPC can promote them, and no alternate worker query may bypass its predicates.
32. Phase 3 snapshot preparation, Phase 4 rendering, progress, cancellation, and the deferred control plane are proven with synthetic records/workers before a real Phase 2 provider executor is connected.
33. Real Phase 2 provider execution first runs through an isolated quarantined harness in `executor_shadow`; the normal worker claim lane is added only after that milestone passes.
34. Rollout uses `disabled | plan_shadow | orders_shadow | executor_shadow | canary | enabled`, separate from lifecycle status, plus independent emergency claim and publication controls.

---

## 26. Implementation defaults still tunable

These values should be configuration with conservative defaults, not unresolved architecture:

| Setting                                                               | Recommended default                                                                                 |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Deferred-v2 rollout mode                                              | `disabled` until the applicable milestone gate is recorded                                          |
| V2 worker claims                                                      | disabled until M9 activation-gate approval                                                          |
| V2 publication                                                        | disabled through executor shadow and initial internal canary                                        |
| Initial live claim concurrency                                        | 1, then 3, then up to the configured 15 after each expansion gate                                   |
| Template work-order parallelism request                               | 1 by default; administrator-selectable 1, 3, or 15 and always capped by the certified release level |
| Maximum keyed discovery queries                                       | 60, with bounded concurrency and a 12-query reference benchmark                                     |
| Maximum characters per discovery query                                | 2,000 after normalization                                                                           |
| Discovery query concurrency                                           | 4                                                                                                   |
| Per-query distinct-document limit                                     | 50                                                                                                  |
| Observed candidates protected per uncovered query/requirement mapping | 3 before RRF union trimming                                                                         |
| Candidate union document limit                                        | 60 after protecting per-query representation                                                        |
| Retrieval chunk over-fetch                                            | implementation-calibrated; enough to produce the configured number of distinct documents            |
| Anchors per document/query match                                      | 1                                                                                                   |
| Discovery serialized response limit                                   | 512 KiB                                                                                             |
| Discovery document-query signal cells                                 | 3,600 before response-size/anchor trimming                                                          |
| Discovery query/requirement assignment-state cells                    | 7,200 before response-size/anchor trimming                                                          |
| Discovery transient attempts                                          | 3 with jitter, same request digest                                                                  |
| Discovery cell-cache TTL                                              | 24 hours, plus digest-based invalidation                                                            |
| Maximum parallel work-order calls                                     | 15                                                                                                  |
| Planner transport attempts                                            | 2 total: initial plus one transient retry/failover under the same input digest                      |
| Planner syntax-repair attempts                                        | 1, only after invalid structured syntax; absolute provider-attempt cap 3                            |
| Extraction attempts                                                   | 3                                                                                                   |
| Extraction schema-repair attempts                                     | 1 within the total                                                                                  |
| Work-order lease                                                      | 120 seconds                                                                                         |
| Work-order heartbeat                                                  | 30–45 seconds                                                                                       |
| Supplemental extraction cycles                                        | 0 in pipeline version 2                                                                             |
| New-route canary                                                      | 3 envelopes                                                                                         |
| High-volume requirements per envelope                                 | 2; allow more only for bounded scalar contracts within the safe token budget                        |
| Large-inventory planner input                                         | protected-depth/rank-round-robin union plus RRF trimming; direct all-in-scope assignments excluded  |
| New documents after planning                                          | next run                                                                                            |
| Phase 2 status source                                                 | server transitions, with optional model narrative                                                   |

The safe context threshold must be derived from the selected model's advertised/configured context and a reserved output/tool budget, not one global character limit.

---

## 27. Acceptance criteria

The feature is ready for default use only when all of the following are demonstrated:

- Every Milestone M0–M10 exit gate has recorded evidence, and no real Phase 2 provider call occurred before the M8 isolated-executor milestone.
- No normal worker claim occurred before M9; every claimable order passed the single fenced activation RPC and an independent claim-time readiness/version check.
- The existing staged-v1 path remained authoritative through shadow milestones, while quarantined v2 results and publication controls prevented accidental activation.
- Fully compatible warm runs make zero discovery and planner provider calls; retrieval-backed runs complete one durable server-owned document-discovery step and produce one valid plan in no more than three provider attempts (initial, one transient retry/failover, and one syntax-only repair).
- Every nonzero retrieval-backed Phase 1 plan references a succeeded, persisted discovery request/result; 100% of planner-selected document/query/requirement triples resolve to an exact `matched` assignment-state cell, while all-in-scope assignments are server-created and separately validated.
- Compatible coverage is excluded per document × requirement before ranking, while changed source or extraction-contract fingerprints re-enter discovery.
- Coverage is scoped to the exact saved Task, silo, nullable project, Task Dataset Group, and dataset key; records in any other scope, or records without a compatible sealed assignment receipt, never suppress work.
- The planner receives a bounded coverage summary and only actionable candidates, but no stored Task Dataset record payload; a covered or concurrently in-progress mapping cannot be selected for another provider call.
- An unobserved cell has a null score and is never represented as zero, confidence, or verified absence.
- A permanent discovery failure makes no planner call and produces no claimable work order; a successful empty discovery can produce explicit unassigned requirements.
- All-in-scope-only work creates every uncovered direct assignment with zero discovery/planner calls; mixed batches keep those assignments outside planner selection.
- Candidate/assignment matrices preserve the configured protected depth for every uncovered query/requirement mapping or fail explicitly with `candidate_matrix_capacity_exceeded`; no cell is silently trimmed.
- The planner receives no Swarm, `rag_search`, `rag_documents`, Task Dataset, cache, or DOCX tool.
- The separate `rag_documents` model tool is read-only, scope-bound, parallel-safe, and covered by native-call and text-fallback tests for Ask/general Extraction.
- The planner session is closed before the first Phase 2 provider call.
- Every Phase 2 call originates from a durable worker claim.
- Every Phase 2 call contains the exact ingestion-authored extraction query, human-readable dataset title/description, strict `json_records` schema and policies, immutable source-document title, and complete verified Markdown or an explicit deterministic shard.
- The server, not the model, binds every Phase 2 result to the exact Task/silo/nullable-project Task Dataset destination and derives or validates record titles without using a title as identity.
- The parent job releases its lease while waiting and resumes exactly once after the barrier.
- Task Dataset publication custody remains renewed and fenced through a parent yield, process restart, Phase 4, and final commit without storing a plaintext lease token.
- Previously completed compatible assignments produce no provider call.
- A validated successful artifact from a failed prior run can be revalidated/imported once into a new transaction without a provider call; cancelled/late/partial artifacts cannot.
- Unselected/unobserved inventory candidates create no pending Task Dataset source claim and do not block transaction sealing or create reusable absence coverage.
- Changed source content or changed requirement semantics is reprocessed.
- A credible new source is not skipped merely because another source already produced the same record title/logical identity; post-extraction merge preserves all evidence and conflicts.
- A changed report period alone does not re-extract source documents.
- A zero-write warm run builds Phase 3 from the pinned as-of Task Dataset view, including compatible carried-forward records from earlier physical generations.
- Full Markdown is supplied or explicitly sharded; no silent truncation occurs.
- The current run reads a verified immutable Markdown/page-map object; later live edits/deletes cannot substitute different content.
- No invalid-schema response reaches the Task Dataset.
- Every material committed fact contains valid source provenance.
- A retry or process crash produces no duplicate record.
- One failed optional assignment does not erase successful assignments.
- Requirement cardinality/evidence rollups—not one candidate outcome—decide optional/required gaps, and an unsatisfied required rollup cannot publish an apparently complete trusted report.
- Cancellation stops new claims, aborts/fences active calls, releases slots, and blocks late writes.
- Task Run Queue counts equal database counts under concurrent completion.
- Every emitted model-status update fires the existing webhook pathway; server-owned phase transitions and bounded progress events are mandatory even when the model emits no status.
- No execution exceeds 15 active `template_work_order` slots, and terminal/cancelled paths leak no slot.
- Shards do not inflate logical-assignment progress, mixed-requirement envelopes settle correctly, and cancel-versus-final-settlement wakes the parent at most once.
- The golden DOCX fixtures preserve layout/assets and contain no template comments.
- Narrative segments are modeled at most once in Phase 4; Phase 3 only prepares their bounded factual packets.
- Golden record and binding accuracy meet Section 3 targets.
- `rag_documents` candidate recall is at least 98% on the approved source-selection corpus, and the 12-query reference benchmark meets the discovery p95 target.
- The typical 15-envelope and scale 30-envelope benchmarks meet their stated p95 latency targets at 15 available slots.
- The system records enough telemetry to explain any miss.

---

## 28. Final implementation principle

The extraction model should do the one thing models are best placed to do: read one bounded source and convert its meaning into a strict factual schema.

The implementation must prove the contracts, immutable inputs, reuse semantics, control plane, downstream consumers, and observability before connecting that model to a normal worker claim lane.

The server should do everything else:

- decide what identities are valid;
- resolve exact Task/silo/project coverage and withhold prior record bodies from the planner;
- discover and persist a bounded document × query candidate matrix;
- give the planning model only that matrix and validate every selection against it;
- persist the plan;
- schedule and retry work;
- control concurrency;
- compile each Phase 2 extraction query/schema/title/full-Markdown envelope and bind its trusted dataset destination;
- validate and commit records;
- apply time and aggregation rules;
- track progress;
- assemble the report;
- render the DOCX;
- recover after failure.

That separation is what turns template execution from a long-lived agent loop into a fast, observable, resumable work-order pipeline.
