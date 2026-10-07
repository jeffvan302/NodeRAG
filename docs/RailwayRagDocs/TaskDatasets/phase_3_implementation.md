# Task Dataset Phase 3 Implementation

Phase 3 turns the durable/read-only Task Dataset foundation into a staged
model-write plane. It provides source leases, bounded idempotent batches,
receipt completion, active-plus-current-run record materialization, native and
JSON-loop tool contracts, recoverable model errors, and redacted telemetry.

It does not yet open these transactions from saved Task execution or alter RAG
candidate ranking. Phase 4 remains responsible for verifying the internal Task
handoff, opening and committing the shared transaction, injecting the catalog
and efficiency guidance, and applying committed-document exclusion inside RAG
before ranking and Top K.

## Delivered Boundary

Implemented:

- provider-neutral `task_dataset` request schemas and payload validation in
  `@bubble-rag/rag-core`;
- JSON-envelope parsing for providers using the text tool loop;
- conditional native function exposure for OpenAI OAuth, capable Ollama, and
  supported OpenAI-compatible providers;
- a server-bound tool context containing tenant, group, Task run, Task run
  item, transaction, worker, provider, and model identity;
- model operations for catalog, create, recreate, describe, inventory,
  coverage, claim, heartbeat, skip, upsert, source seal, receipt seal, fail,
  source-document paging, overlay list/search, and record get;
- service-only database operations for the same staged write lifecycle;
- server-only dataset-aware RAG receipt creation and expiry completion;
- stable-document-ID-only completed-source summaries;
- deterministic payload validation, identity derivation, summaries, and
  full-text projections before a model record reaches SQL;
- idempotent batch replay with a hard conflict for key reuse with different
  content;
- affected-identity run-overlay materialization, deletion markers, and atomic
  record-head publication;
- source-preserving, dated conflict variants rather than cross-source
  last-writer-wins;
- per-dataset operation counts and bounded duration telemetry; and
- claim, lease, and cursor redaction from model traces and Ask event previews.

Deferred deliberately:

- automatic signed Task execution context creation and verification (Phase 4);
- transaction open/renew/seal/commit/discard calls in the saved Task
  coordinator (Phase 4);
- automatic catalog/ultra-retrieval guidance injection into saved Tasks
  (Phase 4);
- the `rag_search(taskDatasetId)` argument, pre-ranking database anti-join,
  returned/excluded document-only response summary, and automatic receipt
  attachment (Phase 4);
- retrieval fencing through `sourceBatchId` (Phase 4/5);
- parallel swarm claim assignment (Phase 5);
- template persistent-data suggestions (Phase 6); and
- semantic/vector Task Dataset record search (Phase 7).

The distinction matters operationally. Phase 3 is callable only when trusted
server code supplies a `TaskDatasetToolContext`. No standalone Ask or
Extraction request can activate it by submitting Task or transaction UUIDs.
The existing production call sites do not yet create that context.

## Trusted Tool Context

The model-facing schema has no tenant, Task, silo, project, group,
transaction, Task-run-item, or authoritative worker fields. The runtime binds:

```text
tenantId
groupId
runTransactionId
taskRunId
taskRunItemId
workerKey
provider
model
```

Every invocation first confirms that the transaction is open, belongs to the
same tenant/group/Task run, is not in bypass mode, and—when present—that the
run item belongs to the run. Every write RPC repeats the important
tenant/group/transaction/generation checks in Postgres. Phase 4 will produce
this context only after verifying the saved Task handoff; Phase 3 does not
trust request-body linkage.

Native exposure has a second guard: `task_dataset` is sent to a capable model
only when both the run's allowed-tool set contains the name and a trusted
context exists. The JSON-loop dispatcher still refuses execution without the
context. This preserves the settled rule that standalone Ask and Extraction
cannot spoof a saved Task.

## Definition Creation And Recreation

`create` validates the complete bounded definition contract and stages it in
the already-open run transaction. The service computes the semantic digest;
the model does not supply it. Creator Task item, provider, and model are stored
for review.

`recreate` requires:

