# M9 implementation checkpoint

M8 closed in `0368678`, following deployed candidate `a75b4bb`. M9 adds the
first normal worker claim lane, but only behind the single fenced activation
RPC and an explicit internal-canary switch. Staged v1 remains authoritative,
publication remains disabled, and no M10 routing or publication behavior is
implemented by this milestone.

## Ordered work

- [x] Add `activate_extraction_template_work_batch()` as the only transition
      from `prepared_nonclaimable` verified work to claimable work. It checks
      the exact migration head, platform readiness, Manifest v2 eligibility,
      parent state, immutable artifacts, coverage, provider preflight,
      publication custody, contract versions, and activation epoch.
- [x] Materialize and validate every server-owned Task Dataset destination at
      activation. The planner and worker cannot choose group, transaction,
      dataset, source, generation, identity, or deduplication fields.
- [x] Add immutable activation and worker-settlement receipts. Exact settlement
      replay is accepted while a conflicting replay is rejected.
- [x] Add a dedicated `template_work_order` worker lane that advertises its
      build, migration, protocol, pipeline, envelope, and result support before
      receiving a lease.
- [x] Recheck centralized platform readiness before every worker poll and again
      inside the claim RPC. Old or incompatible workers receive no work before
      any lease or provider call.
- [x] Bound the first internal canary to one or three workers per batch, three
      verified claims per tenant, and the shared provider capacity limit. The
      lane runs alongside rather than replacing ingestion and saved-Task work.
- [x] Compile only full-document envelopes in M9. Live shard claims fail closed
      until M10 supplies and proves the deterministic persisted merge path.
- [x] Load, decompress, and digest-check immutable canonical Markdown/page-map
      artifacts; execute the frozen provider/failover contract; validate the
      exact result; persist a content-addressed validated-result artifact; and
      settle only through the fenced database RPC.
- [x] Bridge all configured model providers, including OpenAI OAuth, through an
      authenticated private web endpoint. It accepts the compiled immutable
      prompt, exposes no tools, and cannot accept model-chosen destinations.
- [x] Persist validated records, evidence, source attestations, coverage, and
      Task Dataset contributions through server-owned identities. Reject
      unavailable-value sentinels, incomplete assignments, digest changes,
      cross-scope destinations, and late writes.
- [x] Extend Task-run cancellation to verified work. Cancellation releases
      source leases and capacity, cancels assignments and coverage, releases
      publication custody, and fences late worker settlement.
- [x] Make the global claim kill switch cancel/fence active verified batches
      before advancing the activation epoch and returning rollout to
      `disabled`; publication is hard-coded false throughout M9.
- [x] Add administrator-only canary-control and batch-activation routes with
      strict request bodies and epoch fencing.
- [x] Pass disposable SQL parsing, full repository tests/typecheck/lint/build,
      PostgreSQL internal-canary acceptance, PostgREST acceptance, docs/platform
      contract validation, and backup/restore/restart regression coverage.
- [x] Commit, push, deploy to staging, verify the exact M9 head/build/checksum,
      run only a tightly bounded internal canary if a prepared verified batch is
      safely available, return controls to `disabled`, and record the durable
      milestone proof before opening M10.

Staging contained zero prepared verified batches, so no user batch was created
or activated solely for the rollout proof. The disposable PostgreSQL canary
performed the real claim and settlement path; deployed staging was verified at
the exact M9 head with the maintenance barrier open and rollout, claims, and
publication all disabled. Durable evidence is in `m9-milestone-proof.json`.

## Development validation command

```text
pnpm test:railway-postgres -- --m9-internal-canary
```

The acceptance probe activates one verified disposable batch at concurrency
one, rejects an old worker, performs a real claim and Task Dataset settlement,
replays settlement idempotently, disables claims, proves subsequent claims are
empty, and rolls the entire probe back. Worker unit coverage separately proves
the three-claim parallel bound. Neither proof enables publication.
