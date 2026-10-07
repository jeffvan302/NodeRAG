# Running A Staging Track Beside Production

Last reviewed: 2026-08-06.

This describes how to run roadmap work on a second Railway project without
disturbing a production installation that people are testing against.

## The Thing That Actually Needs Separating Is Supabase

Railway is compute. Every piece of state anyone is testing — documents, chunks,
embeddings, storage objects, silos, libraries, API keys, runtime settings —
lives in Supabase. Two Railway projects pointed at one Supabase project are not
two installations; they are one installation with two front ends, and the
staging one can destroy the other.

**Sharing a database is not "slightly risky". It causes a production outage on
the first migration.** The mechanism:

1. Staging deploys a release containing a new migration.
2. The maintenance service applies it to the shared database.
3. Production's web and worker are still running the previous release, with an
   older `RAG_RAILWAY_EXPECTED_MIGRATION_HEAD` compiled in.
4. They compare heads, find the database ahead of them, and fail closed:
   `canProcessPlatformJobs` refuses a `database_ahead` state, health stops
   reporting operational, and the queue stops claiming jobs.

That behaviour is correct — a worker running against a schema it does not
understand is worse than a stopped one — but it means the blast radius of a
staging deploy onto a shared database is the whole production installation.

So: **one Supabase project per track.** Everything below assumes that.

## Layout

|                    | Production                       | Staging                                                                    |
| ------------------ | -------------------------------- | -------------------------------------------------------------------------- |
| Branch             | `main`                           | `dev`                                                                      |
| Supabase project   | production ref                   | a second, separate ref                                                     |
| Railway            | existing project                 | a new project                                                              |
| Migration workflow | `deploy-supabase-production.yml` | `deploy-supabase-staging.yml`                                              |
| Release command    | `.\update-and-deploy.bat`        | `.\update-and-deploy.bat -Environment staging -ApiBase <staging api base>` |

## Current Repository Tracks

The first isolated staging track was established on 2026-08-05. These
identifiers are routing metadata, not credentials:

|                       | Production testing                                     | Deployment-development staging                                 |
| --------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| Railway project       | `RAG Railway` (`06d46c29-51af-4ad8-bced-663df855a186`) | `RAG Railway Staging` (`a8bfd9ef-f316-402c-b406-fec8234f8487`) |
| Railway environment   | `production`                                           | `production` (`a77495c1-fc4f-41c9-af6d-def5755bc023`)          |
| Git branch            | `main`                                                 | `dev`                                                          |
| Supabase project ref  | `lpzrtslsgjdmvgttqcpu`                                 | `cpzydzlftbynjajxkdpf`                                         |
| Supabase display name | `BubbleAPI-Staging` — **wrong, see below**             | `RAG Railway` — **wrong, see below**                           |
| Public web URL        | `https://web-production-3bf65.up.railway.app`          | `https://web-production-f872b.up.railway.app`                  |

### The two Supabase projects are named after each other

The display names in the Supabase dashboard are crosswise: the project serving
**production** is called `BubbleAPI-Staging`, and the project serving
**staging** is called `RAG Railway`, which is the name of the _production_
Railway project. Nothing in the dashboard hints that either name is wrong.

This cost about a week in August 2026. Every attempt to repair production
reached for the only local file holding a database password —
`database/dev-database.txt`, headed "Supabase Dev Database, Name: RAG Railway" —
and used it against production. Those are `cpzydzlftbynjajxkdpf`'s credentials.
Production is `lpzrtslsgjdmvgttqcpu`. The password was always wrong, so the
symptom was always "cannot reach the database" or "cannot create the schema",
which reads like a broken installation rather than a mismatched secret.

**Trust the ref, never the name.** `SUPABASE_URL` carries the ref, and every
service reports a fingerprint of it at `/api/health` under
`connection.fingerprints.url`. To confirm which project an environment is
actually pointed at, compare that fingerprint rather than reading a label:

```
node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0,12))' https://<ref>.supabase.co
```

Renaming the two Supabase projects to match their roles is the real fix and
costs nothing; until that happens, this table is the authority.

The staging service IDs are:

