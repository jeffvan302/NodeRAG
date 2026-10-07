# Task Datasets — Phase 1 Implementation

> Status: implemented on the `dev` track
> Migration: `20260825000100_task_dataset_phase_one`
> Scope: persistence, stable source identity, fencing, atomic publication,
> shared identity hashing, and backup/restore classification

Phase 1 establishes the durable and concurrency-safe substrate. It deliberately
does not expose a model tool or public API yet. Later phases can build read,
write, RAG-exclusion, Task orchestration, purge, vector-search, and operator UI
behavior on one tested transaction contract instead of inventing persistence
inside each feature.

## Delivered Boundary

Phase 1 adds:

- a generated SHA-256 digest on canonical Markdown for diagnostics;
- one Task Dataset Group per exact Task+silo+explicit-project-or-no-project
  execution scope;
- durable definition, source coverage, search receipt, contribution,
  materialized record, usage, and purge-job storage;
- service-role RLS and cross-table tenant/scope validation triggers;
- a group publication lease bound to the exact run transaction that owns it;
- monotonically increasing group generations used as stale-writer fences;
- trusted, server-side document-ID inventory with bounded paging;
- Task-run transaction open, lease renewal, seal, atomic commit, and discard
  RPCs;
- canonical JSON, JSON-pointer resolution, normalized logical identity, and
  namespaced SHA-256 utilities shared by web and worker code;
- portable backup ordering for committed Task Dataset content and restore-time
  interruption of noncommitted execution state;
- platform resource, migration-head, checksum, and secret-redaction contract
  updates.

Phase 1 does not add:

- the `task_dataset` model tool;
- automatic Task lifecycle integration;
- the `taskDatasetId` argument or pre-ranking exclusion in `rag_search`;
- definition/read/clear HTTP routes;
- claim, heartbeat, batch-upsert, or source-seal model operations;
- cursor signing, full-text API reads, record vector embeddings, or hybrid
  dataset search;
- the purge worker or Task deletion coordinator;
- the Task Datasets operator tab;
- template-ingestion suggestion generation.

Those omissions are intentional phase boundaries, not changes to the approved
proposal.

## Stable Source Identity

`document_id` is the coverage key. Inventory treats a document as already
covered when the active dataset has a committed or `not_applicable` source
snapshot for that stable ID, regardless of later content changes.

`document_markdown.content_sha256`, original-file SHA-256, and the combined
observed fingerprint are retained for evidence and diagnostics. They do not
reopen coverage. Re-ingesting a document under the same ID therefore remains a
zero-formatting path until the dataset/group is explicitly cleared or recreated
in a later phase.

Inventory is server-owned. It derives current candidates from the group scope:

- a project-scoped group uses `document_project_memberships`;
- a no-project group covers every ready document in its silo;
- a new stable ID stages one `pending` source snapshot in the current run;
- a committed stable ID returns `covered` or `not_applicable` without staging a
  replacement;
- a formerly covered ID no longer in scope stages a `removed` disposition;
- results are ordered by UUID and bounded to at most 500 rows per call.

The receipt-document table stores one row per returned stable document ID with
file name/title summary and optional diagnostic fingerprint. It intentionally
has no page or chunk child table; detailed evidence belongs to contributions.

## Persistence Inventory

| Table                                   | Phase 1 responsibility                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `task_dataset_groups`                   | Exact Task+silo+project/no-project identity, active generation, counts, state, and publication lease                |
| `task_dataset_run_transactions`         | One Task-run staging/publication boundary and authoritative commit/discard history                                  |
| `task_dataset_definitions`              | Model-facing description, schema, identity/source/search/merge policy, semantic digest, revision, and origin        |
| `task_dataset_source_snapshots`         | Stable-document-ID evaluation, coverage state, diagnostic hashes, source dates, claim fields, and commit provenance |
| `task_dataset_search_receipts`          | Dataset-aware RAG request boundary and immutable receipt lifecycle                                                  |
| `task_dataset_search_receipt_documents` | Document-only result summary used to prove future exclusion coverage                                                |
| `task_dataset_contribution_batches`     | Bounded idempotent batch envelope reserved for the write phase                                                      |
| `task_dataset_contributions`            | Source-owned JSONB facts, evidence, identity hashes, and conflict-preserving provenance                             |
| `task_dataset_records`                  | Materialized JSONB logical records, stable sequence paging, full-text projection, and conflict state                |
| `task_dataset_run_usage`                | Per-run/item inventory, source, record, RAG, search, timing, and publication metrics                                |
| `task_dataset_purge_jobs`               | Bounded asynchronous cleanup state for later clear/delete workflows                                                 |

Every table carries `tenant_id`, enables RLS, and follows the platform's
service-role-only policy pattern. A shared trigger validates that Task, run,
run item, silo, project, group, definition, transaction, document, source, and
receipt relationships belong to the same tenant and execution scope.

## Definition Digest And Record Identity

The database recomputes a definition's semantic digest from its meaningful
contract fields. A caller-supplied digest is never authoritative. Semantic
updates increment the definition revision; portable restore may preserve an
already authoritative revision.

The shared TypeScript identity implementation supports:

- `first_complete_rule`;
- `all_paths`;
- `payload_hash`;
- `source_local`;
- `explicit_key`.