- an existing logical dataset key;
- the same key in the replacement contract;
- a complete replacement definition; and
- a bounded reason.

The replacement receives a new physical dataset ID and the next definition
revision. Inventory therefore sees no committed coverage for that new ID and
requires every current stable document ID to be reconsidered. The old active
definition remains visible to other runs until the complete Task transaction
commits. Discard removes the staged replacement.

Compatible metadata-only `revise` is not exposed by the Phase 3 model schema.
The existing operator API can still revise name/description optimistically.
Adding transactional model metadata revision later must not copy or rewrite a
large record framework merely to change a label.

## Source Claim Protocol

`task_dataset_claim_sources` validates the open write context, then selects at
most 16 eligible source snapshots using `FOR UPDATE SKIP LOCKED`. Eligible
states are:

- `pending`;
- a retryable `failed` source below the attempt ceiling; or
- `claimed`/`processing` with an expired lease.

For every selected source the function:

1. creates a cryptographically random opaque token;
2. stores only its SHA-256 digest;
3. binds the claim to the exact transaction, dataset, generation, source,
   stable document ID, Task run item, and worker;
4. increments claim epoch and attempt count;
5. sets a 30-3,600 second lease; and
6. returns the raw token once with bounded source metadata.

The returned `sourceBatchId` is the opaque source snapshot ID reserved for the
Phase 4/5 RAG inclusion fence. It does not grant retrieval authority by itself.

Heartbeat, skip, upsert, seal, and fail all require the current raw token,
worker, and run item. A stale worker fails after expiry/reacquisition because
the stored token digest and claim epoch changed. Tokens, token digests, and
lease tokens are never written to model traces or user-visible Ask event
previews.

`skip_source` is valid only for `relevance_gate` definitions and requires a
bounded reason code and explanation. `all_in_scope` sources cannot be skipped.
`fail_source` clears claim authority, records a bounded error, and can either
leave the source retryable or advance it to the attempt ceiling. Failed source
coverage prevents transaction sealing.

## Record Validation And Idempotent Batches

The web runtime performs the model-facing validation and derivation layer:

- strict operation schema validation;
- maximum 100 records and 1 MiB per model batch;
- maximum 128 KiB JSON payload per record;
- maximum 50 evidence items and 64 KiB evidence per record;
- bounded JSON Schema subset validation;
- rejection of undeclared/prohibited object fields;
- finite number and scalar-bound validation;
- deterministic, group/dataset-namespaced identity derivation;
- server-derived logical key, dedupe hash, canonical payload hash;
- summary projection from declared `summaryPaths`; and
- search text from declared `searchablePaths`.

Invalid items return per-item errors. Valid items can still be stored in the
same request. The model never controls the derived hashes. A duplicate identity
inside one batch is rejected so source-local ordering cannot silently choose a
winner.

The SQL batch function revalidates the lease, transaction, generation, Task
run item, worker, byte/record bounds, hashes, and optional receipt linkage. Its
unique key is `(source_snapshot_id, idempotency_key)`:

- same key + same canonical request hash returns the stored result with
  `idempotentReplay=true`;
- same key + different hash returns `task_dataset_batch_conflict`; and
- a corrected request must use a new idempotency key.

Within one claimed source, a later accepted contribution for the same
deterministic identity supersedes its earlier staged contribution. Across
different sources, contributions stay independent.

## Source Sealing And Run Overlay

`seal_source` validates the live claim and the exact expected accepted-batch
count. A zero-record source requires a reason. The operation then atomically:

1. changes the source to run-local `sealed`;
2. clears its claim authority;
3. marks matching receipt documents sealed;
4. finds every logical identity contributed by this source or previously
   supported by an older snapshot of the same stable document ID;
5. rematerializes only those affected identities; and
6. updates bounded source/group staging counts.

The materializer reads an overlay of:

```text
active contributions
- active contributions owned by a document replaced/removed in this run
+ contributions from sources sealed in this run
```

