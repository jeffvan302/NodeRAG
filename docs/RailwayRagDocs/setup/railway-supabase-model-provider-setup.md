# Railway, Supabase, And Model Provider Setup

Last reviewed: 2026-08-04.

This guide builds the deployed RAG Railway platform from the GitHub repository,
connects it to one Supabase project, and configures Ollama Cloud, local Ollama
embeddings, and/or OpenAI from the Railway admin dashboard.

After first-time setup, use the repository-root `update-and-deploy.bat`
workflow documented in [Update and deploy batch command](update-and-deploy-batch.md)
for routine GitHub, Supabase, Railway, and test releases.

## Resulting Deployment

| Service       | Railway config              | Runtime behavior                                                                                                                             |
| ------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `web`         | `/railway.web.json`         | Next.js admin UI and REST API. Railway Serverless is enabled and the service may sleep after more than ten idle minutes.                     |
| `worker`      | `/railway.worker-cron.json` | Continuously polls and processes ingestion/reprocessing jobs. It remains active so new uploads start promptly.                               |
| `embeddings`  | `/railway.embedding.json`   | Private Ollama `/embed` service. Railway Serverless is enabled; models stay warm for ten active minutes and the service can sleep when idle. |
| `maintenance` | `/railway.maintenance.json` | Private schema/bootstrap service. It sleeps when idle and wakes for signed setup, migration, and verification operations.                    |

Supabase supplies Postgres, pgvector, private storage, queues, configuration,
API/admin records, audit logs, and Vault. Ollama Cloud or OpenAI supplies
vision/chat model execution. The `embeddings` service supplies local Ollama
vectors because the selected embedding models are not Ollama Cloud models.

## 1. Prerequisites

- GitHub repository access.
- A Railway account connected to GitHub.
- A Supabase project on a suitable plan for the proof of concept.
- The Supabase project reference, project URL, database password, anon key,
  service-role key, and a personal access token.
- An Ollama Cloud API key and/or OpenAI API key when those providers are used.
- An admin bootstrap token you generate and store as a Railway secret.

Do not place any secret in Git, checked-in `.env` files, Bubble-visible fields,
or browser-readable `NEXT_PUBLIC_*` variables. Rotate any credential that was
ever pasted into source control, logs, chat, or screenshots.

## 2. Create And Prepare Supabase

1. Create the Supabase project before collecting project-specific keys.
2. In project settings, record the project reference and project URL.
3. In API settings, copy the anon key only where a browser client truly needs
   it. Railway server code requires the service-role key.
4. Store the database password in a password manager.
5. Create a Supabase personal access token for CLI/GitHub deployment.

Authenticate and apply the repository schema:

```powershell
npx supabase login
npx supabase link --project-ref <project-ref> --password <database-password>
npx supabase db push
npx supabase functions deploy gte-small-embedding
```

For repeatable deployments, add the five GitHub Actions secrets documented in
[database construction](../database/database-construction.md), then use the
staging or production workflow rather than editing production manually.

## 3. Create The Railway Project

1. Create a Railway project from this GitHub repository.
2. Create four services from the same repository: `web`, `worker`,
   `embeddings`, and `maintenance`.
3. Set each service's config-as-code path exactly as shown in the deployment
   table. Do not let `web` or `worker` inherit the root embedding config.
4. Give `web` a public Railway domain. `worker`, `embeddings`, and
   `maintenance` need no public domain.
5. Attach a persistent volume to `embeddings` at `/root/.ollama`. This prevents
   model downloads on every deployment/wake.
6. Keep GitHub autodeploy enabled on the intended branch after the first
   successful manual deployment.

The worker must not have a cron schedule or one-shot command. It uses the
start command from `/railway.worker-cron.json` and continuously claims jobs.

## 4. Configure Railway Variables

### Web Service

Required:

```text
NEXT_TELEMETRY_DISABLED=1
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
WORKER_EMBEDDING_URL=http://embeddings.railway.internal:8080
MAINTENANCE_URL=http://maintenance.railway.internal:8081
INTERNAL_SERVICE_TOKEN=<shared-random-value-at-least-32-characters>
ADMIN_AUTH_ENABLED=true
ADMIN_SETUP_ENABLED=true
ADMIN_SETUP_TOKEN=<long-random-bootstrap-token>
ADMIN_SESSION_SECRET=<long-random-session-secret>
```

Optional:

```text
WORKER_EMBEDDING_TOKEN=<shared-private-service-token>
OPENAI_API_KEY=<fallback-only>
OPENAI_BASE_URL=https://api.openai.com/v1
```

Use the Vault-managed dashboard settings for provider keys after initial
setup. Environment provider keys remain compatibility fallbacks.

### Ingestion Worker

Required:

```text
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
WORKER_INGEST_MODE=provider
WORKER_QUEUE_ENABLED=true
WORKER_EMBEDDING_URL=http://embeddings.railway.internal:8080
```

Set `WORKER_EMBEDDING_TOKEN` when the embeddings service uses
`WORKER_EMBEDDING_SERVER_TOKEN`. Start with the PDF, DOCX, Excel, embedding
batch, timeout, and retry defaults in `.env.example`; tune only after measured
jobs and logs identify the limiting stage.

