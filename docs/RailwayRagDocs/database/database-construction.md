# Supabase Database Construction

Last reviewed: 2026-08-02.

## Source Of Truth

The ordered SQL files in `supabase/migrations/` are the database source of
truth. Never hand-build production tables in Supabase Studio and then leave
the change out of GitHub. Add a new timestamped migration, review it, test it,
and apply it with the Supabase CLI or the supplied GitHub Actions workflows.

`supabase/config.toml` defines local Supabase services and private storage
buckets. `supabase/seed.sql` contains safe bootstrap data and must not contain
customer files, API keys, provider secrets, or production credentials.

## Prerequisites

- A Supabase project and database password.
- The project reference shown in Supabase project settings or the project URL.
- A Supabase personal access token for CLI/GitHub deployment.
- Node.js and the repository dependencies.
- Supabase CLI, used in this environment as `npx supabase <command>`.

## Local Link And Push

From the repository root:

```powershell
npx supabase login
npx supabase link --project-ref <project-ref> --password <database-password>
npx supabase db push
```

Production deployment also includes the fallback Edge Function:

```powershell
npx supabase functions deploy gte-small-embedding
```

The CLI writes local link metadata below `supabase/.temp/`; do not use that
directory as application configuration. Railway still needs its own
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` variables.

## GitHub Actions Deployment

The repository includes:

| Workflow                                           | Trigger                                                      | GitHub environment |
| -------------------------------------------------- | ------------------------------------------------------------ | ------------------ |
| `.github/workflows/deploy-supabase-staging.yml`    | Push to `dev` when Supabase files change, or manual dispatch | `staging`          |
| `.github/workflows/deploy-supabase-production.yml` | Manual dispatch                                              | `production`       |

Configure these GitHub Actions secrets:

```text
SUPABASE_ACCESS_TOKEN
SUPABASE_STAGING_PROJECT_REF
SUPABASE_STAGING_DB_PASSWORD
SUPABASE_PRODUCTION_PROJECT_REF
SUPABASE_PRODUCTION_DB_PASSWORD
```

The workflows validate required values, run `supabase link`, and execute
`supabase db push`. Production also deploys `gte-small-embedding`. Keep staging
and production project references/passwords separate.

## Schema Construction Order

Migrations are cumulative. Their current responsibilities are:

| Migration group     | Constructs or changes                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `20260714000100`    | Core enums and tables for tenants, legacy projects, documents/files/pages/assets/chunks/embeddings, processing jobs, models, extraction/question/usage records, timestamps, and vector matching. |
| `20260714000200`    | Private storage bucket registration.                                                                                                                                                             |
| `20260714000300`    | Provider secret references, Vault read/write helpers, setup status, and bootstrap functions.                                                                                                     |
| `20260714000400`    | Silo boundary and silo-aware retrieval/bootstrap behavior.                                                                                                                                       |
| `20260714000500`    | Provider access configuration, model task configuration, and generated files/storage.                                                                                                            |
| `20260715-20260716` | Tool context, Supabase connection metadata, generated-file stable IDs, PDF assembly, large-PDF limits, and image assets.                                                                         |
| `20260719-20260720` | Admin/bootstrap authentication, API keys, idempotency, usage logs, webhooks, API test users, and RAG settings.                                                                                   |
| `20260722-20260726` | Delete/cancel scopes, chunk source offsets, embeddings, Markdown/Excel uploads, RAG context, and PDF parse strategies.                                                                           |
| `20260727`          | Direct-vision job stages, extraction Tasks/runs/items, and silo project memberships.                                                                                                             |
| `20260729-20260730` | Bubble API delivery support, safe silo cascade deletion, and diagnostic request/response payloads.                                                                                               |
| `20260731`          | Durable Ask run events and streaming recovery.                                                                                                                                                   |
| `20260801`          | Ask management, dynamic vector search, document-Markdown agent access, pooled Ollama keys, leases, and pool diagnostics.                                                                         |

Do not squash already-deployed migrations. Add a later migration for every
forward fix so staging and production remain reproducible.

## Important Persistent Objects

| Area             | Main objects                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge        | `silos`, `documents`, `document_files`, `document_pages`, `document_assets`, `document_chunks`, `document_embeddings`                 |
| Project subsets  | `projects`, `document_project_memberships`                                                                                            |
| Processing       | `processing_jobs`, `rag_ingestion_settings`                                                                                           |
| Providers/models | `provider_access_configs`, `provider_secret_refs`, `model_task_configs`, `model_config`                                               |
| Ask/Extraction   | `question_logs`, `ask_run_events`, `extraction_runs`, `extraction_results`                                                            |
| Saved Tasks      | `extraction_tasks`, `extraction_task_items`, `extraction_task_runs`, `extraction_task_run_items`                                      |
| Generated output | `generated_files`                                                                                                                     |
| API/security     | `admin_users`, `admin_setup_tokens`, `api_keys`, `api_test_users`, `api_idempotency_keys`, `api_usage_logs`, `api_webhook_deliveries` |
| Ollama capacity  | `ollama_api_keys`, `ollama_api_key_leases`                                                                                            |

`admin_users` contains the separate bootstrap/recovery administrator and is
not exposed by API-user management. `api_test_users.is_admin` grants an API
user delegated dashboard administration while preserving that API user's own
session identity and assigned API key.

## Storage Buckets

All configured buckets are private:

| Bucket               | Purpose                                                               | Configured maximum object size |
| -------------------- | --------------------------------------------------------------------- | -----------------------------: |
| `original-documents` | Uploaded PDF, DOCX, Excel, Markdown, text, CSV, PNG, and JPEG sources |                        100 MiB |
| `page-renders`       | Rendered PDF pages used by vision                                     |                         25 MiB |
| `extracted-assets`   | Embedded images and extracted JSON/CSV assets                         |                         25 MiB |
| `table-exports`      | JSON, CSV, and Markdown generated/exported files                      |                         10 MiB |
| `parser-debug`       | Parser diagnostics and debug text                                     |                         25 MiB |

The application may enforce its own request-size limits before storage. Keep
API, Railway proxy, and bucket limits aligned when increasing upload size.

## Bootstrap And Verification

After migrations are applied:

1. Open the Railway admin dashboard and authenticate with the admin bootstrap
   token if no administrator exists.
2. Open the Supabase access-point gear dialog and enter project metadata plus
   any Vault-managed service/database credentials.
3. Run the dashboard database setup/status action. It calls the migration-
   supplied setup helpers and reports required tables, buckets, defaults, and
   extensions.
4. Verify `/api/v1/health` without a key.
5. Create a scoped API key and verify `/api/v1/me` with `Authorization: Bearer
<key>`.
6. Create a test silo, ingest a small text/Markdown file, and wait for `ready`.
7. Run keyword and vector searches. For local Ollama vectors, verify the
   `embeddings` service and `match_document_embeddings` RPC.
8. Delete the test silo through the admin manifest flow when validation is
   complete.

## Change Discipline

- Never commit service-role keys, database passwords, provider keys, access
  tokens, customer sources, extracted text, or customer vectors.
- Review destructive functions and cascade behavior separately from ordinary
  additive migrations.
- Preserve the silo/project predicates in vector RPCs and all model tools.
- Add/update API documentation and tests whenever a database change alters an
  external response, error, status, or lifecycle.
