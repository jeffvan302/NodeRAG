# Task Dataset Phase 5 Implementation

## Outcome

Phase 5 adds bounded parallel source refresh to the saved Task fast path. A
coordinating model can dispatch two or more focused `swarm_task` items with a
`taskDatasetKey`. The application—not either model—claims exactly one uncovered
source for each worker, gives the worker a restricted dataset context, keeps
the claim alive, verifies that the source reached a terminal state, and
reconciles completed RAG receipts before returning control to the coordinator.

The Phase 1–4 publication boundary does not change. All parallel contributions
remain staged in the one transaction shared by every step in the Task. They
publish only after every Task step and output succeeds. Task failure,
cancellation, or clear invalidates the transaction and prevents partial
parallel work from becoming active data.

## Coordinator Contract

The model-facing `swarm_task` item now accepts:

```json
{
  "id": "grant-source-1",
  "title": "Extract one grant source",
  "instructions": "Extract grant facts from the assigned source.",
  "cacheName": "grant-source-1",
  "taskDatasetKey": "grant_items"
}
```

Only `taskDatasetKey` is model-authored. Document IDs, dataset IDs, source batch
IDs, worker keys, claim epochs, and tokens are never accepted from the swarm
request. For every dataset item, the runtime:

1. verifies the saved Task context and running Task item;
2. resolves the catalog definition by its exact key;
3. calls the Phase 3 `FOR UPDATE SKIP LOCKED` claim function with `limit=1`;
4. creates a unique server worker key for that swarm run, task item, and retry;
5. binds the returned document, source batch, generation, definition revision,
   epoch, and token to that worker process; and
6. returns a clean `skipped/no_claimable_source` result without calling a model
   when no source is eligible.

The coordinator can submit more worker items than currently uncovered sources.
This is safe: extra items stop at the claim boundary. A single `swarm_task` is
bounded to 12 items; the coordinator can make another call if a larger refresh
still has uncovered documents.

## Worker-Bound Dataset Context

The worker sees only the information needed to extract one source:

- dataset key, ID, name, purpose, and extraction instructions;
- record schema, identity policy, and source policy;
- exact stable document ID plus safe file/title/date metadata;
- source batch ID, definition revision, generation, and claim epoch; and
- instructions to complete, skip, or fail that exact source.

The raw claim token remains in server memory. It is not included in the worker
prompt, tool result, cache slot, event trace, Task progress, webhook, or swarm
result. When the worker calls `task_dataset`, the executor injects the token
after parsing the tool request.

An assigned worker has only these Task Dataset operations:

- `heartbeat`;
- `upsert_many`;
- `seal_source`;
- `skip_source`; and
- `fail_source`.

It cannot inspect the catalog, create/recreate definitions, claim another
source, read unrelated records, or seal arbitrary receipts. Those are
coordinator responsibilities. Non-dataset swarm workers do not inherit the
parent Task Dataset context and do not receive `task_dataset` authority.

## Exact Lease And Epoch Fencing

Phase 5 records the last server worker key and Task run item on every source
claim. New service-role-only RPCs require the complete tuple:

```text
tenant
+ run transaction
+ dataset
+ running Task item
+ server worker key
+ source batch
+ claim epoch
+ raw claim token
+ live lease
```

`task_dataset_assert_worker_claim` is the common write/retrieval fence.
`task_dataset_heartbeat_worker_claim` extends only that exact live claim.
`task_dataset_release_worker_claim` fails and releases only that claim.
`task_dataset_worker_claim_status` lets the coordinator verify the same worker
and epoch after the model returns.

Reacquiring an expired or retryable-failed source increments `claim_epoch` and
replaces both the worker key and token. The former worker therefore loses
authority even if a delayed provider response or tool request arrives later.
All RPCs are executable only by `service_role`; `anon` and `authenticated` have
no direct execution rights.

## RAG Binding

An assigned worker may call `rag_search` without supplying Task Dataset
arguments. The executor automatically adds:

- the assigned dataset ID;
- the assigned source batch ID;
- the server worker key and running Task item from verified context; and
- the assigned stable document ID.

Postgres revalidates the exact live source claim before candidate retrieval.
The search is therefore constrained to that document before keyword/vector
ranking and Top K. If the model supplies a dataset, source batch, or document
ID that differs from the server assignment, the call is rejected before RAG.
The model cannot turn a valid worker lease into access to a neighboring source.