It does not copy unchanged records into the target generation. For every
affected dedupe hash it writes one staged record head with a stable sequence,
revision, primary deterministic payload, source count, conflict state, and
conflict-variant metadata. If no contribution remains, it writes a staged
deletion marker with zero sources. Overlay list/search returns staged heads,
then active heads not shadowed by staged heads, and hides deletion markers.

Inventory-created `removed` snapshots require no model call.
`task_dataset_materialize_removals` rematerializes their affected identities
using the same overlay rule.

## Conflict Preservation And Dates

`preserve_conflicts` remains the only merge mode in this phase. Contributions
with the same logical identity and distinct canonical payload hashes create a
conflicted materialized record. Full `get` responses expose
`conflictVariants`; bounded list/search responses return only
`conflictVariantCount`. Each full variant retains its payload plus:

- stable source document ID;
- filename and optional title;
- source document date and date kind;
- dataset-added/commit timestamp after publication.

Evidence remains available through bounded contribution provenance reads; it
is not duplicated into every materialized conflict variant.

The materialized primary payload is selected deterministically for bounded
list projection; it is not an assertion that one conflicting source is true.
Full reads expose all variants so the report model can use documented dates
and context. Publication recalculates variant metadata after contributions
receive their commit timestamp.

## Search Receipts And Document Summary

`task_dataset_create_search_receipt` is server-only. It accepts a canonical
request hash and the unique documents actually returned by trusted RAG code.
It re-resolves every document against the authoritative group scope and rejects
covered or out-of-scope IDs. It creates missing target-generation source
snapshots and stores a receipt-document row containing only stable document
identity, filename/title, diagnostic fingerprint, and completion state.

The model links an accepted batch with `datasetSearchReceiptId`. Source seal or
skip updates matching receipt documents. `seal_search_receipt` is all-or-none:
if any returned document is not `sealed` or `not_applicable`, it writes nothing
and returns the exact bounded pending document list as a recoverable payload.
If complete, it seals the receipt only inside the current run.

Phase 1's final transaction commit is still the only operation that changes a
sealed receipt/source to committed coverage. Failure/discard deletes or marks
the staged objects without adding a future exclusion.

`task_dataset_completed_document_page` provides the future RAG exclusion and
model `source_documents` summary. It returns one latest committed or
not-applicable row per stable document ID, with identity/date fields and an
exact count. It contains no page numbers, ranges, chunks, excerpts, or evidence
text.

Phase 4 will call this receipt bridge from dataset-aware RAG and apply the
anti-join directly inside keyword/vector/hybrid candidates before ranking.
Phase 3 does not send a large UUID exclusion array from Node and does not filter
an already-ranked Top K result.

## Publication Semantics

Phase 3 adds publication guards without weakening Phase 1's one coordinator
commit:

- when a sealed/not-applicable/removed replacement source publishes, the prior
  snapshot and its source-owned active contributions are superseded;
- when a staged record head publishes, the previous active head for the same
  dataset/dedupe hash is superseded;
- a staged deletion marker becomes superseded rather than active; and
- conflict variants are refreshed after new contributions have their commit
  timestamps.

Unchanged record heads and contributions are not rewritten. Recreated
definitions use a new physical dataset namespace; the old definition becomes
superseded only at successful publication. All Task items must still succeed
before the coordinator can commit, and any Task failure still discards the
complete staging transaction.

## Recoverable Errors

Model-correctable failures are tool results, not agent-loop failures:

```json
{
  "ok": false,
  "error": {
    "code": "task_dataset_claim_expired",
    "message": "The claim is absent, expired, or was reacquired.",
    "dataWritten": false,
    "nextStep": "Refresh inventory and claim the source again; do not reuse the old claim."
  }
}
```

This applies to argument/schema errors, missing identity, stale generation,
invalid/expired claims, idempotency conflicts, policy violations, missing
datasets, and incomplete receipts. Unknown storage failures, corruption, and
database unavailability remain fatal because retrying model arguments cannot
repair them.

## Telemetry And Redaction

Every dataset-specific tool operation attempts to cumulatively update its
run/item usage row with:

