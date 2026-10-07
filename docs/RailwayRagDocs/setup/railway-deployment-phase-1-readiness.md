# Railway Deployment Phase 1: Installation Readiness

**Status:** Completed 2026-08-04. Reconciled 2026-08-06.
**Application version:** `0.1.0`
**Expected migration head:** whatever
`RAG_RAILWAY_EXPECTED_MIGRATION_HEAD` in `packages/rag-core` says. It was
`20260804000300_platform_installation_readiness` when this phase closed and
moves with every migration, so it is named rather than repeated below.

## 1. Purpose

Phase 1 gives every RAG Railway application build an enforceable contract with
the connected Supabase database. A web service or worker can now determine
whether it is safe to operate before reading feature tables, accepting API
work, or claiming queued jobs.

The supported readiness outcomes are:

| State                  | Meaning                                                      | Normal work |
| ---------------------- | ------------------------------------------------------------ | ----------- |
| `unconfigured`         | Supabase connection values are absent or invalid             | Blocked     |
| `upgrade_required`     | Readiness metadata is absent or the database is behind       | Blocked     |
| `operational`          | Application and installed migration head are compatible      | Allowed     |
| `database_ahead`       | The database is newer than the running application build     | Blocked     |
| `maintenance`          | The installation is intentionally read-only or quiesced      | Blocked     |
| `installation_error`   | Installation metadata records a failed maintenance operation | Blocked     |
| `metadata_invalid`     | A migration head or readiness value cannot be trusted        | Blocked     |
| `database_unavailable` | Supabase or its readiness RPC could not be reached           | Blocked     |

Unknown readiness values fail closed as `metadata_invalid`.

`maintenance` covers four modes on `platform_installations.maintenance_mode`:
`read_only`, `quiesced`, `backup_requested` (Phase 5) and `restore_requested`
(Phase 6). Phase 1 defined only the first two; the later phases added their own
without needing new readiness code, because anything other than `none` already
blocked work.

That is why the backup barrier needed no changes to job claiming. It is worth
knowing when reading Phase 5: the barrier looks thin because most of it was
already here.

## 2. Database Resources

Migration
`supabase/migrations/20260804000300_platform_installation_readiness.sql`
adds the following resources.

### `platform_installations`

This singleton record identifies the installation and records:

- Stable `installation_id`.
- Product slug and application version.
- Installed migration head.
- Supported backup format version.
- Installation and maintenance states.
- Install, upgrade, verification, and error metadata.

The fixed row key is `00000000-0000-4000-8000-000000000901`. The migration
creates or upgrades that record to application version `0.1.0` and the Phase 1
migration head. A future maintenance operation may set `maintenance` or `error`
without changing the installation identity.

### `platform_migration_checksums`

This table is the database-side immutable checksum ledger. Each row can record
a migration filename, SHA-256 digest, application release, and verification
time. The table is service-role-only, validates both filename and digest shape,
and rejects changes to an applied migration's identity, digest, release, or
applied time. Later verification metadata may still be updated.

The repository ledger is already enforced in
`platform/migration-checksums.v1.json`. Phase 2 will synchronize verified
repository entries into the database table after each locked migration apply.
This split avoids claiming that an in-database row is verified before the
maintenance service exists.

### `get_platform_readiness`

The service-role RPC accepts the application build's expected migration head
and release version. It returns the normalized state, compatibility flags,
installed and expected versions, maintenance state, backup format, and
checksum count. It does not expose credentials.

## 3. Build Contract

The shared package compiles these immutable values into both web and worker
builds:

```text
RAG_RAILWAY_APPLICATION_VERSION=0.1.0
RAG_RAILWAY_EXPECTED_MIGRATION_HEAD=<newest checked-in migration>
RAG_RAILWAY_BACKUP_FORMAT_VERSION=1
```

These are build constants, not Railway variables and not operator overrides.
The head is written as a placeholder here deliberately: every migration changes
it, and a document that repeated the value would be wrong by the next one.

`scripts/verify-platform-contract.mjs` verifies that the application version
matches the root package, and that the head agrees across all four places that
carry it: the build constant, the Supabase resource manifest, the environment
contract, and the newest file in `supabase/migrations`. The environment contract
was added to that comparison on 2026-08-06, after it was found three migrations
behind with nothing checking it.

## 4. Web And API Guard

Every database-backed web and REST route obtains Supabase through the shared
asynchronous `requireSupabase()` guard. The guard:

1. Validates that Supabase is configured.
2. Calls the readiness RPC.
3. Caches a successful or failed readiness result for 10 seconds.
4. Returns a structured HTTP `503` before feature access unless the state is
   `operational` and `canProcessJobs` is true.