Identity values use RFC 6901 JSON pointers, Unicode NFKC normalization,
whitespace collapse, default case folding, optional punctuation removal,
type-tagged canonical tuples, and a SHA-256 namespace containing both group ID
and dataset ID. Missing or empty required values fail with
`task_dataset_identity_missing`; the implementation never invents a random key.

Canonical JSON sorts object keys recursively, preserves array order, converts
negative zero to zero, and rejects cycles, `undefined`, non-finite numbers,
BigInt, functions, symbols, dates, and other non-JSON objects rather than
silently changing them.

## Run Transaction Protocol

### Open

`task_dataset_open_run_transaction` derives Task, silo, and optional project
from the trusted Task run. It creates or reuses the exact group, locks that
scope, verifies the run is nonterminal, and issues a random publication lease
token. Only the SHA-256 digest is stored.

The group lease records the owning transaction ID in addition to owner, digest,
and expiry. Any unexpired lease blocks another writer, even if both writers use
the same human-readable owner label.

### Renew

`task_dataset_renew_publication_lease` accepts only a live open/sealed
transaction and the matching raw token. Lease duration is bounded from 30 to
3,600 seconds.

### Inventory and stage

Inventory requires an open transaction whose base generation still matches the
group. Every staged source uses the transaction's target generation. Parallel
model-write primitives are deferred, but their tables and uniqueness keys are
present so Phase 3/4 can add bounded operations without a destructive schema
redesign.

### Seal

`task_dataset_seal_run_transaction` validates:

- generation and exact transaction-owned lease;
- all staged sources are sealed, not applicable, removed, or superseded;
- all receipts and receipt documents are sealed/complete;
- no rejected contribution batch remains;
- an optional manifest digest is valid SHA-256.

Seal does not publish anything.

### Commit

`task_dataset_commit_run_transaction` locks the transaction, Task run, and
group; revalidates the generation and exact lease; and rejects a failed,
cancelled, incomplete, or partially successful Task. One database transaction
then:

1. supersedes active definitions replaced by staged definitions;
2. activates staged definitions;
3. applies source removals and commits sealed source coverage;
4. commits receipts and receipt-document coverage;
5. activates staged contributions and materialized records;
6. commits usage rows and the transaction log;
7. recalculates group counts;
8. advances the group generation;
9. clears only that transaction's publication lease.

Any raised error rolls the entire publication back. The prior committed
generation remains visible.

### Discard

`task_dataset_discard_run_transaction` deletes current-run staging, retains the
discarded transaction audit row, and leaves the committed generation unchanged.
It clears the group lease only when the lease is still owned by that exact
transaction. Consequently, a late cleanup from an expired writer cannot clear
a newer writer's lease.

## Backup And Restore

Committed groups, definitions, source coverage, receipts, contributions,
records, and usage are portable content and appear in dependency-safe restore
order. Purge jobs are installation-local execution state and are excluded.

Publication and source claim lease fields are redacted. During restore:

- a `publishing` group becomes `ready` or `empty` from its committed generation;
- an open, sealed, committing, or commit-failed transaction becomes discarded;
- claimed/processing source work becomes failed and eligible for later fresh
  inventory;
- open/sealed receipts become discarded.

The restore therefore preserves committed data without pretending interrupted
workers or bearer tokens travelled with the archive.

## Validation

The checked-in SQL smoke test verifies:

- service-role-only coordinator RPC and durable-table grants, including
  privileges such as `TRUNCATE` that do not pass through RLS;
- automatic Markdown SHA-256 generation;
- first-run pending inventory;
- refusal to commit before every Task item/output succeeds;
- atomic activation after success;
- same-ID re-ingestion remains covered despite a changed Markdown digest;
- a new document ID alone becomes pending;
- active publication lease contention;
- expired lease takeover;
- stale transaction discard cannot clear the newer lease;
- discard removes staging without advancing the committed generation.

Local validation commands:

```powershell
pnpm dlx supabase@latest start
pnpm dlx supabase@latest db reset --local --no-seed
Get-Content supabase/tests/task_dataset_phase_one.sql -Raw |
  docker exec -i supabase_db_bubble-rag-platform psql -U postgres -d postgres -v ON_ERROR_STOP=1
pnpm dlx supabase@latest db lint --local --level warning
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm docs:check
```

The database lint reports only the pre-existing `warning extra` analysis for
the dynamic vector-dimension branches in `match_document_embeddings`; no Phase
1 Task Dataset function is reported. A real ambiguous `version_number` finding
in `create_document_template_derived_version` was corrected in the isolated
follow-up migration `20260825000200_fix_template_derived_version_ambiguity`.
The first hosted-staging smoke then exposed explicit `anon` and `authenticated`
default grants that are absent on a clean local project. The additive migration
`20260825000300_task_dataset_access_repair` removes every Task Dataset table and
coordinator privilege from API roles and grants them only to `service_role`.

## Next Phase Entry Point

Phases 2 and 3 are implemented and documented in
[Phase 2 implementation](phase_2_implementation.md) and
[Phase 3 implementation](phase_3_implementation.md). The next entry point is
Phase 4's verified saved Task context, transaction lifecycle, and pre-ranking
dataset-aware RAG exclusion wiring.
