# Railway Deployment Phase 3: Runtime Configuration Normalization

Last reviewed: 2026-08-06.

Phase 3 moves operational settings out of Railway variables and into Supabase,
gives configuration a revision that workers snapshot per job, and adds the admin
Supabase Connection panel so the three connection roots can be rotated without
visiting each Railway service.

**Status.** Complete. All fifty operational settings are stored in
Supabase and editable from the admin application, every one has a reviewed help
definition, the connection panel rotates the three connection roots with a
read-only database probe and per-service health gates, and environment adoption
is wired into both the new-installation and the upgraded-installation paths.

## 1. Configuration Revisioning

`platform_runtime_settings` holds one row per tenant:

| Column                   | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `settings`               | Sparse overlay over the release defaults. `{}` means "all defaults". |
| `revision`               | Monotonic. Bumped by trigger whenever `settings` changes.            |
| `environment_adopted_at` | Set once, when Railway values are imported. Guards re-import.        |

The overlay is sparse on purpose. Only values that differ from the release
default are stored, so a later release that changes a default moves every
installation that never overrode it. Defaults live in `rag-core`, not in the
database, so changing one does not require a migration.

The revision advances in a **database trigger** rather than in application code.
A direct SQL edit therefore cannot leave a worker holding a stale snapshot it
believes is current.

`get_platform_settings_snapshot(tenant)` returns the overlay and revision
together. The application merges over the defaults; the database deliberately
does not know them.

## 2. Worker Snapshot Behavior

Roadmap section 8.3 requires five behaviors. Four are implemented:

1. **Load a validated snapshot when starting a job** - `claimNextJob` captures
   one before the claim update.
2. **Cache briefly** - fifteen seconds, in `SETTINGS_CACHE_MS`.
3. **Record the revision on every job** - `processing_jobs.settings_revision`,
   written as part of the claim. `generated_files.settings_revision` exists for
   the same purpose.
4. **Continue an active job with its captured snapshot** - the migrated settings
   are module bindings reassigned only by `applySettingsSnapshot`, which runs at
   claim time. An edit made mid-job cannot change that job's behavior.

   Two are excepted, and deliberately so: `workerPollIntervalMs` and
   `workerMaxJobsPerRun` are refreshed between jobs by `refreshPollingSettings`,
   because they govern the loop that decides whether to claim a job at all and
   would otherwise never change on a worker that is idle.

Item 5, polling or subscribing for revision changes between jobs, is covered in
practice by the fifteen-second cache: the next claim after expiry picks up any
new revision. There is no push subscription.

### Degradation

Two failure modes are handled deliberately, because a worker that cannot start
is worse than one running on defaults:

- A stored value a newer release no longer accepts is dropped in favour of that
  one default, rather than failing the whole snapshot.
- If `get_platform_settings_snapshot` does not exist - an older database, or a
  deployment that ran before this migration - the worker logs a warning and uses
  release defaults.

## 3. Settings Migrated

All fifty operational settings bind from the snapshot. None of them reads
`process.env` any longer. Bounds and defaults are the ones the worker previously
applied, so behavior is unchanged for an installation that never edits them.

Groups, as they appear on the settings screen: worker and queue, PDF pages and
rendering, PDF vision, image extraction and analysis, spreadsheets, embeddings,
provider timeouts, and API limits.

The second pass required a decision per setting rather than a mechanical
conversion, and four of those decisions changed observable behaviour. They are
recorded in
[Phase 3: The Second Settings Migration](railway-deployment-phase-3-remaining-environment-settings.md).

### The Admin Screen

Configuration → Environment variables edits all fifty, grouped, each
showing its release default, its bounds, the Railway variable it used to be read
from, and a reset control.

The interface is built from what `/api/platform-settings` reports about the
schema rather than from a second description of it. A field drawn from the
browser's own idea of the limits could offer a range that a save would reject.

Only changed values are sent. Sending the whole set on every save would rewrite
every key and destroy the distinction between "left at the release default" and
"deliberately set to the same value as the default" — the distinction the sparse
overlay exists to preserve.

### Environment Adoption

Removing the environment reads would silently revert any value an operator had
tuned in Railway: a deployment with `PDF_MAX_PAGES=250` would fall back to the
release default of 1000 with nothing to indicate it.

`adoptEnvironmentSettingsOnce` imports those values into the overlay, at most
once per installation, guarded by `environment_adopted_at`, so it cannot later
overwrite an edit made in the admin application. A value outside the release
bounds is skipped rather than clamped, so the operator sees the default and
re-enters it deliberately.

It is called from two places, because a new installation and an upgraded one
reach the settings by different routes: first-admin creation, and the first load
of `/api/platform-settings`. Failure in the first is logged and ignored, because
blocking access to a fresh installation would be worse than falling back to
defaults.

