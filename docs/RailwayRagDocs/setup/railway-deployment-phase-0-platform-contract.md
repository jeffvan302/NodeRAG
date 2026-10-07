# Railway Deployment Phase 0: Platform Contract

**Status:** Completed 2026-08-04. Counts last reconciled 2026-08-06.
**Started:** 2026-08-04
**Roadmap:** [Railway template, Supabase bootstrap, backup, and restore](railway-template-supabase-bootstrap-backup-roadmap.md)

## 1. Purpose

Phase 0 freezes the installation boundary before RAG Railway adds a maintenance
service, blank-project bootstrap, or backup execution. The objective is to make
deployment assumptions explicit and testable:

- GitHub defines application code, migrations, defaults, service definitions,
  and versioned contracts.
- Supabase contains installation data and live application configuration.
- Railway contains only connection roots, bootstrap and session secrets,
  service topology, and other values needed before Supabase is reachable.
- Portable backups contain application records and referenced Storage bytes,
  but never silently copy plaintext credentials.

The repository now fails `pnpm docs:check` when a runtime variable or required
Supabase resource drifts away from these contracts.

## 2. Versioned Artifacts

| Artifact                                             | Purpose                                                                                                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform/environment-variables.v1.json`             | Classifies every discovered runtime, image, release, and GitHub deployment variable by owner, source of truth, default, validation, requirement, secrecy, and backup policy. |
| `platform/supabase-resources.v1.json`                | Records the expected migration head and every migration-created table, function, extension, Storage bucket, and Edge Function.                                               |
| `platform/secret-redaction.v1.json`                  | Defines fields that are excluded, redacted, or regenerated during a portable restore and fixes default history-retention decisions.                                          |
| `platform/backup-manifest.v1.schema.json`            | Defines `manifest.json` for version 1 `.bragbackup` archives.                                                                                                                |
| `platform/migration-checksums.v1.json`               | Pins the SHA-256 digest and immutable filename of every checked-in migration.                                                                                                |
| `platform/data-plane-release.v1.json`                | Binds the installed application release to its migration ledger, current head, package format, and Maintenance compatibility floor.                                          |
| `platform/application-ownership-manifest.v1.json`    | Content-addressed inventory of application-owned tables/functions and protected provider schemas used during guarded target replacement.                                     |
| `platform/database-transfer-manifest.v1.schema.json` | Defines the credential-free sidecar that binds an encrypted S3 transfer set to its operation, source barrier, target analysis, and release contracts.                        |
| `scripts/verify-platform-contract.mjs`               | Discovers live configuration references and migration resources, then compares them with the checked-in contracts.                                                           |

These files are product definitions. They are reviewed and released with code;
they are not generated from a customer's live Supabase instance.

## 3. Configuration Inventory Result

The contract classified 111 variables when this phase closed. It now classifies
134, and the shape of the list has changed more than the size: Phase 3 moved 49
of them into the database, and Phases 2, 5 and 6 added the maintenance service,
the S3 destination and the restore path.

| Status                 | Count | Meaning                                                                           |
| ---------------------- | ----: | --------------------------------------------------------------------------------- |
| Live                   |    68 | Read by application code, an image, or a deployment workflow.                     |
| Migrated to database   |    49 | Moved into `platform_runtime_settings` in Phase 3 and edited under Configuration. |
| Compatibility          |     4 | Supported fallback that should be removed after configuration normalization.      |
| Obsolete compatibility |     3 | Present in setup examples but no longer controls current behavior.                |
| Tooling                |     6 | Local release or smoke-test input; never an installation setting.                 |
| Planned                |     2 | Required by a later roadmap phase and reserved now to prevent naming drift.       |
| Build constant         |     2 | Compiled release identity; not supplied as Railway configuration.                 |

Twenty-three entries are secrets. The verifier rejects any secret whose
effective backup policy is `included`.

These counts are printed by `pnpm docs:check`, which is the copy to trust if
this table has fallen behind again.

### 3.1 Values that remain in Railway

The final template keeps these classes in sealed Railway variables:

1. Supabase roots: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
   `SUPABASE_DB_PASSWORD`; optional `SUPABASE_DB_HOST` and `SUPABASE_DB_URL`
   support session-pooler and existing-installation overrides.
2. Authentication roots: `ADMIN_SETUP_TOKEN`, `ADMIN_SESSION_SECRET`, and
   `API_KEY_ENCRYPTION_SECRET`.
3. Service topology: the embedding service URL and shared internal token.
4. Railway control: the planned project/environment-scoped `RAILWAY_TOKEN`.
5. Backup encryption or off-site destination credentials.
6. Platform-provided process values such as `PORT`.

These values cannot be stored only inside Supabase because they are required to
find, authenticate to, initialize, or recover Supabase itself.

### 3.2 Values moving into Supabase

PDF, Word, Excel, worker policy, retry, timeout, batching, provider-model, and
retrieval settings currently have environment fallbacks. Phase 3 moves the
remaining operational choices into revisioned Supabase configuration. During
the transition:

- Environment values remain compatibility fallbacks.
- Saved Supabase configuration takes precedence where the application already
  supports it.
- A running job keeps the configuration revision captured at job start.
- A compatibility variable is removed only after one documented release cycle.

### 3.3 Variables that should not reach the template

`BACKEND_API_KEY`, `OPENAI_ANSWER_MODEL`, and `OPENAI_EMBEDDING_MODEL` are
documented as obsolete compatibility values. They remain in the contract so a
future removal is deliberate and auditable; they should not be added to the
Railway template prompts.

GitHub's Supabase access token, project references, and database passwords are
release-pipeline credentials for the current repository deployment. New
customer installations created from the completed Railway template will use
the maintenance service and will not require those GitHub secrets.

## 4. Supabase Resource Inventory

The manifest recorded 51 tables and 23 functions when this phase closed. It now
records:

- 60 application tables.
- 24 database functions. One fewer than the raw count of `create function`
  statements: `allocate_conversation_message_sequences` is created by one
  migration and dropped by the next, and the inventory now replays creates and
  drops in order rather than matching creates alone.
- `pgcrypto`, `vector`, and `supabase_vault` extensions.
- Six private Storage buckets: `original-documents`, `page-renders`,
  `extracted-assets`, `table-exports`, `parser-debug`, and `generated-files`.
- The `gte-small-embedding` Edge Function.
- Migration head `20260806000300_restore_jobs`. The head moves with every
  migration; the copy that matters is `RAG_RAILWAY_EXPECTED_MIGRATION_HEAD` in
  `packages/rag-core`, and the verifier fails the build if the manifest, the
  environment contract and the migration directory disagree with it.

Supabase-managed `storage.*`, `vault.*`, and
`supabase_migrations.schema_migrations` resources are listed separately because
RAG Railway verifies but does not create their base schemas.

Whenever a migration adds or removes a listed resource, the same commit must
update `platform/supabase-resources.v1.json`. The contract check prevents a
release from moving forward otherwise. Phase 1 added installation metadata,
the migration-checksum table, and the readiness RPC. Phase 2 will use the
manifest for live blank-project verification, including critical indexes, RLS
state, and policies.

## 5. Backup Format Version 1

The portable archive extension is `.bragbackup`; its physical format is a
streaming `tar.zst`. The schema in
`platform/backup-manifest.v1.schema.json` defines the archive's `manifest.json`.
It records:

- Backup ID, creation time, product, mode, and consistency state.
- Application release, Git commit, migration head, and backup-format version.
- Source installation and Supabase project references.
- Row counts, byte counts, paths, and SHA-256 hashes for every JSONL table.
- Object and byte counts plus manifest hashes for every Storage bucket.
- Whole-archive integrity and verification state.
- Every redaction or regenerate-on-restore rule applied.
- Encryption metadata without the encryption key.

The archive must also contain `checksums.sha256`, release metadata, table JSONL,
`storage/storage-manifest.jsonl`, Storage object bytes, and validation reports.
A disaster-recovery archive may additionally contain a native PostgreSQL dump.

## 6. Secret And History Decisions

Portable export version 1 makes these decisions now so backup implementation
cannot improvise later:

- Railway and GitHub environment values are excluded.
- Supabase Vault contents and provider-secret references are regenerated.
- Primary-admin and API-user password hashes are regenerated through controlled
  reset flows.
- API-key metadata and scopes may be retained, but key hashes and ciphertext are
  regenerated.
- Admin setup tokens, idempotency responses, and Ollama key leases are
  ephemeral and excluded.
- Webhook URLs are redacted because query strings may contain credentials.
- Audit and webhook history defaults to 90 days.
- Detailed Ask events and compression snapshots default to 30 days.
- Run summaries remain included because generated artifacts and user-visible
  histories refer to them.

Restore must leave integrations disabled until an administrator supplies new
credentials, reviews webhook destinations, and runs verification.

## 7. Contextual Help Inventory

The web application currently has ten user-facing routes. `FieldHelpLayer`
discovers labeled controls globally, while the typed `FIELD_HELP` catalog now
provides 82 reviewed definitions and a metadata-aware fallback for dynamic
fields. `REQUIRED_FIELD_HELP_SURFACES` records stable requirements for setup,
Supabase, providers, RAG, tasks, libraries, API security, context management,
and installation readiness. Tests fail when a required key is missing.

Phase 1 also added the shared `SectionHelp` component and used it on the model,
Supabase, task, and context configuration headings. Final rendered-page copy,
keyboard, touch, focus-return, clipping, and mobile viewport audits remain part
of the Phase 7 publication gate.

## 8. Verification

Run the contract alone:

```powershell
corepack pnpm platform:check
```

Run it as part of the normal documentation/release gate:

```powershell
corepack pnpm docs:check
```

The current successful result is:

```text
Platform contract v1 verified. 150 environment variables are classified.
113 tables, 128 functions, 7 buckets, and 1 Edge Function are inventoried.
107 migration checksums are pinned. Backup manifest format 1 and
secret-redaction policy 1 are valid. The current data-plane release owns 241
application objects.
```

## 9. Change Procedure

For every new environment variable:

1. Add the code reference.
2. Add the variable to exactly one contract group.
3. State its owner, source of truth, services, default, validation rule,
   requirement, secrecy, and backup behavior.
4. Add it to `.env.example` only when a local operator should set it.
5. Run `pnpm platform:check`.

For every migration:

1. Add a new timestamped migration; never edit applied migration history.
2. Update `expectedMigrationHead`.
3. Add or remove affected resources in the resource manifest.
4. Update the redaction policy when a new field can contain credentials.
5. Run the full repository tests before publication.

For a backup-format change, retain schema version 1 unchanged and introduce a
new schema/version with an explicit compatibility and restore policy.

## 10. Next Milestone

Phase 1 adds the database and runtime readiness foundation:

1. `platform_installations` and `platform_migration_checksums` migrations.
2. Build-derived application version and expected migration head.
3. Health states for `unconfigured`, `upgrade_required`, `operational`,
   `database_ahead`, and explicit incompatibilities.
4. Worker fail-closed behavior before any job claim when schema versions do not
   match.
5. Completion of the stable field-help inventory for current setup and
   configuration screens.

The maintenance service begins only after those readiness states can be trusted.