### Embeddings Service

```text
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
WORKER_QUEUE_ENABLED=false
WORKER_EMBEDDING_SERVER_ENABLED=true
WORKER_EMBEDDING_SERVER_PORT=8080
OLLAMA_BOOTSTRAP=true
OLLAMA_PULL_EMBEDDING_MODELS=true
OLLAMA_EMBEDDING_MODELS=qwen3-embedding:0.6b,qwen3-embedding:4b,nomic-embed-text,nomic-embed-text-v2-moe
OLLAMA_WARM_EMBEDDING_MODEL=qwen3-embedding:0.6b
OLLAMA_EMBEDDING_BASE_URL=http://127.0.0.1:11434
OLLAMA_EMBEDDING_KEEP_ALIVE=10m
OLLAMA_EMBEDDING_NUM_THREADS=8
```

Optional shared authentication:

```text
WORKER_EMBEDDING_SERVER_TOKEN=<long-random-private-token>
```

Set the matching value as `WORKER_EMBEDDING_TOKEN` on `web` and `worker`.
Keep `OLLAMA_EMBEDDING_NUM_THREADS` aligned with the Railway CPU allocation;
allowing Ollama to size from the larger host CPU count can make inference
substantially slower.

### Maintenance Service

```text
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SUPABASE_DB_PASSWORD=<database-password>
# Optional when direct IPv6 is unavailable:
SUPABASE_DB_HOST=<session-pooler-host>
# Optional compatibility override for an existing installation:
SUPABASE_DB_URL=postgresql://.../postgres?uselibpqcompat=true&sslmode=require
INTERNAL_SERVICE_TOKEN=<same-value-as-web>
PORT=8081
```

Maintenance normally derives the complete owner-level connection URI from the
Supabase project URL and database password. It URL-encodes the password and
adds the owner role, database, port, and TLS parameters. Set only the session
pooler hostname when direct IPv6 cannot be reached. Do not add these database
owner values to `web`, `worker`, or `embeddings`. The maintenance health
endpoint reports only presence, never a value.

## 5. Deploy And Bootstrap The Admin

1. Deploy `maintenance` first and confirm its private `/health` endpoint is
   ready and `configured=true`.
2. Deploy `embeddings`. Its first build downloads Ollama and its first
   start pulls the selected models into the persistent volume.
3. Deploy `web` and verify `GET /api/health` or public
   `GET /api/v1/health`.
4. Open the web domain. `/setup` verifies the Railway values, accepts
   `ADMIN_SETUP_TOKEN`, applies all checked-in migrations through maintenance,
   creates defaults, and verifies the live schema and Storage buckets.
5. Create the first administrator in the final `/setup` stage.
6. Deploy the long-running `worker` and confirm its log reports provider ingest
   mode without exiting.
7. Sign in and replace the bootstrap token in Railway after recovery use. A
   newly generated token can bootstrap another administrator only while the
   server-side setup/recovery flow permits it; possessing an old token should
   not be treated as normal login access.

The legacy Supabase setup action in Model Configuration now refreshes only
post-migration application defaults. It never applies SQL migrations. See
[Phase 2 maintenance and blank-project bootstrap](railway-deployment-phase-2-maintenance-bootstrap.md)
for the migration protocol and recovery table.

### 5.1 Delegated administrators

The bootstrap administrator can open **API Usernames**, create or select an API
user, enable **Administrator access**, and save the user. At that user's next
login, the username opens the Admin Dashboard with the same application
administration features as the primary administrator. The session remains
identified as an API-user administrator in server-side authorization and audit
context.

The primary administrator is stored separately in `admin_users` and is not
shown in the API-user list. Delegated administrators cannot open the
original-admin setup/recovery interface or change that account's password.
Clearing **Administrator access** takes effect when the affected API user signs
out and signs in again.

## 6. Configure The Supabase Access Point

In the admin dashboard, open **Model Configuration**, then the Supabase gear
dialog.

Enter non-secret metadata:

- Project URL and project reference.
- Database host, port, database name, and database user.

Enter secret values only in the provided secret fields:

- Service-role key.
- Database password.
- Optional complete database URL.

The backend writes secret values to the encrypted local settings vault and returns only presence
flags. Run the database setup/status action below the Supabase configuration.
It verifies/bootstrap-checks the required extensions, tables, buckets, provider
rows, task defaults, and silo defaults supplied by the migrations.

## 7. Configure Ollama Cloud Access Points

Open **Ollama Access Points** under Model Configuration.

1. Set the default Ollama base URL. For Ollama Cloud use the currently required
   Ollama API base; for local development use `http://localhost:11434`.
2. The legacy/default key remains available with one simultaneous call.
3. Add each additional key as a named access point and set its allowed
   simultaneous calls from 1 through 20.
4. Save the key. It is stored in Vault; the UI later displays presence and
   current/total slots, not the secret.
5. Disable an access point to stop new leases. Delete it only when the key and
   any leases should be removed.