Public `/api/v1` requests preserve the standardized error envelope and request
ID. Typical compatibility errors are:

```json
{
  "error": {
    "code": "platform_upgrade_required",
    "message": "The database schema must be upgraded before normal work can continue.",
    "details": {
      "state": "upgrade_required",
      "incompatibilityCode": "schema_behind_application",
      "applicationVersion": "0.1.0",
      "expectedMigrationHead": "20260804000300_platform_installation_readiness",
      "installedMigrationHead": "20260804000200_api_user_administrators"
    }
  },
  "requestId": "..."
}
```

## 5. Worker Claim Guard

The queue worker checks the same RPC immediately before selecting a queued
job. It never marks a job as running while readiness is blocked.

- The result is cached for 10 seconds.
- A blocked state is logged only when its signature changes, avoiding log
  noise on every poll.
- The worker continues polling and resumes automatically after the database
  becomes operational.
- A job already running is allowed to finish. The guard controls new claims;
  Phase 2 maintenance quiescing will coordinate in-flight jobs before schema
  changes.
- Dedicated embedding-only workers continue serving embeddings because they do
  not claim database jobs.

## 6. Health Contract

`GET /api/health` remains callable before setup and during upgrades. It returns
HTTP `200` when the web process can answer, while `ok` and `status` describe
whether the platform can perform normal work.

The response now separates:

- `connection`: configured, reachable, and readiness latency.
- `schema`: complete normalized readiness metadata.
- `workers.queue`: blocked, idle, working, stale, or unavailable, including
  running count and latest heartbeat.
- `workers.embeddings`: configured, reachable, and health latency.
- `application`: release version and expected migration head.
- `providers`: environment or Vault-backed provider readiness.

Example operational response excerpt:

```json
{
  "ok": true,
  "serviceResponding": true,
  "service": "rag-railway-web",
  "status": "operational",
  "application": {
    "version": "0.1.0",
    "expectedMigrationHead": "20260804000300_platform_installation_readiness"
  },
  "connection": {
    "configured": true,
    "reachable": true,
    "latencyMs": 84
  },
  "workers": {
    "queue": {
      "status": "idle",
      "canClaimJobs": true,
      "runningJobs": 0,
      "staleJobs": 0
    }
  }
}
```

The Admin Dashboard's first status metric now shows the normalized platform
state instead of treating connection variables alone as readiness.

## 7. Contextual Help Gate

Phase 1 completes the reusable help foundation:

- `FieldHelp` provides mouse, focus, keyboard, and touch activation.
- The popover renders through a responsive document-body portal, avoids viewport
  edges, closes on Escape or outside interaction, and restores focus.
- `SectionHelp` uses the same behavior for page, panel, and modal headings.
- `FIELD_HELP` contains 82 typed reviewed definitions.
- `REQUIRED_FIELD_HELP_SURFACES` inventories setup, Supabase, providers, RAG,
  tasks, libraries, API security, context, and readiness requirements.
- The global `FieldHelpLayer` supplies help to conventional labeled controls,
  including dynamic fields.
- Tests fail when a required surface refers to a missing help definition.

The final copy, rendered-page, and device accessibility audit remains a Phase 7
release task, but new Phase 2 setup fields can now use stable help keys from the
start.

## 8. Migration Checksum Procedure

For a new unreleased migration:

```powershell
corepack pnpm platform:checksums
corepack pnpm platform:check
```

The first command records SHA-256 values for every checked-in migration. The
second command fails on a missing file, unexpected file, renamed migration,
modified digest, release-version mismatch, migration-head mismatch, or
resource-manifest drift.

Do not regenerate checksums to legitimize an edit to a migration that has
already been released. Add a new migration instead.

## 9. Transitional Deployment Order

Phase 1 did not migrate a blank Supabase project from Railway. For repository
releases that still use the GitHub Supabase workflow, the safe production order
remains:

1. Run all local release gates.
2. Push the tested release commit to GitHub.
3. Apply Supabase migrations through the existing production workflow.
4. Deploy or redeploy the Railway services from that same commit.
5. Check `/api/health` for `status: operational`.
6. Run the authenticated API and ingestion smoke tests.

Deploying the application first is safe because web requests return `503` and
workers do not claim jobs, but applying the migration first avoids unnecessary
service interruption.

## 10. Verification

Phase 1 is covered by these release gates:

```powershell
corepack pnpm docs:check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
git diff --check
```

Phase 2 now provides the maintenance service that locks migration work,
populates the database checksum ledger, manages initializing and maintenance
states, and moves a blank project from `connected_uninitialized` to
`operational`. See
[Railway Deployment Phase 2](railway-deployment-phase-2-maintenance-bootstrap.md).