| Service       | Staging service ID                     | Config file                           |
| ------------- | -------------------------------------- | ------------------------------------- |
| `web`         | `8537c146-1fdf-4698-aa19-62ddcaeda89c` | `/railway.web.json`                   |
| `worker`      | `4635bd04-7530-4497-9254-51714f9d7f75` | `/railway.worker-cron.json`           |
| `embeddings`  | `938b9ec5-ba93-49d9-a6c1-62d17063233c` | `/railway.embedding.json`             |
| `maintenance` | `11578d67-8ba0-4454-b0a6-86c1c8b54ccf` | `/railway.maintenance.json`           |
| `scheduler`   | `eb026a3a-5df9-45da-8d74-dee1a6ed3017` | `/railway.maintenance-scheduler.json` |

Open `https://web-production-f872b.up.railway.app/setup` to create the first
staging administrator. The staging-only setup token and installation secrets
are stored in the gitignored `database/staging-runtime-secrets.env`; never copy
those values into this document or reuse them in production.

Although Railway calls each new project's initial environment `production`,
the project itself is the staging boundary. All five services track `dev`, and
their Supabase URL and service-key fingerprints differ from the production
testing project.

`scripts/update-and-deploy.ps1` already understands this. `-Environment staging`
switches the expected branch to `dev` and the migration workflow to the staging
one, and refuses to run if the current branch does not match. The only reason to
pass `-ApiBase` is that the production URL is the built-in default for smoke
tests.

## One-Time Setup

### 1. The staging Supabase project

Create a second Supabase project. Note its project ref and database password.

### 2. GitHub secrets

`deploy-supabase-staging.yml` runs under the `staging` GitHub environment and
reads:

- `SUPABASE_STAGING_PROJECT_REF`
- `SUPABASE_STAGING_DB_PASSWORD`

The staging workflow builds a direct TLS database URL from the project ref,
password, and the track's session-pooler host, then passes it to
`supabase db push`. It does not require a Supabase account access token or
persist a CLI project link. Production still requires its account token
because that workflow also deploys the embedding Edge Function.

It triggers on pushes to `dev` that touch `supabase/**`, and can be run by hand.

### 3. The `dev` branch

```powershell
git checkout -b dev
git push -u origin dev
```

Work lands on `dev`, is proven on the staging track, and is merged to `main`
when production is ready to take it.

**Push `dev` first, and only `dev`.** When the split is created part-way through
a body of work, `main` is usually ahead of `origin/main` by everything that has
not been released yet. Pushing it is what deploys all of that to production, and
it is easy to do by reflex. Check before you push:

```powershell
git log --oneline origin/main..main
```

Anything listed there reaches production the moment `main` is pushed. `dev`
carries the same commits, so pushing `dev` alone gets the work onto staging and
leaves production exactly where it is.

The first push to `dev` runs two workflows. `tests.yml` runs on `main` and `dev`
alike. `deploy-supabase-staging.yml` fails at its secret-validation step until
the two staging secrets exist, which is a clean refusal rather than a partial
migration, so a red mark in Actions on that first push is expected.

Production migrations are `workflow_dispatch` only. Nothing reaches the
production database without someone starting it deliberately.

### 4. The staging Railway project

Create a new Railway project from the same GitHub repository, with each service
tracking `dev`. Branch is configured per service per environment, so this is set
on each service individually.

Services, matching production:

| Service      | Config file                                                    | Notes                                                        |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------------------ |
| web          | `railway.web.json`                                             | Next.js admin and `/api/v1`.                                 |
| worker       | `railway.worker-cron.json`                                     | Ingestion queue.                                             |
| embeddings   | `railway.embedding.json`                                       | Optional; only if staging needs local embeddings.            |
| maintenance  | `Dockerfile.maintenance`, `railway.maintenance.json`           | Migrations, bootstrap, connection promotion.                 |
| scheduler    | `Dockerfile.maintenance`, `railway.maintenance-scheduler.json` | Scheduled backups, retention, and missed worker wake sweeps. |
| postgres-sql | `railway.postgres.json`                                        | Private, persistent, continuously available local database.  |
| postgrest    | `railway.postgrest.json`                                       | Private, sleep-enabled REST interface for local PostgreSQL.  |

The project-level `.railway/railway.ts` file is authoritative for these
settings on current Railway installations. The individual JSON files remain
the equivalent definitions used by the template reconciler and upload tooling.

**Maintenance and scheduler must exist.** Maintenance owns migrations, the
read-only database probe, and connection promotion. Scheduler owns automated
backup windows, retention, and worker wake sweeps. A project without maintenance
cannot bootstrap a blank Supabase project or rotate credentials; a project
without scheduler has no unattended backup path.

