# PostgreSQL/PostgREST Portability Phase 7: Sleep and Cold Starts

Status: complete on 2026-08-28.

Phase 7 makes the local Railway relational data plane quiet when it is not
needed and safe to wake when it is selected again. Settings remains the
authority for placement: a caller requests activity for an active route or an
in-progress operation, and Settings derives whether local PostgreSQL,
PostgREST, both, or neither are required. Callers cannot nominate an arbitrary
database credential or use a lease to keep an unrelated local service awake.

## Activity leases

Web, Worker, and Maintenance use short Settings-backed leases. A lease records
only holder identity, route/operation binding, selected local destination IDs,
and expiry; it never contains a database credential. Leases renew every 30
seconds while work is active, expire after 90 seconds, and are explicitly
released at normal idle or operation completion.

- Web touches the active-route lease before a local Data API request.
- Worker holds a lease across each claimed job, including long-running work,
  and releases it before entering its outbound-silent idle wait.
- Maintenance holds an operation-scoped lease across analysis, schema work,
  backup, restore, transfer, attachment, cutover, and source cleanup.
- Candidate analysis may wake a local candidate and the PostgreSQL database it
  links to, without treating that candidate as active.
- A fully remote route produces no local targets and therefore sends no local
  keep-alive traffic.

Activity records are ephemeral process state. Settings excludes them from
encrypted backups and drops them when restoring an older snapshot that happens
to contain one. A crash therefore becomes lease expiry, never permanent
ownership or a restored keep-alive loop.

## PostgREST supervisor lifecycle

The lightweight private supervisor remains the Railway service entry point. It
tracks signed leases and in-flight proxy requests. Once leases have expired,
requests have drained, and the request-idle window has elapsed, the supervisor
terminates the PostgREST child. This closes the PostgREST PostgreSQL pool and
leaves both services eligible for Railway serverless sleep.

A signed lease, readiness request, or private API request starts the child and
waits for its admin readiness endpoint. Startup is bounded and retried; a
failed attempt terminates the unhealthy child before trying again. The
supervisor exposes liveness plus signed activity metrics for child state,
leases, active requests, wakes, idle shutdowns, readiness failures, unexpected
exits, and relevant timestamps. The Configuration page shows the route-derived
local lifecycle and active lease count without probing—and accidentally
waking—a sleeping service.

The defaults are:

- PostgREST child request-idle window: 90 seconds;
- supervisor idle sweep: 5 seconds;
- activity lease lifetime: 90 seconds;
- active lease renewal: 30 seconds; and
- passive activity tail after a request: 60 seconds.

The supervisor timing and readiness attempt values have validated optional
environment overrides in the platform contract.

## Cold-start request safety

The local Data API fetch path distinguishes reads from writes:

- `GET`, `HEAD`, and `OPTIONS` may be repeated once, but only after readiness
  succeeds following a transient `502`, `503`, or `504`;
- mutating requests establish readiness first and are then sent exactly once;
- an ambiguous failed write response is returned to the caller and is never
  blindly replayed; and
- failure to establish readiness produces a typed, retryable `503`-class
  platform error before a write is sent.

This behavior applies only to the selected `railway_postgrest` destination.
Remote provider traffic is untouched.

## Connection release and acceptance

Worker database access is HTTP-based and retains no PostgreSQL pool.
Maintenance direct PostgreSQL paths close their clients in `finally` blocks,
including transfer source/target pairs, attachment, cleanup, schema execution,
backup, and restore. The PostgREST supervisor's idle transition terminates the
remaining authenticator pool.

Run:

```text
pnpm --filter @bubble-rag/rag-core test
pnpm --filter @bubble-rag/settings test
pnpm --filter @bubble-rag/maintenance test
pnpm --filter @bubble-rag/postgrest-supervisor test
pnpm --filter @bubble-rag/worker test
pnpm --filter @bubble-rag/web test
pnpm platform:check
pnpm test:railway-postgrest
```

The deterministic suites cover lease renewal/release, expiry, route and
candidate selection, no local traffic for a remote route, idle child shutdown,
wake, read retry, one-attempt writes, and readiness failure. The Docker
acceptance waits through the configured idle window, proves the PostgREST child
stopped, verifies that authenticator sessions left `pg_stat_activity`, and
performs a cold read that wakes the child without data loss.

Railway's platform-level service sleep state cannot be asserted by a local
test. Phase 9 live certification therefore records the final observation that
both deployed services enter Railway sleep after the same pool-release path and
wake through private traffic.

## Phase 8 entry point

Phase 8 can package these defaults and contracts in the published Railway
template, update deployment guidance, and run the fresh-install and template
upgrade gates.