## 4. Supabase Connection Panel

The panel implements the staged workflow from roadmap section 6.3.

### What The Browser Receives

Project reference, connection state, and a twelve-character SHA-256 fingerprint
per secret. Never a stored secret. Replacing one requires entering its complete
new value.

### Validation Steps

| Step | Implemented                                                                       |
| ---- | --------------------------------------------------------------------------------- |
| 2    | Format: HTTPS for the API URL, three-part JWT for the key, TLS for Postgres.      |
| 3    | Identity: derive the project reference from all three values and require a match. |
| 4    | API access: read-only Data API and Storage API probes with the proposed key.      |
| 5    | Database: read-only Postgres probe through maintenance.                           |
| 6    | Classify: current project, compatible installation, blank, incompatible, unknown. |
| 8    | Stage: write all values with `skipDeploys`, plus `SUPABASE_PREVIOUS_*` copies.    |
| 9    | Promote: redeploy web, then worker, behind per-service health gates.              |
| 10   | Finalize: maintenance redeploys itself once the outcome is known.                 |
| 11   | Audit: record actor, references, fingerprints, and health results.                |

The API probes are deliberately read-only. A write probe against a project that
turns out to be the wrong one would leave rows in a stranger's database.

Identity verification is the check that matters most: without it, credentials
from two different projects could be combined into an installation that reads
from one database and writes storage to another.

Staging is separated from promotion because `skipDeploys` is what prevents each
variable write triggering its own redeploy, which would restart services holding
a half-applied credential set.

### The Read-Only Database Probe

`apps/maintenance/src/probe.ts` opens a session against the proposed database
with `default_transaction_read_only = on` and reads four things: the server
version, which of the signature tables exist, the installed migration head from
`supabase_migrations.schema_migrations`, and whether the migration advisory lock
can be taken.

The session is read-only for the whole of its life, so even a coding mistake in
the probe cannot write to a database the operator has not yet committed to. The
advisory lock is released immediately; holding it would block the real migration
runner. The lock name is imported from the migration runner rather than restated,
because a second literal would drift and the probe would then report a database
as quiet while a migration was running against it.

A lock that cannot be taken is reported as `unknown` and blocks promotion.
Promoting into a database mid-migration would interleave two writers.

It runs in maintenance because that is the only service with a Postgres
connection, and it connects with credentials supplied in the request rather than
its own: the entire point is to inspect a database the platform is not connected
to.

### Why Promotion Runs In Maintenance

Promotion redeploys services. An orchestrator running inside a service it
redeploys is terminated part-way through, and the rollback dies with it - which
would leave the deployment in exactly the state the rollback exists to prevent.

Promotion therefore runs in `apps/maintenance`, reached over signed private
networking, and the Railway API token moved there with it. That is also the
better home for the token on its own merits: it can rewrite any variable and
redeploy any service in the environment, and maintenance is not exposed to the
internet.

**Promotion order is `web`, `worker`, `maintenance`, which deviates from the
roadmap.** The roadmap puts maintenance first because it owns migrations. Taken
literally that reproduces the same flaw: maintenance would kill itself at step
one. The migration constraint is met a different way here - maintenance migrates
and probes a target by connecting to a database URL passed in the request, so it
never needs its own variables updated in order to prepare that target. It
therefore promotes itself last, which is the only order in which the orchestrator
survives the entire window during which a rollback could be needed.

Maintenance does not redeploy itself as part of the run. Restarting is a separate
call, `POST /connection/finalize`, made only after the operator holds a
successful result. No gate is possible on that restart, because the service that
would report it is the one going down. Until it happens the panel shows
maintenance as out of sync and offers the button, so the pending step is visible
rather than assumed.

### Per-Service Health Gates

Each service is checked on its own address, and each health endpoint now reports
a twelve-character fingerprint of the `SUPABASE_URL`, service key, and database
URL it is actually running on.

Fingerprints are what make the gate mean something. Reachability alone passes for
a service whose redeploy silently failed and whose old process is still
answering. The gate requires the reported fingerprints to equal the ones being
promoted, so it distinguishes "the service is up" from "the service is up on the
new credentials".

| Service     | Checked at                         | Passes when                                               |
| ----------- | ---------------------------------- | --------------------------------------------------------- |
| web         | `WEB_INTERNAL_URL` + `/api/health` | Fingerprints match and schema readiness is `operational`. |
| worker      | `WORKER_EMBEDDING_URL` + `/health` | Fingerprints match and queue readiness is `operational`.  |
| maintenance | not gated                          | Redeployed separately, after the result is reported.      |

Web's `ok` is its schema readiness, so passing the gate already proves it reached
the database with the promoted credentials. The worker's queue readiness proves
the same for the worker.

`WEB_INTERNAL_URL` is required for rotation to be offered at all. Discovering
mid-promotion that no gate can run would be worse than refusing up front.

