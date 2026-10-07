# Task Dataset Phase 9 Implementation

## Outcome

Phase 9 makes the incremental fast path measurable and gives saved Tasks a
safe freshness hint before they spend model time rediscovering whether source
membership changed. It does not change the stable-document-ID coverage rule.
Instead, it adds three connected capabilities:

1. a coalesced revision signal when ready documents enter or leave a Dataset
   Group's silo/project scope;
2. a commit-safe acknowledgement of the source-scope revision actually
   inventoried by a dataset; and
3. durable, bounded RAG-exclusion metrics and a reuse-efficiency view.

The migration head is:

```text
20260826000500_task_dataset_phase_nine
```

This phase preserves the established ownership and publication boundaries:

- the group remains tenant + saved Task + silo + explicit
  project-or-no-project;
- every Task step shares one group and one run transaction;
- the model may use several definitions inside that group;
- committed stable document IDs remain the only RAG exclusion key;
- same-ID re-ingestion does not reopen coverage;
- failed or cancelled Task runs never publish an inventory acknowledgement;
- no Task can read another Task's datasets; and
- raw vectors, document text, and record payloads are absent from efficiency
  telemetry.

## 1. Why Phase 9 Exists

Phases 1–8 already prevent repeated extraction when a dataset-aware RAG search
receives a dataset ID. The search excludes committed document IDs before
ranking and Top K, and the Task Dataset transaction can add only newly returned
documents. That is the data-plane fast path.

Two operational questions remained unanswered:

- Before running an inventory, can the model tell whether the silo/project
  membership probably changed since the last successful inventory?
- After rollout, can an operator prove that old sources were excluded and
  distinguish an unchanged reuse run from an incremental refresh or rebuild?

Phase 9 answers both without making the advisory signal authoritative. The
trusted inventory query is still the final source of truth. The revision merely
lets the model choose the cheapest sensible first action and lets the explorer
explain why a refresh is recommended.

## 2. Freshness Model

### 2.1 Group-level source-scope revision

Each `task_dataset_groups` row now stores:

| Field                        | Meaning                                                  |
| ---------------------------- | -------------------------------------------------------- |
| `source_scope_revision`      | Monotonic advisory revision, beginning at zero.          |
| `source_scope_changed_at`    | Time of the most recent coalesced scope change.          |
| `source_scope_change_reason` | Ready, deleted, membership-added, or membership-removed. |
| `source_scope_document_id`   | Stable document ID associated with the latest change.    |

The revision belongs to the group, not a Task step. A four-step Task therefore
sees one freshness signal for its shared Task + silo + project/no-project
scope. Separate projects—and the explicit no-project scope—have separate
groups and revisions.

The signal is intentionally coalesced. One source event increments a matching
group once even when that group has several active definitions. Definitions
compare their own last acknowledged revision with the shared group revision,
so each definition may independently need or complete inventory.

### 2.2 Events that advance the revision

Database triggers observe authoritative source membership:

- a document becomes `ready` with no deletion marker;
- a ready document is soft-deleted or physically deleted;
- a ready document is added to a project; or
- a ready document is removed from a project.

The trigger updates only an existing, non-deleting Dataset Group that owns at
least one active definition for which the document is a meaningful addition or
removal.

For additions, a definition already holding committed or not-applicable
coverage for that stable document ID does not create a freshness change. For
removals, a definition must have that coverage before the event is relevant.
This preserves the approved rule that same-ID re-ingestion is not freshness.

### 2.3 Silo and project targeting

A ready document entering a silo can affect:

- the no-project group for that Task and silo; and
- a project group only when the document is currently a member of that exact
  project.

A project membership event affects only the matching project group. It does
not advance the no-project group because the document was already in the silo
scope. This prevents project administration from creating false refreshes for
unrelated Dataset Groups.

### 2.4 Advisory, not authoritative

The revision is an optimization hint. It does not replace
`task_dataset_inventory`, because concurrent document changes can occur while a
Task is running. The model receives both the freshness state and explicit
guidance:

