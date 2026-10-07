# Task Dataset Phase 4 Implementation

## Outcome

Phase 4 connects the Phase 1–3 storage and model-tool contracts to the saved
Extraction Task runtime. A Task run now owns one Task Dataset publication
transaction for its full `(tenant, task, silo, optional project)` group. Every
sequential Task item shares that transaction and sees active records plus its
run's staged records. Successful outputs and dataset changes publish together;
failure or cancellation discards every staged definition, receipt, source,
contribution, record, and usage publication state.

The feature is available by default for saved Tasks. Set
`TASK_DATASETS_ENABLED=false` for the rollout kill switch, or pass
`taskDatasetMode: "bypass"` in a run's requested configuration for a single
run. Standalone Extraction/Ask calls do not receive Task Dataset authority.

## Verified Internal Handoff

The Task coordinator opens the database transaction and receives the raw
publication lease token. Immediately before invoking an Extraction Task item,
it creates a short-lived context containing the exact tenant, group,
transaction, Task run, Task item, silo, optional project, and server-owned
worker key. The context is HMAC-signed with the publication lease digest and
transported in internal-only request headers. The raw lease token remains only
in coordinator memory and is never transported to the Extraction route.

The Extraction route rejects a partial, expired, scope-mismatched, or
incorrectly signed handoff. It loads the database-held lease digest as the
verification key, checks that the transaction is still open/non-bypass, and
checks that the publication lease still belongs to that transaction and has not
expired. Request-body Task IDs never grant Task Dataset access. Only after
verification does the route construct
`TaskDatasetToolContext`, expose `task_dataset`, and accept dataset-aware RAG
arguments.

## Catalog And Model Guidance

Every verified Task item receives compact guidance before the first model call:

- why durable Task-specific records should be preferred over repeating old
  retrieval/formatting;
- the active-plus-current-transaction catalog, including each definition's
  key, ID, revision, state, description, and recommended use;
- the inventory → claim → retrieve → upsert → seal workflow;
- the `taskDatasetId` pre-ranking exclusion behavior;
- the `sourceBatchId` exact-claim fence;
- conflict/date preservation and untrusted-data rules; and
- the all-items atomic publication requirement.

The model may create a focused definition when no suitable definition exists,
or recreate an insufficient definition with a complete replacement contract.
It should not create a dataset merely because storage is available.

## Dataset-Aware RAG Contract

`rag_search` accepts two additional arguments only in a verified saved Task:

| Argument        | Behavior                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskDatasetId` | Selects a definition from the injected catalog. Stable document IDs previously committed as `committed` or `not_applicable` for that physical dataset are anti-joined before keyword/vector candidate ordering and Top K. |
| `sourceBatchId` | Optional ID returned by `task_dataset.claim_sources`. It must belong to the same transaction, dataset, running item, worker, and live claim lease. Retrieval is fenced to that one source document.                       |

Postgres revalidates the transaction, definition, group, running item, worker,
and optional claim for every dataset-aware candidate call. The keyword RPC
joins chunks to the eligible-document anti-join before applying its candidate
limit. The vector RPC joins embeddings to the same eligible-document function
before vector-distance ordering and Top K. Therefore covered documents cannot
consume candidate/ranking capacity and are not sent to the application as a
large exclusion UUID list.

Re-ingesting content under the same stable document ID does not invalidate
coverage. A deliberate clear/rebuild or recreated physical dataset is required
to consider that stable ID again, matching the approved freshness policy.

## Search Receipts And Document Summaries

After each dataset-aware RAG query, the runtime deduplicates the document IDs
that actually appear in returned matches and creates a Phase 3 search receipt.
No page numbers are used for coverage. A zero-result receipt is sealed
immediately. A non-empty receipt remains open until every returned source has
been sealed or marked not applicable; an incomplete receipt blocks transaction
sealing.

The model-facing result includes:

- `datasetFilter.datasetId` and optional `sourceBatchId`;
- `excludedDocumentCount`;
- up to 100 excluded document summaries containing only stable document ID,
  file name, title, coverage state, and dataset-added date;
- `excludedSummaryTruncated` when more excluded documents exist; and
- `taskDatasetReceipt` with the receipt ID, returned-document count, expiry,
  and current open/sealed state.

The exclusion summary is intentionally document-only. It contains no pages,
chunks, or passage text and is bounded independently from the RAG match result.

## Task-Run Transaction Lifecycle

The coordinator performs this sequence:

1. Resolve mode (`auto`, `rebuild`, or `bypass`) and open one transaction for
   the Task run before item execution.
2. Start a background lease renewal every four minutes for the 15-minute
   publication lease; also renew immediately before each item and publication.
3. Mark each item running and generate its fresh signed handoff.
4. Run every Task item against the shared transaction/catalog/overlay.
5. Require every item/output to be persisted successfully.
6. Seal the transaction, checking sources, receipts, and batches for
   completeness.
7. Commit the target generation and then mark/send Task success.
8. On model failure, output failure, coordinator exception, lease failure, or
   cancellation, discard the open/sealed transaction instead.

The Task run's `progress.taskDataset` exposes mode, publication state, group,
transaction, base/target generations, and lease expiry. Task webhooks include
that same summary. Raw claim and publication lease tokens are never included in
progress, traces, results, or webhooks.

## Scope And Multi-Step Behavior

The database group remains exactly:

```text
tenant + task + silo + optional project
```

No-project and project-scoped runs are different groups. A four-step Task on
one group uses one transaction, so step one can assemble/update structured
datasets and later steps can search/read that staged overlay to build reports.
No cross-Task dataset access is introduced.

## Validation And Deployment

The Phase 4 SQL smoke is rollback-only and proves:

- every new RAG RPC is executable only by `service_role`;
- a previously covered document is absent from eligible documents;
- the bounded excluded summary reports that stable ID without page data;
- the covered document cannot enter keyword candidates;
- the covered document cannot enter vector candidates before distance ordering
  or Top K;
- a live `sourceBatchId` fences candidates to exactly one claimed document;
  and
- a different worker cannot use that claimed batch.

Unit coverage verifies default/explicit bypass modes, the rollout kill switch,
native Task Dataset gating, and the new native RAG argument contract. The dev
staging workflow applies migrations and runs Phase 1, 2, 3, and 4 SQL smokes in
order. Application rollback can disable runtime use while leaving the additive
schema in place; schema corrections after data exists must be forward-only.

## Deferred Work

Phase 4 deliberately did not add cross-Task sharing or swarm-wide parallel
source processing. [Phase 5](phase_5_implementation.md) now reuses the live
`sourceBatchId`, worker key, claim epoch, and transaction overlay contracts for
bounded parallel workers without changing the saved Task fast path described
here. Cross-Task sharing remains out of scope.
