# M5 implementation checkpoint

M4 closed in `195200a`, following deployed candidate `310e5d6`. This checklist is
working implementation evidence, not an exit proof. M5 remains open until every
item below passes. Rollout defaults to `disabled`; real Phase 2 claims, provider
execution, and publication stay unavailable.

## Ordered work

- [x] Persist/recover exact Phase 1 attempt identity and bounded response artifacts.
      Separate allocation identity from the current parent-job custody epoch. Mark
      dispatch durably before a model request; an indeterminate dispatched request
      consumes its logical attempt and is never silently resent. Recover stored
      responses and syntax-repair inputs without another provider call.
      Component proof: 68 planner/orchestration/adapter tests, nine core artifact
      tests, and the disposable PostgreSQL `--m5-planner-recovery` probe pass. The
      probe includes 11 rejected faults, custody epochs 1–4, exact syntax-response
      recovery, idempotent settlement, accepted proposal reconstruction, and the
      bounded indeterminate-dispatch retry path. It makes zero provider calls.
      This is not the full M5 restart/queue/custody exit proof.
- [x] Add normalized batches, source inventory, logical assignments, requirement
      rollups, envelope assignments, work orders, report-snapshot metadata, custody,
      barrier wakes, and transactional event outbox through additive migrations.
      Seven release-owned migrations add 16 normalized tables with composite
      tenant/batch/source/trust-domain foreign keys and physically separate
      synthetic coverage and waiters.
- [x] Materialize accepted plans atomically, using exact M2/M3 destinations,
      coverage ownership/waiters, and source identities. All real orders begin and
      remain `prepared_nonclaimable`.
- [x] Add parent queue `waiting`/resume cursor and separate failure attempts from
      lease/claim epochs; normal defer/resume does not exhaust the job retry budget.
- [x] Add fenced coordinator custody surviving parent yield and process restart.
- [x] Prove synthetic-only capacity/claim, heartbeat, delayed retry, settlement,
      split/merge, waiter import/reclaim, cancellation, slot reclamation, and one wake.
      Synthetic trust cannot create verified coverage, dataset records, or publication.
- [x] Accept a deferred disposition in the worker and guard every queue with
      centralized platform readiness. No real v2 polling/provider lane is connected.
      All seven existing queues and accelerated refill paths check fresh readiness;
      exact durable deferral stops heartbeats, acknowledges the handoff receipt, and
      does not turn a yielded parent into a Task failure.
- [x] Record bounded, monotonic model/server statuses in the same transaction as
      an outbox event. M7 will connect these to UI/webhook delivery.
- [x] Pass fault, concurrency, restart, no-leaked-slot, no-duplicate-contribution,
      cross-scope, and old-worker rejection tests (15 synthetic slots; zero providers).
      The disposable PostgreSQL proof claims all 15 slots, exercises retry and crash
      reclaim, split/merge, waiter import/reclaim, cancellation races, stale-worker
      fencing, and exactly one successful final-barrier wake with zero leaked slots.
- [x] Regenerate platform artifacts, pass repository/database/API checks, commit,
      push, verify staging service health, and record the machine-readable M5 proof.
      Platform artifacts report 170 tables, 266
      functions, 135 pinned core migrations, and 436 owned objects; repository tests,
      typecheck, build, docs, Phase 9, PostgreSQL, and PostgREST acceptance pass.
      Candidate `2b0a436` passed GitHub tests and the staging migration workflow.
      Web, worker, maintenance, scheduler, and embeddings are healthy; public health
      and embedding smoke pass. The active Supabase data plane is current at the M5
      head with matching checksums, while rollout remains `disabled`, activation
      epoch remains zero, and real worker claims and publication remain off.

## Known deployment note

Staging's selected database is Supabase PostgreSQL, current and operational at the
M4 head with 128 matching core checksums. Its non-active retained Railway source
has an older core/provider ledger mismatch. Do not change or activate that retained
source as part of these milestones. Disposable Railway acceptance independently
proves the current 129-migration physical-provider chain.

## Development validation commands

The M5 migrations are release-owned. The optional switches add the focused
recovery/control-plane fault proofs after the normal migration chain:

```text
node scripts/railway-postgres-acceptance.mjs --m5-planner-recovery
node scripts/railway-postgres-acceptance.mjs --m5-deferred-graph
```

Do not push or label M5 complete based on component probes alone; the complete
repository, PostgreSQL, PostgREST, deployment, and live gate checks still apply.
