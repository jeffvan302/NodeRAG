# M10 implementation checkpoint

M9 closed in `1953195`, following the candidate and reconciliation commits
recorded in `m9-milestone-proof.json`. M10 adds the release-control boundary
needed to evaluate an exact allowlisted template safely. The checked-in and
deployed default remains `disabled`; this checkpoint does not substitute a
disposable test for the required live comparison and soak window.

## Implemented release controls

- [x] Require one exact enabled allowlist row across tenant, silo, nullable
      project, template group, template, active template version, and eligible
      Manifest-v2 assessment revision. Only one row may be enabled at a time.
- [x] Resolve ineligible, unallowlisted, project-mismatched, or disabled new
      runs to `staged_v1`; only the exact scope may resolve to `deferred_v2`
      while canary/default routing is active.
- [x] Record immutable v1-versus-v2 comparison receipts using a digest the
      server computes independently from caller input.
- [x] Enforce the Section 27 recall, extraction, provenance, schema, DOCX,
      cancellation, security, runtime, cost, provider-error, capacity-leak,
      and duplicate-work thresholds at the database gate.
- [x] Require at least three passing comparison receipts at each parallelism
      stage and a successful rollback drill before expanding 1→3→15.
- [x] Keep publication authorization separate from claims and default routing.
      Publication requires its own immutable gate receipt after the 15-slot
      comparison stage.
- [x] Start the default-routing soak from a server timestamp, reject default
      enablement before 24 hours, and reject any failed comparison during the
      soak window.
- [x] Roll back by advancing the activation epoch, cancelling/fencing active
      batches, releasing capacity, disabling claims/publication/default
      routing, and recording the drill result.
- [x] Raise the verified claim lane to a maximum of 15 only through the M10
      control row. Worker polling is still bounded by that durable value.
- [x] Restore RPC-only least privilege after Railway's broad PostgREST
      compatibility grants. M5–M10 tables remain select-only to the service
      role and private guard/digest helpers are not remotely executable.
- [x] Exercise the real verified claim/settlement path in disposable
      PostgreSQL at concurrency one, then prove 1→rollback→3→rollback→15,
      publication authorization, premature-default rejection, and a final
      rollback to `disabled`.
- [x] Pin the allowlisted route once per normal saved-Task item, register only
      server-derived complete immutable sources, run the durable Phase 1
      coordinator under the exact route/epoch gate, transfer Task Dataset
      custody without exposing its token, and atomically activate plus defer
      the parent. Barrier completion clears the wait pointer before requeue.
- [x] Preserve rollback safety before activation. A pinned item whose exact
      Phase 1 gate closes returns to staged v1; it does not bypass the closed
      gate or remain trapped in an application retry loop.
- [x] Expose requested Template work-order parallelism in Template
      configuration with supported values 1, 3, and 15. Activation uses the
      lowest of this request, the pinned route ceiling, and the live certified
      release ceiling, so configuration cannot bypass staged rollout gates.

## Administrator API contract

All routes below require administrator authentication. They are release
operations, not API-key tenant endpoints.

| Route                                    | Method | Purpose                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/admin/template-work-v2/allowlist`  | `GET`  | List exact canary scopes.                                                                                                                                                                                                                                                    |
| `/api/admin/template-work-v2/allowlist`  | `POST` | Enable or disable one exact scope while rollout is disabled. The strict body contains `tenantId`, `siloId`, nullable `projectId`, `templateGroupId`, `templateId`, `templateVersionId`, `manifestAssessmentRevisionId`, `enabled`, `purpose`, and `expectedActivationEpoch`. |
| `/api/admin/template-work-v2/comparison` | `GET`  | List the newest 100 immutable comparison receipts.                                                                                                                                                                                                                           |
| `/api/admin/template-work-v2/comparison` | `POST` | Record one v1/v2 comparison. The strict body contains `allowlistId`, `comparisonKey`, `parallelism`, both Task-run IDs, `measuredAt`, all release metrics, and four evidence digests. The server derives the expected receipt digest.                                        |
| `/api/admin/template-work-v2/canary`     | `GET`  | Read rollout mode, epoch, claims, publication, parallelism, default routing, publication gate, soak timestamp, and contract versions.                                                                                                                                        |
| `/api/admin/template-work-v2/canary`     | `POST` | Execute one fenced action: `start_canary`, `resume_3`, `resume_15`, `rollback`, `authorize_publication`, `enable_default`, or `disable`, with `expectedActivationEpoch`.                                                                                                     |
| `/api/admin/template-work-v2/activate`   | `POST` | Activate one already verified, prepared batch at parallelism 1, 3, or 15 for the current epoch.                                                                                                                                                                              |

Every mutation returns `409` when an epoch, scope, evidence, ordering, soak, or
safety gate is not satisfied. Operators must reread the control row rather
than retrying with a guessed epoch.

## Gates intentionally still open

- [x] Wire the saved-Task entry point to the allowlisted route resolver and
      durable Phase 1 coordinator. This code path remains inert while rollout
      is `disabled`; completing the wiring does not configure a live scope.
- [ ] Configure the exact Town Manager template/test-silo allowlist in the live
      environment. No production scope is inferred from fixture data.
- [ ] Run and review real paired v1/v2 comparisons at 1, 3, and 15 with a
      rollback drill before each expansion.
- [ ] Authorize live publication only after the independent comparison gate.
- [ ] Complete the 24-hour server-timed soak with no threshold regression.
- [ ] Enable eligible Manifest-v2 templates by default only after every item
      above and the full Section 27 gate is recorded.

## Development validation

```text
pnpm test:railway-postgres
```

The M10 probe is enabled by `--m10-allowlisted-release`. It ends with rollout,
claims, publication, and default routing disabled and rolls back all fixture
data. It proves control semantics; it is not live-soak evidence.