### 5. Variables

Installation variables are inventoried in
`platform/environment-variables.v1.json`. Canonical values live once in the
Railway environment's Shared Variables; each listed service receives only a
reference. The staging-specific points:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the database password or
  explicit database URL must be the **staging** project's. Nothing else in this
  document matters if these are wrong.
- `INTERNAL_SERVICE_TOKEN` and `ADMIN_SESSION_SECRET` should be freshly
  generated, not copied from production. A shared session secret means a
  production admin cookie is valid on staging.
- `ADMIN_AUTH_ENABLED` and `ADMIN_SETUP_ENABLED` are non-secret shared
  variables referenced only by `web`. Both default to `true` for first setup;
  only an explicit `true` enables the corresponding login or recovery entry
  point, and neither value belongs in the Settings Vault.
- `ADMIN_SETUP_TOKEN` is needed for first-admin creation on the new project.
- Connect the **staging** Railway project from Configuration -> Railway
  connection and retain it in staging's Settings Vault. Do not copy a production
  Railway credential into staging variables.
- `WEB_INTERNAL_URL` on maintenance, pointing at staging's web service over
  private networking. Rotation is unavailable without it.
- `WORKER_INTERNAL_URL` on scheduler, pointing at staging's worker service over
  private networking so queued ingestion can be woken without a browser open.
- Backup S3 destination variables are shared once and referenced by maintenance
  and scheduler; the scheduler must apply retention to the same bucket
  maintenance writes to.
- `API_KEY_ENCRYPTION_SECRET` should also be fresh. It encrypts stored API keys,
  so a shared value means staging can decrypt production's.
- Operational settings are no longer environment variables. They live in the
  local Settings Vault and are edited under Configuration.

Railway Shared Variables are the runtime source of truth for installation
secrets. A local gitignored file may be used as a one-time recovery input, but
it is not a second maintained configuration store. Nothing in this document, or
anywhere else under `docs/`, should carry a key, password, or connection string.

### 6. The database connection

The normal template input is `SUPABASE_DB_PASSWORD`, not a hand-assembled URL.
Maintenance combines it with the project reference from `SUPABASE_URL` and
builds this direct connection internally:

```
postgresql://postgres:<encoded-password>@db.<ref>.supabase.co:5432/postgres?uselibpqcompat=true&sslmode=require
```

`SUPABASE_DB_URL` remains an optional complete-URL override for existing
installations. Two details decide whether the derived direct URL needs an
override:

- **The direct host `db.<ref>.supabase.co` is IPv6-only** on current Supabase
  projects. If the platform cannot resolve or reach it, set
  `SUPABASE_DB_HOST` to the session-pooler hostname from Supabase **Connect**.
  Maintenance keeps the password separate and builds the pooler form, which
  carries the project ref in the username instead of the hostname:

  ```
  postgresql://postgres.<ref>:<encoded-password>@<pooler-host>:5432/postgres?uselibpqcompat=true&sslmode=require
  ```

  Both shapes are supported. `projectRefFromDatabaseUrl` reads the ref from a
  `db.<ref>.` hostname and from a `postgres.<ref>` username, and identity
  verification requires the API URL, the service key and the database URL to
  agree on one project.

- **Use the session pooler on port 5432, not the transaction pooler on 6543.**
  Migrations run in a transaction and hold an advisory lock for their duration.
  The transaction pooler does not preserve either across statements, so the
  migration runner and the read-only probe would both misbehave — and the probe
  would report the migration lock as free while a migration was in fact running.

`sslmode=require` or stronger is enforced: `validateSupabaseConnectionIdentity`
refuses anything weaker outside local development.

## The Crossed-Id Guard

The Railway API token can rewrite any variable and redeploy any service in the
project it points at. The three service ids are typed in by hand. A staging
maintenance service holding production's service ids would redeploy production,
replacing production's Supabase credentials with staging's — and every API call
in that sequence would succeed.

`verifyRailwayIdentity` prevents it. Railway injects `RAILWAY_SERVICE_ID` into
every deployment, so maintenance knows its own id. If the id it was told is "the
maintenance service" is not itself, the whole set describes another deployment,
and promotion and finalize both refuse before anything is staged.

The Supabase Connection panel shows the project and environment names Railway
reports, so the target is visible before anyone presses a button.