- if refresh is not recommended, prefer the compiled dataset and dataset-aware
  RAG rather than rebuilding old sources;
- if refresh is recommended, inventory before assuming the dataset is
  complete; and
- if the definition is no longer sufficient for the Task instructions, clear
  and recreate it through the existing transaction-safe workflow.

## 3. Commit-Safe Inventory Acknowledgement

### 3.1 Definition checkpoint

Each definition stores:

- `last_inventory_scope_revision`;
- `last_inventory_at`; and
- `last_inventory_run_id`.

The public freshness decision is:

```text
refreshRecommended =
  last_inventory_at is absent
  OR group.source_scope_revision > definition.last_inventory_scope_revision
```

Existing active definitions are migrated with a revision-zero inventory
baseline so rollout does not force every established dataset to rebuild.
Newly created definitions have no committed inventory timestamp and therefore
recommend inventory on their first run.

### 3.2 Stage first, publish last

Calling the model tool's `inventory` operation now captures the group's source
revision immediately before the authoritative inventory RPC. After inventory
returns, the runtime stages one acknowledgement in
`task_dataset_inventory_acknowledgements` for:

- tenant, group, and definition;
- run transaction;
- Task run and optional Task run item; and
- observed source-scope revision.

Repeated acknowledgement within the same transaction is idempotent and retains
the greatest valid observed revision. A caller cannot acknowledge a future
revision or a dataset outside the verified write context.

The definition checkpoint is not updated at this point. An `AFTER UPDATE`
trigger promotes acknowledgements only when the owning run transaction enters
`committed`. The existing Task Dataset commit occurs only after every Task item
and output succeeds. Consequently:

- a successful Task publishes the checkpoint atomically with its dataset work;
- a failed or cancelled Task leaves the previous checkpoint intact;
- discarding a run never suppresses a later refresh; and
- a subsequent run cannot mistake partially inventoried data for completeness.

The acknowledgement rows are internal transaction evidence and are deleted
with the owning transaction/group/definition lifecycle.

### 3.3 Concurrent changes during inventory

The inventory tool response reports both the observed revision and the current
revision after inventory. If they differ, `scopeChangedDuringInventory` is
true and refresh remains recommended. The Task may inventory again in the same
transaction. Even if it does not, commit publishes only the observed revision;
the next run still sees the later group revision and is instructed to refresh.

This avoids locking document ingestion for the duration of a potentially long
model extraction.

## 4. RAG Reuse Measurement

### 4.1 Receipt metrics

Every dataset-aware `rag_search` already creates a search receipt containing
the returned stable document list. Phase 9 adds the following bounded fields to
that receipt:

- excluded document count;
- candidate document count;
- total retrieval duration in milliseconds;
- normalized retrieval mode; and
- metrics-recorded timestamp.

The runtime derives these values from the actual RAG result after pre-ranking
Task Dataset exclusion. It records them against the same receipt and verified
run transaction before returning the tool result to the model.

The metric RPC is idempotent. Replaying exactly the same values returns
`recorded: false` and does not double-count run telemetry. Reusing the receipt
with different metrics fails as an idempotency conflict. Counts and durations
have strict upper bounds, and retrieval modes use a small normalized identifier
grammar.

### 4.2 Run telemetry

The first metric write also updates the established bounded
`task_dataset_run_usage` row with:

- `rag_search` call count and duration;
- excluded documents;
- returned documents;
- candidate documents; and
- zero-result searches.

This connects the receipt-level audit trail to the per-run operational summary
without creating a second unbounded event log.

### 4.3 What the metrics mean

An excluded document is a stable ID already represented by committed or
not-applicable coverage for this definition. It is a direct measurement of
source work the RAG pipeline did not return to the model on this search. It is
not an estimated token, provider-cost, or wall-clock saving.

`ragReusePercent` is therefore calculated as:

```text
excluded / (excluded + returned) * 100
```

when that denominator is non-zero. It communicates document-level reuse, not a
claim that every document would have consumed equal model time.

## 5. Efficiency Dashboard

### 5.1 Bounded query

