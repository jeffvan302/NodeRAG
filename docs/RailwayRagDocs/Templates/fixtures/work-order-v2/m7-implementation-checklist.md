# M7 implementation checkpoint

M6 closed in `a7f2507`, following deployed candidate `f387b9e`. M7 adds the
observable and controllable synthetic end-to-end path only. Staged v1 remains
authoritative; rollout defaults to `disabled`; no real Phase 2 provider request,
normal v2 work-order claim lane, Task Dataset publication, generated-file
publication, or runtime activation is introduced.

## Ordered work

- [x] Add a strict versioned progress contract for exact phase, document,
      assignment and envelope counts, requirement/gap rollups, retry state,
      waiters, slots, elapsed time, ETA, report state, source/dataset titles,
      model/server status, recent events, failures, and controls.
- [x] Derive that progress from one bounded database function. Lists inspect up
      to 75 Task runs in one RPC; details inspect one run; document, requirement,
      status, event, and failure arrays have explicit limits and contain no
      source Markdown or extracted record bodies.
- [x] Return the same `templateWorkV2` contract from Task-run list/detail APIs
      and display it in the API Test Task Run Queue with exact phase, remaining
      work, ETA, active slots, retry reason, required gaps, source/dataset titles,
      and model/server status.
- [x] Extend the M5 transactional outbox in place with durable delivery IDs,
      leases, retry scheduling, status/error receipts, and terminal delivery
      states. Existing events and fields are preserved rather than copied.
- [x] Dispatch signed `template_execution.*` model-status and server-transition
      callbacks from the worker only while synthetic `orders_shadow` is active.
      The dispatcher remains inert while staging rollout is `disabled`.
- [x] Fence webhook claims and settlements, reuse the delivery ID across a
      retry, classify endpoint errors, skip unconfigured callbacks, and retain
      the existing AES-256-GCM/HMAC contract without exposing the saved secret.
- [x] Cancel every nonterminal synthetic batch for a Task run before changing
      the v1 Task-run state. The database operation releases slots, blocks late
      settlement, and retains the no-wake cancellation invariant.
- [x] Add a rebuild endpoint and Task Run Queue control. It queues a new run with
      the original Task, silo, project, input data, filename modifier, and saved
      requested settings while leaving the old run immutable and not copying
      webhook credentials.
- [x] Pass the disposable PostgreSQL `--m7-observability` proof. Fifteen
      synthetic shards demonstrate database/API count agreement, model and
      server webhook payloads, durable retry, lease fencing, run cancellation,
      late-write rejection, bounded telemetry, and zero source-body leakage.
- [x] Pass repository typecheck/tests/build, API documentation validation,
      Phase 9 contract validation, PostgreSQL acceptance, and PostgREST
      acceptance. The release package contains 137 pinned core migrations, 170
      application tables, 274 functions, and 444 owned objects.
- [x] Commit, push, deploy to staging, verify the active database head/checksum
      and service health, confirm rollout remains `disabled` at activation epoch
      zero with claims/publication false, and record the machine-readable M7
      proof.

## Development validation command

```text
pnpm test:railway-postgres -- --m7-observability
```

The focused M7 proof includes the M5 synthetic deferred graph and M6 report
receipts. M7 is not closed until staging deployment and live inactive-control
verification are recorded.
