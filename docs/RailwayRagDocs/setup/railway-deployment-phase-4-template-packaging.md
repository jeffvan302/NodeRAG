# Railway Template Packaging

Last reviewed: 2026-08-28.

This document describes the current version 4 Railway template. Earlier
five-service/Supabase-first packaging notes are historical and no longer match
the local Settings, PostgreSQL, and PostgREST architecture.

## Released topology

`platform/railway-template.v1.json` is the canonical, reviewed contract for an
eight-service installation:

| Service                 | Role                                                   | Public | Persistent data            |
| ----------------------- | ------------------------------------------------------ | ------ | -------------------------- |
| `web`                   | Admin site and public API                              | Yes    | None                       |
| `worker`                | Ingestion and background work                          | No     | None                       |
| `maintenance`           | Schema, transfer, backup, restore, and Railway control | No     | None                       |
| `maintenance-scheduler` | Scheduled backup trigger                               | No     | None                       |
| `embeddings`            | Optional local Ollama models                           | No     | `/root/.ollama`            |
| `settings`              | Encrypted local configuration and identity vault       | No     | `/data`                    |
| `postgres-sql`          | Default relational database with pgvector              | No     | `/var/lib/postgresql/data` |
| `postgrest`             | Default relational REST API                            | No     | None                       |

Only `web` is published. Every service tracks the protected `main` branch so a
published template update is visible to deployed projects. PostgreSQL 16 and
PostgREST 14.16 are digest-pinned in both the release metadata and Dockerfiles.

## Fresh installation

1. Deploy the version 4 template. Railway creates all eight services, the
   Settings/PostgreSQL/Ollama volumes, and generated shared credentials.
2. Maintenance registers blank private PostgreSQL, plays the retained migration
   chain to the release head, verifies its identity, and registers PostgREST
   against that exact database.
3. Open `/setup` and verify `ADMIN_SETUP_TOKEN`.
4. Enter a Supabase project URL and service-role key for document object
   storage. Setup performs a credentialed Storage probe; the database remains
   Railway PostgreSQL.
5. Settings activates local PostgreSQL, local PostgREST, and the independent
   object destination as route revision 1. This is allowed only when no other
   route exists.
6. Create the first administrator, configure providers, ingest and search a test
   document, and verify an encrypted S3 backup.

The setup screen never accepts a password for the template-local database.
Railway generates that credential once and shares it only with its consumers.

## Updating a six-service installation

`platform/railway-template-upgrades.v1.json` defines the version 1 upgrade:

- preserve all existing services, Settings records, and volumes;
- add `postgres-sql` and `postgrest` plus their five shared variables;
- register the local pair as inactive candidates;
- never replace an existing active Supabase or external route;
- play schema forward automatically only for a registered Railway database; and
- require an approved attach, transfer, or Data API switch for later changes.

Installing the services is not permission to copy data, delete a source, or
change the active connection.

## Release checks

```powershell
pnpm docs:check
pnpm test
pnpm build
pnpm test:railway-postgres
pnpm test:railway-postgrest
```

The checks cover the canonical and generated template artifacts, variable
sheet, image pins, main-branch update channel, six-to-eight-service contract,
retained empty/known-head migration fixtures, empty-volume provisioning, and
PostgREST identity/readiness.

Live template publication and its update badge remain Railway control-plane
checks. Record them with Phase 9 certification evidence.

See [PostgreSQL/PostgREST Portability Phase 8](railway-postgres-postgrest-portability-phase-8.md)
for the implementation record and upgrade notes.