`task_dataset_efficiency_dashboard` accepts one tenant, group, active dataset,
and a window from 1 to 365 days. The default API window is 30 days. It returns
at most 20 recent run rows and database aggregates rather than raw receipt,
record, contribution, or embedding rows.

The response has five sections:

- `scope`: group, dataset, key, and window;
- `freshness`: revision/checkpoint state and refresh recommendation;
- `totals`: measured runs, classifications, RAG reuse, processed documents,
  records, calls, and duration;
- `readiness`: operational interpretation and active covered-document count;
  and
- `recentRuns`: bounded per-transaction classifications and counts.

### 5.2 Run classification

Committed measured transactions are classified as:

| Classification             | Interpretation                                                |
| -------------------------- | ------------------------------------------------------------- |
| `unchanged_reuse`          | No fresh source work; existing coverage excluded old sources. |
| `incremental_refresh`      | New/not-applicable sources plus measurable old-source reuse.  |
| `initial_build_or_rebuild` | Source work with no measurable prior-source reuse.            |
| `read_only`                | Measured access without source work or exclusion evidence.    |

Non-committed transactions retain their publication state in the recent-run
classification. Success totals include only committed metrics, so an abandoned
run cannot inflate the reported benefit.

The dashboard may include a committed pre-Phase-9 transaction when it contains
source or usage rows in the selected window. Its missing RAG fields contribute
zero rather than being invented.

### 5.3 Readiness states

The top-level readiness state is one of:

- `refresh_recommended`: the definition has no committed inventory or its
  checkpoint trails the group revision;
- `ready_without_measured_history`: current, but no measured runs fall inside
  the requested window;
- `ready_with_measured_reuse`: current and exclusions or covered inventory have
  been observed; or
- `ready_measurement_collecting`: current, with telemetry present but no reuse
  evidence yet.

`metricsAvailable` distinguishes no history from zero reuse. The response
explicitly reports `vectorsExposed: false`.

## 6. Model Tool Contract

The Task Dataset catalog and `describe` result now include, per definition:

- source-scope revision and most recent change diagnostics;
- acknowledged inventory revision, time, and Task run;
- whether the current run has already staged an inventory acknowledgement; and
- `refreshRecommended`.

The tool instructions emphasize that Task Datasets should be used for reusable
retrieval and in conjunction with dataset-aware RAG. The model remains free to
choose definitions that fit the Task and may clear/recreate an insufficient
definition. It may not silently widen ownership, share across Tasks, or treat
the revision as permission to skip an explicitly requested rebuild.

Inventory responses include a concise recommended next action:

- use the compiled dataset when the checkpoint is current;
- process only pending/new sources when inventory found them; or
- repeat inventory when source membership changed during the call.

## 7. API Surface

### Public API

```text
GET /api/v1/task-dataset-groups/{groupId}/datasets/{datasetId}/efficiency
```

The route requires `task-datasets:read`. Optional `windowDays` must be between
1 and 365. The caller's tenant is always injected server-side; group/dataset
scope is validated in the database.

The response is:

```json
{
  "efficiency": {
    "scope": {},
    "freshness": {},
    "totals": {},
    "readiness": {},
    "recentRuns": [],
    "measuredAt": "2026-08-26T00:00:00.000Z"
  }
}
```

### Internal operator API

The existing `/api/task-datasets` control-plane endpoint accepts
`view=efficiency`, `groupId`, `datasetId`, and optional `windowDays`. It uses the
same database result as the public endpoint and does not maintain a separate
interpretation of reuse.

## 8. Operator Explorer

The top-level Task Datasets page adds **Reuse & freshness** after selecting a
silo, Task, group, and definition. It shows:

- current source-scope and last-inventory revisions;
- last scope change and committed inventory time;
- refresh recommendation/readiness;
- measured, unchanged, incremental, and rebuild run counts;
- excluded, returned, and fresh document totals;
- document-level RAG reuse percentage; and
- a bounded recent-run list.

The explorer is diagnostic. It does not acknowledge freshness, mutate records,
rerun Tasks, or clear definitions. Existing clear/rebuild controls remain
separate and explicitly destructive.