If `WORKER_EMBEDDING_URL` is not configured, the worker falls back to web's queue
report. That reads the database rather than the worker process, so a `blocked` or
`unavailable` queue fails the gate as positive evidence of a fault, while any
other state passes **unverified**. The distinction is carried through the result
and shown in the panel: "we did not check" and "we checked and it was fine" are
not the same claim.

Gates poll rather than sleeping once, because a service takes an uneven amount of
time to come back and a single check would make the gate a coin toss.

### Rollback

Current credentials are staged into `SUPABASE_PREVIOUS_*` before promotion. If a
service fails its health gate, the previous values are restored on every service
already promoted and those services are redeployed. Variables are restored on all
affected services before any redeploy, so none can come back holding the old URL
with the new key.

A rollback that itself fails is reported as such rather than silently counted as
done; the panel then tells the operator which variables to restore by hand.

### Moving To A Different Project

Promotion refuses without explicit confirmation when the proposed values point
at a project other than the current one. The panel labels this as a migration
rather than a credential rotation, per the roadmap's separation of **Rotate
credentials** from **Move to another project**.

### Rotation Availability

The original environment-token compatibility path for Supabase connection
rotation is retired. Service creation and routine infrastructure reconciliation
use the Settings-Vault-owned OAuth or project connection described in
[Railway connection and service reconciliation](railway-connection-and-service-reconciliation.md).

`RAILWAY_API_TOKEN` is no longer read from the maintenance environment. An
administrator connects Railway in the web workflow, reviews the target, and
approves retention in the encrypted local Settings Vault. An installation not
created from the template still runs normally and its operator edits variables
in Railway directly.

### Retired Promotion Endpoints

The original `/connection/promote`, `/connection/finalize`, and promotion-status
routes now return `410 Gone`. Supabase connection settings are written directly
to the local Settings Vault, and Railway infrastructure changes use the
`/infrastructure/*` private maintenance routes instead.

## 5. Audit Table

`supabase_connection_events` records action, outcome, classification, actor, old
and new project references, secret fingerprints, promoted services, and any
failure.

It cannot hold a credential. There is no column for one, and a check constraint
requires the fingerprint columns to be at most twelve hexadecimal characters, so
a write carrying material derived too directly from a secret fails rather than
persisting.

## 6. Verification

```powershell
pnpm test
pnpm build
```

The connection logic has 21 unit tests in `apps/web` covering fingerprint
stability and rotation sensitivity, format rejection, project-reference
derivation including the pooler username form, mixed-project refusal, read-only
API probe behavior, and classification.

Promotion and the database probe have 35 unit tests in `apps/maintenance`
covering the promotion order, rollback of every already-promoted service,
rollback failure being reported rather than assumed, gate retries, a throwing
health check counting as a failed attempt rather than crashing the run, the
fingerprint mismatch that catches a service which never restarted, the
verified/unverified distinction, probe classification of each target type, and
that the probe takes the same advisory lock name as the migration runner.

## The Phase 3 Gate

> Except for connection/security roots and service topology, a fresh
> installation can be configured entirely through the admin application and
> Supabase. An admin can rotate the three Supabase connection values without
> visiting each Railway service or exposing a secret back to the browser.

Both halves are met.

Fifty operational settings are editable from Configuration -> Environment
variables, and none of them is read from `process.env` any longer. Fifty-three
were migrated; three came back to the environment when moving them turned out to
change behaviour, and the reasoning is in
[Phase 3: The Second Settings Migration](railway-deployment-phase-3-remaining-environment-settings.md#three-that-came-back). What remains
in Railway is the connection roots, the security roots, and service topology:
`SUPABASE_*`, `ADMIN_SESSION_SECRET`, `INTERNAL_SERVICE_TOKEN`, the `RAILWAY_*`
wiring, the private-network addresses, and `PORT`. That is the exemption the gate
names.

The connection panel rotates all three connection values from the admin
application. No stored secret reaches the browser; replacing one requires
entering its complete new value, and only twelve-character fingerprints are
returned.

### Carried Forward

Two things sit deliberately outside Phase 3 and are recorded so they are not
later mistaken for gaps:

- **`OLLAMA_VISION_MODEL` is still read by web**, but only to pre-fill the
  provider form during first-run setup. The worker's use of it became the
  `ollamaVisionModelFallback` setting.
- **Provider and model-task configuration is pinned per job incidentally rather
  than deliberately.** `getEmbeddingConfig`, `getPdfParseConfig` and
  `getOllamaVisionConfig` are each fetched once per job and memoised, which
  satisfies the roadmap's "prevent provider configuration changes from taking
  effect midway through a job" in practice. It follows from how those call sites
  happen to be written rather than from a mechanism like `settings_revision`, so
  a refactor could quietly undo it.