Ask, Extraction, image vision, and direct PDF page-group calls atomically lease
capacity from this shared pool. Configured PDF parallelism is capped by the
sum of available enabled slots. Leases are released after success/failure and
expire after a crashed process. Local embedding calls never consume this
Cloud key pool.

## 8. Configure OpenAI

Open the OpenAI provider gear dialog and set:

- Base URL, normally `https://api.openai.com/v1`.
- OpenAI API key.

Save through the dashboard so the secret is written to Vault. Keep
`OPENAI_API_KEY` as an environment fallback only when needed for migration or
recovery. Model names are assigned per task; a provider key alone does not
select a model.

## 9. Assign Models To Work

Configure each task independently:

| Task                   | Typical responsibility                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| Vision                 | Analyze uploaded images and eligible embedded PDF/DOCX images.                                           |
| Ask                    | Grounded question answering with optional streaming and model tools.                                     |
| Extraction             | Type-aware JSON, CSV, or Markdown extraction and Task steps.                                             |
| PDF assembly           | Optional model-assisted assembly/validation of page Markdown.                                            |
| Direct PDF page groups | Render one or more pages, send sequential images in one model call, and assemble returned page Markdown. |

For each task select provider, model, task instructions, reasoning effort,
input/output limits, and tool permissions. Ask and Extraction also configure:

- RAG mode: vector (default), hybrid, or keyword.
- Retrieval Top K.
- Maximum tool requests from 1 through 250 (default 64).
- **Max RAG searches per request** from 0 through 100 (default 8).

The request reaches the model before retrieval. The model chooses whether RAG
evidence is needed and may search up to the independent RAG limit. Set the
overall tool maximum high enough for research, document inspection, and
multi-step DOCX editing and finalization.

Available model tools are described in the dashboard-generated tool context.
The selected silo and optional project are bound by Railway before any tool
executes; models never select that security scope.

## 10. Configure Ingestion And Retrieval

Set canonical Markdown chunk size, overlap tokens, maximum limits, embedding
provider/model, and query retrieval defaults in RAG settings. Changing the
embedding model/version requires existing documents to be re-embedded before
vector results are comparable.

For PDF parsing choose one strategy:

- Current Poppler utilities pipeline with selective full-page/embedded-image
  vision for visual or anomalous pages.
- Direct vision page groups, where pages are rendered individually and an
  ordered group of page images is sent to the configured multimodal model.

Configure pages per call and parallel calls conservatively. Provider access-
point capacity, request byte limits, model context/output limits, and PDF
timeouts all cap effective concurrency.

## 11. Verify The Complete Deployment

Public API smoke checks:

```powershell
$base = "https://<railway-web-domain>/api/v1"
Invoke-RestMethod "$base/health"
Invoke-RestMethod "$base/me" -Headers @{ Authorization = "Bearer brk_your_key" }
```

Embedding smoke check from the deployed web container:

```powershell
railway ssh --service web pnpm --filter @bubble-rag/web embedding:smoke
```

Then perform one complete acceptance flow:

1. Create a silo and project.
2. Upload a small Markdown file with a unique idempotency key.
3. Poll document status until `ready` and verify heartbeat/timing fields.
4. Add the document to the project.
5. Run keyword, vector, and hybrid searches with and without `projectId`.
6. Run a streaming Ask, disconnect, and recover the run by ID.
7. Run JSON, CSV, and Markdown Extractions or a saved multi-step Task.
8. List/download generated files and verify overwrite/delete behavior.
9. Inspect API usage logs by request ID.

## Troubleshooting

| Symptom                                     | Check                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker deploy exits immediately             | Confirm `/railway.worker-cron.json`, no cron/override, valid Supabase variables, and current built worker output.                                         |
| Job remains `starting`                      | Inspect worker logs, job heartbeat/stage/error, queue ownership, and provider access capacity. Cancel/requeue only after diagnosing the active lease/job. |
| `embedding_unavailable` or `fetch failed`   | Check `embeddings` health, private DNS URL, matching private token, persistent model volume, model pull status, and wake retries.                         |
| Warm embeddings are unexpectedly slow       | Match `OLLAMA_EMBEDDING_NUM_THREADS` to Railway CPU quota and inspect phase timing rather than total request time alone.                                  |
| PDF page-group output is empty              | Verify model multimodal support, output limit, request size, timeout, rendered page count, and the detailed provider error in the job log.                |
| Supabase enum value error                   | Apply all current migrations before deploying code that writes the new status/stage.                                                                      |
| Bubble upload returns `file_required`       | Send either a real binary multipart `file` or an HTTPS `fileUrl`; do not manually set the multipart boundary.                                             |
| Mutation returns `idempotency_key_required` | Send a unique `Idempotency-Key` header for that logical operation.                                                                                        |

## Next References

- [Database construction](../database/database-construction.md)
- [Deployment notes](../deployment.md)
- [Secrets policy](../secrets-policy.md)
- [REST API command reference](../api/rest-api-command-reference.md)
- [Bubble plugin installation](../bubble-api-installation.md)