## 9. Security and Data Minimization

The acknowledgement table and all Phase 9 RPCs are service-role-only. `anon`
and `authenticated` receive no direct table or function access. Public API
access still passes through API-key scope enforcement.

Efficiency output excludes:

- record payloads and summaries;
- search text and matched RAG text;
- document pages/chunks;
- evidence values;
- embeddings and vectors;
- worker leases, claim tokens, and publication tokens; and
- model prompts or generated output.

It retains stable document IDs only for the most recent scope-change diagnostic
and existing receipt/source relations. The aggregate response exposes counts,
bounded timings, states, and transaction IDs needed for operations.

## 10. Backup, Restore, and Deletion

Freshness columns live on durable group and definition rows and therefore
follow their normal portable backup lifecycle. Receipt metrics follow search
receipts. The transaction acknowledgement table is rebuildable coordination
state and is excluded from portable backup.

Dataset/group clear and asynchronous Task deletion remove acknowledgements via
the existing foreign-key lifecycle. The deletion worker does not need a new
independent purge queue. Source change triggers ignore deleting and
purge-failed groups so source ingestion cannot revive a group during cleanup.

## 11. Failure and Recovery Semantics

- A source-scope trigger failure aborts the source membership mutation rather
  than silently losing freshness state.
- An invalid or future inventory revision is rejected.
- A failed acknowledgement call stops that model tool operation; it cannot
  claim freshness without staging evidence.
- A failed Task transaction never advances the definition checkpoint.
- A RAG metric write failure leaves the Task transaction uncommitted and is
  visible as a tool failure; exact retries are safe.
- Dashboard failure has no write effect and does not block Task execution.
- A stale checkpoint never removes coverage. It only recommends an inventory.
- Clearing a dataset remains the explicit route when task instructions or data
  design change fundamentally.

## 12. Rollout and Verification

The existing installation-level Task Dataset bypass remains the rollback
switch. Bypass prevents the Task Dataset runtime from participating in the
saved Task; Phase 9 does not add a second per-Task opt-in.

The staging deployment gate now applies Phase 9 and runs Phase 1 through Phase
9 SQL smoke suites. The Phase 9 smoke proves:

- RPCs and acknowledgement storage are service-role-only;
- a new ready document advances one coalesced revision;
- same-ID metadata changes do not advance the revision;
- staged and discarded acknowledgements do not alter the definition;
- a committed transaction publishes the acknowledged revision/run/time;
- RAG metric writes are exact-retry idempotent and reject conflicting replay;
- reuse totals and incremental classification are correct; and
- dashboard output contains no embeddings, search text, or raw vectors.

Application tests additionally verify that dataset-aware RAG passes actual
exclusion, candidate, timing, and retrieval-mode metrics into receipt storage.
The normal release gate covers unit tests, lint, type checking, production
build, documentation checks, a fresh local migration reset, SQL lint, and all
prior Task Dataset regressions.

## 13. Acceptance Criteria

Phase 9 is complete when:

1. a new stable document ID in scope sets `refreshRecommended` without scanning
   document content;
2. same-ID re-ingestion leaves the signal unchanged;
3. one successful inventory makes the definition current only after the entire
   Task commits;
4. failure/cancellation retains the prior checkpoint;
5. dataset-aware RAG records actual exclusions without duplicate counting;
6. operators can distinguish unchanged reuse, incremental refresh, and rebuild
   behavior over a bounded window;
7. public/API scope isolation remains tenant-safe; and
8. no raw vectors or source content enter the metrics view.

## 14. Deliberate Deferrals

Phase 9 does not add:

- cross-Task dataset sharing or reads;
- same-ID re-ingestion refresh;
- content-digest-driven automatic invalidation;
- automatic model-authored dataset partitioning;
- automatic physical table partitioning;
- conflict-winner mutation;
- estimated token/currency savings presented as fact; or
- automatic Task execution triggered by a source-scope revision.

Those remain separate product or scaling decisions. Phase 9 supplies the
measurements needed to make future decisions without weakening Task-private
ownership or transaction-atomic publication.