- operation call count;
- total and maximum duration;
- bounded accepted/rejected/read/claim/seal/failure counts; and
- staged publication state inherited from the run transaction.

Telemetry is written after the operation and cannot turn a completed staged
write into a model retry. The model still receives its live claim token because
it must use it on the next call. The separately persisted trace/event preview
recursively replaces claim tokens, lease tokens, and signed cursors with
`[REDACTED]`. Database errors also redact token-shaped 64-character values.

## Limits

| Boundary                                |                   Phase 3 value |
| --------------------------------------- | ------------------------------: |
| Definitions per group                   |                              12 |
| Claims returned per call                |                              16 |
| Concurrent/retry source attempt ceiling |               8 attempts/source |
| Claim lease                             |   30-3,600 seconds; 900 default |
| Model records per batch                 |                             100 |
| SQL hard records per stored batch       |                             100 |
| Batch JSON bytes                        |                           1 MiB |
| Record payload bytes                    |                         128 KiB |
| Evidence entries per record             |                              50 |
| Evidence bytes per record               |                          64 KiB |
| Source/list page                        |                             200 |
| Record/list response                    |                         512 KiB |
| Receipt returned documents              |                             100 |
| Receipt lifetime                        | 60-3,600 seconds; 1,800 default |

## Validation

The Phase 3 rollback-only SQL smoke proves:

- every model-write/receipt/read RPC is service-role-only;
- trusted receipt creation stores exactly the returned stable document IDs;
- `SKIP LOCKED` claims and claim epochs provide exclusive ownership;
- same-content retries replay and changed-content idempotency-key reuse fails;
- an incomplete receipt seals nothing;
- two source payloads for one identity remain two conflict variants;
- the active-plus-run overlay exposes the conflicted logical record;
- telemetry records operation count and duration without a token;
- Task commit publishes one record head and two source IDs atomically;
- adding two documents inventories only those two IDs;
- an expired claim is reacquired and its late worker cannot heartbeat;
- the relevant new document adds a third dated variant;
- an irrelevant document commits as `not_applicable` through the relevance
  gate; and
- second publication supersedes the affected head without copying/duplicating
  unchanged records.

The Phase 1 and Phase 2 SQL smokes also pass after the Phase 3 migration. Unit
tests cover bounded JSON payload validation, tool-operation parsing,
server-owned authority fields, deterministic batch preparation, per-item
failure behavior, trace redaction, native-context gating, serialized native
writes, and JSON-envelope parsing.

On every `dev` push that changes Supabase, the staging deployment workflow
serializes schema publication and runs the Phase 1, Phase 2, and Phase 3 SQL
smokes against staging after migration. A failed migration or smoke fails the
deployment job. The tests are transaction-local and always roll back.

The migration is additive and remains inert unless trusted server code supplies
the Phase 3 context. Application rollback can therefore omit that context and
leave the schema in place. Once dataset data exists, operators should use a
forward corrective migration instead of down-migrating these tables.

Hosted Supabase can retain explicit default `anon` and `authenticated`
function grants even after `PUBLIC` is revoked. The forward access-repair
migration therefore revokes all three principals explicitly and re-grants only
`service_role`; the staging smoke verifies that boundary after every deploy.

## Phase 4 Entry Point (Implemented)

Phase 4 consumes these contracts rather than adding a second write path. Its
implemented runtime is documented in
[`phase_4_implementation.md`](./phase_4_implementation.md). It:

1. verify the signed internal saved-Task execution handoff;
2. open one group transaction at Task-run start and share it across every
   sequential item;
3. supply `TaskDatasetToolContext` and add `task_dataset` to allowed tools only
   for that verified run;
4. inject the compact catalog plus ultra-retrieval efficiency guidance;
5. add trusted `taskDatasetId` and `sourceBatchId` arguments to retrieval;
6. anti-join committed stable document IDs inside all RAG candidate queries
   before ranking/Top K;
7. create receipts from newly returned document IDs and include bounded
   excluded/returned document-only summaries;
8. renew the publication lease while Task/model work is active; and
9. seal/commit only after every output succeeds, otherwise discard.
