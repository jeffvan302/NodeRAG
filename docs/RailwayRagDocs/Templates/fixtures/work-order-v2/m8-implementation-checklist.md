# M8 implementation checkpoint

M7 closed in `64a25a8`, following deployed candidate `1b6e468`. M8 is the
first real Phase 2 provider boundary, but only through an explicit admin/test
harness. Staged v1 remains authoritative and the normal worker has no M8 poll
or claim loop.

## Ordered work

- [x] Add a provider-neutral core executor with pinned primary/failover routes,
      conservative context enforcement, route timeouts, bounded transient
      retries, one JSON repair maximum, cancellation, and attempt usage/cost
      telemetry.
- [x] Compile an exact full-document or deterministic-shard envelope only after
      downloading, decompressing, and digest-verifying the immutable canonical
      Markdown and page map.
- [x] Validate result discriminators, assignment completeness, JSON record
      schema, cardinality, identity, temporal and title policies, evidence
      offsets/excerpts/field paths, shard attestation, and unavailable-source
      sentinel rejection.
- [x] Add deterministic shard result validation and merge tests, including
      overlap deduplication and whole-document absence derivation only after all
      ranges have been reviewed.
- [x] Add one targeted durable claim/heartbeat/settlement contract whose
      runtime is restricted to `executor_shadow`, activation epoch zero, worker
      claims false, and publication false.
- [x] Persist semantic-result and artifact-byte digests separately in an
      immutable quarantine receipt. Successful and failed shadow attempts leave
      logical assignments, coverage, Task Dataset records, and generated files
      unchanged.
- [x] Add an authenticated internal admin route. It has no polling loop, cannot
      choose a destination, and receives the frozen route/source/assignment
      bindings from the database lease.
- [x] Extend Task-run cancellation so an active M8 provider call loses its
      fenced lease and capacity slot before normal synthetic/v1 cancellation
      continues.
- [x] Pass disposable PostgreSQL proof for tenant concurrency one, capacity,
      heartbeat fencing, idempotent replay, conflicting replay, lease expiry and
      reclaim, cancellation and late-write fencing, normal-worker rejection,
      zero Task Dataset/generated-file writes, and zero publication.
- [x] Pass core and web golden-path tests, schema/evidence negative tests,
      provider retry/failover/repair tests, shard merge tests, repository docs
      validation, and a clean full PostgreSQL backup/restore/restart acceptance.
- [x] Commit, push, deploy to staging, verify the installed migration and all
      services, prove rollout remains `disabled` at activation epoch zero with
      claims/publication false, and record the machine-readable M8 proof.

## Development validation command

```text
pnpm test:railway-postgres -- --m8-executor-shadow
```

The M8 harness is intentionally inert on staging while rollout is `disabled`.
M8 closed on 2026-09-03 with the deployed evidence recorded in
`m8-milestone-proof.json`.