Returned document identities still create Phase 3 search receipts. When all
parallel workers have finished, the coordinator invokes
`task_dataset_reconcile_search_receipts`. It atomically seals every open receipt
whose document rows are all `sealed` or `not_applicable`. An incomplete receipt
stays open and continues to block publication.

## Heartbeat, Completion, And Retry

The runtime starts a four-minute heartbeat loop immediately after a source is
claimed. A heartbeat failure aborts the worker call. The timer is always
cleared when the attempt exits.

A model response is not sufficient to mark a dataset worker successful. The
coordinator reads the durable source status and accepts only:

- `sealed`; or
- `not_applicable`.

If the worker returns while the source is still claimed/processing, crashes,
or receives a recoverable provider/tool failure, the coordinator releases the
exact claim as retryable and makes one more attempt. The retry uses a new server
worker key, token, and epoch. Release deletes only the failed worker attempt's
unsealed contribution batches (and their cascading contributions), so a retry
starts with a clean batch count and cannot turn partial duplicate extraction
into a false conflict. A source that already reached a terminal state is not
retried as though it were another source.

Cancellation releases a live claim as non-retryable and the parent Task
transaction is subsequently discarded. Lease expiry is recoverable: the next
attempt can reacquire the expired row under a fresh epoch. Definition/generation
changes, a clear, an invalid Task context, and transaction invalidation are
fatal for the worker and are not retried.

The existing contribution-batch contract remains the data plane. A repeated
idempotency key with the same content returns the original result; the same key
with different content is rejected. Parallel workers never append to one JSON
blob and cannot overwrite another source's contribution.

## Separate Parallel Capacity

Swarm configuration now has `taskDatasetParallelCalls`, default `4`, bounded
from `1` through `16`. It is editable beside the normal route concurrency in
the Configuration screen.

Provider route slots still protect the underlying model endpoints. The new
limit is an additional independent semaphore applied only to workers that hold
Task Dataset source claims. Ordinary research workers do not consume it. This
allows operators to lower database/RAG write pressure without reducing all
swarm research, or raise source parallelism up to the safe claim/write bound
when provider capacity permits.

## Telemetry And Redaction

Swarm telemetry now counts:

- claims and no-source skips;
- retries and heartbeats;
- sealed, skipped, and failed sources; and
- receipts sealed by coordinator reconciliation.

Events identify the swarm run, worker, dataset key/ID, document, source batch,
epoch, attempt, and terminal state where relevant. They deliberately omit raw
claim tokens. Worker cache slots remain separate and coordinator-owned final
document creation/publication remains unchanged.

## Database And Runtime Validation

The rollback-only Phase 5 SQL smoke proves:

- every new worker RPC is service-role-only;
- two live workers receive different source documents;
- a worker cannot assert another worker's source;
- exact heartbeat extends the lease;
- recoverable release and reacquisition preserve the source but increment the
  epoch;
- stale worker authority fails after reacquisition;
- duplicate contribution batches replay idempotently;
- sealed and not-applicable parallel results are reconciled into a sealed
  receipt;
- cancellation makes the source non-retryable; and
- failed/cancelled attempts discard only their own partial batches; and
- clear reports and invalidates a live claim and transaction, after which the
  old worker cannot continue.

Runtime tests additionally prove the separate dataset-worker concurrency cap,
one-source-per-worker assignment, token redaction from prompts, clean no-source
behavior, release-and-retry orchestration, server-bound RAG arguments, and
rejection of model-authored RAG redirection.

The dev staging workflow applies the migration and runs Phase 1 through Phase 5
SQL smokes in order. The application build, complete test suite, platform
contract/checksum verification, and migration smoke must all pass before the
dev commit is treated as deployable.

## Operational Notes

- `TASK_DATASETS_ENABLED=false` or per-run bypass disables this path with the
  rest of the Task Dataset runtime.
- Lower `taskDatasetParallelCalls` first if source extraction overloads RAG,
  provider, or database capacity.
- A clear is deliberately authoritative. In-flight workers may finish their
  provider call, but their database authority is already invalid and no staged
  work can publish.
- The stable document-ID freshness rule remains unchanged. Re-ingesting a
  document under the same ID does not reopen it; clear/recreate is required.
- Cross-Task dataset access remains prohibited.

## Deferred Work

Phase 5 did not add template persistent-data planning; that is now implemented
by [Phase 6](phase_6_implementation.md). Task Dataset semantic record search
and its embedding explorer remain Phase 7. The swarm contract continues to let
template-produced dataset suggestions choose a dataset key without receiving
claim authority.