Two related notes:

- `RAILWAY_PROJECT_ID` and `RAILWAY_ENVIRONMENT_ID` are **supplied by Railway**.
  Do not set them by hand. An override is the one way to defeat this guard.
- The guard is inert off Railway, where no ids are injected. That is deliberate:
  refusing there would make the flow impossible to exercise locally.

## First Deploy Of The Staging Track

1. Push `dev`. Confirm `origin/main` has not moved.
2. Set the two staging GitHub secrets, then run `deploy-supabase-staging.yml`
   against the blank project. Migrations must land before any service starts, or
   web and worker will come up reporting `migration_required` and refuse to
   claim jobs — which is correct, but confusing if it is unexpected.
   Both Supabase workflows use `db push --include-all`. This is required for the
   idempotent `20260714000350_default_tenant_project_prerequisites` compatibility
   seed: blank projects apply it before the historical silo migration, while an
   older installation that already passed that point can safely backfill it.
   `20260805000100_platform_installation_head` reconciles the readiness row
   after all Phase 3 resources exist. It is no longer the last migration —
   Phases 5 and 6 added three more — but it is still the one that decides
   whether services unblock, because they stay blocked until the recorded head
   matches the release they are running.
3. Create the Railway services with their variables, each tracking `dev`.
4. Open the staging web service, complete `/setup`, and create the first
   administrator with `ADMIN_SETUP_TOKEN`.
5. Check `/api/health` before doing anything else. It is the fastest way to
   confirm the split is real:

   | Field                               | What to look for                                  |
   | ----------------------------------- | ------------------------------------------------- |
   | `status`                            | `operational`. Anything else names what is wrong. |
   | `application.expectedMigrationHead` | matches the head just applied                     |
   | `connection.fingerprints`           | **different from production's**                   |
   | `workers.queue.status`              | `idle`, not `blocked`                             |
   | `workers.maintenance.reachable`     | `true`                                            |

   The fingerprints are the check that matters. Twelve-character hashes of the
   three connection values, on every service's health endpoint. If staging's
   match production's, the two tracks are sharing a database and the split is
   not real — stop and fix that before ingesting anything.

6. Release afterwards with:

   ```powershell
   .\update-and-deploy.bat -Environment staging -ApiBase https://<staging-web>/api/v1
   ```

## Moving Work Between Tracks

Roadmap work is developed on `dev` and released to staging. When it is proven,
merge `dev` into `main` and release to production normally.

Migration ordering is the thing to watch. Production applies migrations at
release time, so a migration that reached staging weeks earlier still arrives at
production in the same commit that needs it. Do not cherry-pick a schema change
to production ahead of the code that expects it, and do not merge `main` into
`dev` in a way that reorders migration filenames — the head comparison is
lexicographic over immutable filenames.

`platform/migration-checksums.v1.json` pins the contents of every applied
migration. Editing a migration that staging has already run changes its
checksum, and `verify-platform-contract.mjs` fails the release rather than
letting two installations disagree about what a filename means. Correct a
mistake with a new migration; never by editing one that has shipped.

### While the two tracks are on different releases

This is the normal state, and it is worth knowing what it looks like:

- Staging is ahead. Its database has migrations production has never seen.
- Production is untouched and unaware. It never reads staging's database, so
  there is nothing to reconcile.
- The Supabase Connection panel on either track classifies the other's project
  as `incompatible`, because the installed head does not match its own expected
  head. That is the probe working, not a fault.

## Verifying The Split Is Real

Cheap checks, worth running once after setup and again after any variable edit:

| Check                    | How                                                               | Expected                                             |
| ------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------- |
| Different databases      | Compare `connection.fingerprints` on both `/api/health` endpoints | All three differ                                     |
| Different Railway target | Supabase Connection panel, "rotation would redeploy"              | Names the staging project, pill reads `this project` |
| Branch tracking          | Railway service settings, per service                             | Staging on `dev`, production on `main`               |
| No shared session        | Log into staging in a private window                              | Production's cookie does not authenticate            |

The first is the one that catches the failure that matters. The other three are
recoverable; a shared database is not.

## Retiring The Staging Track

The staging Supabase project holds real ingested documents and embeddings. Delete
the Railway project first, then the Supabase project, and only once nothing is
still being tested against it. Nothing on the staging track is backed up until
roadmap Phase 5 lands.
