# Bubble API Current State

Last updated: 2026-08-02

This document records the current state of the Bubble-facing API. It is the
capability baseline for configuring or validating a Bubble API Connector/plugin
integration and for checking feature parity with the Railway API test website.

The implementation-ready Bubble installation and delivery plan is maintained in `docs/bubble-integration-delivery-guide.md`.

## Current API Surface

The public API is hosted by the Railway web service.

Production base URL:

```text
https://web-production-3bf65.up.railway.app/api/v1
```

Local development base URL:

```text
http://127.0.0.1:3000/api/v1
```

The full endpoint reference is maintained in `docs/api-usage.md`. The older proof-of-concept route inventory is maintained in `docs/api-contracts.md`.

## Authentication

Bubble should authenticate to Railway with a backend-generated API key. The key is created from the Railway admin dashboard and starts with `brk_`.

Every Bubble API Connector call to `/api/v1`, except `/health`, should send:

```text
Authorization: Bearer brk_your_api_key_here
```

The API key must be stored in Bubble as a private API Connector value or private shared header. It must not be exposed in Bubble page JavaScript, user-visible fields, logs, screenshots, or client-side workflows.

Mutating endpoints require an idempotency header:

```text
Idempotency-Key: unique-bubble-workflow-id-or-generated-uuid
```

Bubble should generate a new idempotency key for each create/upload/delete/cancel/reprocess/ask/extraction request, and reuse the same key only when retrying the same operation after a timeout or network failure.

Successful replays include `Idempotency-Replayed: true`. Reusing a
create-project key after its original project has been deleted returns
`409 idempotency_replay_resource_deleted` rather than a stale successful
response.

## Recommended API Key Scopes For Bubble

For a full-feature Bubble app, create a Bubble-specific key with these scopes:

```text
silos:read
silos:write
documents:read
documents:ingest
documents:delete
documents:reprocess
documents:cancel
rag:ask
rag:extract
generated-files:read
generated-files:delete
api-usage:read
```

For a read-only or limited Bubble experience, remove scopes that should not be exposed to that app. Silo-level API key restrictions are not implemented yet, so scopes currently apply tenant-wide.

## Bubble Feature Goals

The Bubble integration should support the following user capabilities:

1. Create a silo.
2. Upload files to a selected silo.
3. Inspect silo status, document upload state, ingestion progress, heartbeat, and processing time.
4. Execute Ask requests against silo-scoped RAG content.
5. Execute extraction requests and check extraction status/results.
6. Search indexed RAG content directly.
7. Search/list documents stored in the database.
8. Download original uploaded files.
9. Download generated Markdown/text versions of ingested documents.
10. Browse and download newly generated files such as JSON, CSV, Markdown, and text outputs.
11. Delete generated files where cleanup is needed.
12. Cancel or reprocess document jobs where long-running jobs fail or stale jobs need cleanup.
13. Create reusable extraction Tasks, run them against a selected silo, and monitor each sequential extraction step.

## Current Capability Mapping

| Bubble capability                   | Current endpoint support                                       | Status                                      |
| ----------------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| Health check                        | `GET /api/v1/health`                                           | Available                                   |
| Inspect API key/scopes              | `GET /api/v1/me`                                               | Available                                   |
| Create silo                         | `POST /api/v1/silos`                                           | Available                                   |
| List silos                          | `GET /api/v1/silos`                                            | Available                                   |
| Fetch one silo                      | `GET /api/v1/silos/{siloId}`                                   | Available                                   |
| Fetch one project in a silo         | `GET /api/v1/silos/{siloId}/projects/{projectId}`              | Available                                   |
| Upload file to silo                 | `POST /api/v1/silos/{siloId}/documents`                        | Available                                   |
| List documents in silo              | `GET /api/v1/silos/{siloId}/documents`                         | Available                                   |
| Fetch document metadata             | `GET /api/v1/documents/{documentId}`                           | Available                                   |
| Fetch document status/progress      | `GET /api/v1/documents/{documentId}/status`                    | Available                                   |
| Fetch document ingestion statistics | `GET /api/v1/documents/{documentId}/ingestion-stats`           | Available                                   |
| Fetch document chunks               | `GET /api/v1/documents/{documentId}/chunks`                    | Available                                   |
| Download original file              | `GET /api/v1/documents/{documentId}/download`                  | Available                                   |
| Download Markdown/text file         | `GET /api/v1/documents/{documentId}/text`                      | Available                                   |
| Create original download ticket     | `POST /api/v1/documents/{documentId}/download-ticket`          | Available                                   |
| Create Markdown download ticket     | `POST /api/v1/documents/{documentId}/markdown-download-ticket` | Available                                   |
| Reprocess document                  | `POST /api/v1/documents/{documentId}/reprocess`                | Available                                   |
| Retry embeddings only               | `POST /api/v1/documents/{documentId}/embed`                    | Available                                   |
| Cancel active document job          | `POST /api/v1/documents/{documentId}/cancel`                   | Available                                   |
| Delete document                     | `DELETE /api/v1/documents/{documentId}`                        | Available                                   |
| Direct RAG search                   | `POST /api/v1/silos/{siloId}/rag-search`                       | Available                                   |
| Ask tool                            | `POST /api/v1/silos/{siloId}/ask`                              | Available; optional model-status webhook    |
| Stream Ask progress                 | `POST /api/v1/silos/{siloId}/ask/stream`                       | Available                                   |
| List/filter Ask runs                | `GET /api/v1/ask-runs`                                         | Available                                   |
| Clear terminal Ask history          | `DELETE /api/v1/ask-runs`                                      | Available                                   |
| Fetch/recover Ask run               | `GET /api/v1/ask-runs/{runId}`                                 | Available                                   |
| List extraction runs                | `GET /api/v1/silos/{siloId}/extractions`                       | Available                                   |
| Execute standalone extraction       | `POST /api/v1/silos/{siloId}/extractions`                      | Available; optional model-status webhook    |
| Fetch extraction result             | `GET /api/v1/extractions/{extractionId}`                       | Available                                   |
| List saved extraction Tasks         | `GET /api/v1/tasks`                                            | Available                                   |
| Create saved extraction Task        | `POST /api/v1/tasks`                                           | Available                                   |
| Fetch/update/delete extraction Task | `GET` / `PUT` / `DELETE /api/v1/tasks/{taskId}`                | Available                                   |
| Replace Task step sequence          | `PUT /api/v1/tasks/{taskId}/items`                             | Available                                   |
| Run extraction Task on silo         | `POST /api/v1/tasks/{taskId}/run`                              | Available; lifecycle/status webhook         |
| List Task runs                      | `GET /api/v1/task-runs`                                        | Available                                   |
| Fetch Task run details              | `GET /api/v1/task-runs/{runId}`                                | Available                                   |
| Cancel Task run                     | `POST /api/v1/task-runs/{runId}/cancel`                        | Available                                   |
| Rebuild Task run                    | `POST /api/v1/task-runs/{runId}/rebuild`                       | Available                                   |
| List generated files                | `GET /api/v1/silos/{siloId}/generated-files`                   | Available                                   |
| Read generated JSON                 | `GET /api/v1/generated-files/{fileId}/json`                    | Available                                   |
| Download generated file             | `GET /api/v1/generated-files/{fileId}/download`                | Available                                   |
| Create generated download ticket    | `POST /api/v1/generated-files/{fileId}/download-ticket`        | Available                                   |
| Delete generated file               | `DELETE /api/v1/generated-files/{fileId}`                      | Available                                   |
| Read API usage logs                 | `GET /api/v1/usage-logs`                                       | Available                                   |
| Read RAG settings                   | `GET /api/v1/rag-settings`                                     | Available                                   |
| Update RAG settings                 | `PUT /api/v1/rag-settings`                                     | Available, should usually remain admin-only |

## File Types Currently Supported

The ingestion worker currently supports:

- PDF
- DOCX
- Excel workbooks
- Markdown
- Plain text
- CSV
- PNG
- JPEG

PDF, DOCX, and Excel files are converted into canonical Markdown before chunking and embedding. Markdown, text, and CSV files use the same Markdown-to-chunks-to-embeddings path without a separate vision call. Image files can be processed through the configured vision task.

## Silo Workflow

Bubble should treat silos as the top-level dataset selector.

Typical workflow:

1. Call `GET /api/v1/silos` to populate a silo dropdown.
2. Call `POST /api/v1/silos` when a user creates a new silo.
3. Store the returned `silo.id` in Bubble.
4. Use that `silo.id` for document uploads, RAG search, Ask, extraction, and generated-file browsing.

Task definitions are not silo-specific. Bubble should create or select a saved Task first, then replace its step sequence with `PUT /api/v1/tasks/{taskId}/items` as needed. Empty Tasks are valid while a workflow is being drafted. Each Task step stores its name, extraction request, `outputFileEnabled` flag, output file name, and output type (`json`, `csv`, `md`, or `docx`). RAG mode and retrieval Top K are inherited from the configured Extraction model task. A step with `outputFileEnabled: false` can build the shared Task Dataset cache without creating a generated file; it is still tracked and counted as a completed step. File-producing steps continue to create one generated file each, while an empty Task run completes successfully without generating files.

Create silo body:

```json
{
  "name": "Client A",
  "description": "Client A source documents"
}
```

Required headers:

```text
Authorization: Bearer brk_your_api_key_here
Content-Type: application/json
Idempotency-Key: unique-key
```

## Upload And Ingestion Workflow

Bubble should upload files as multipart form data.

Endpoint:

```text
POST /api/v1/silos/{siloId}/documents
```

Required multipart field:

```text
file
```

Useful optional fields:

```text
processingDepth=standard
webhookUrl=https://your-bubble-webhook-url
webhookSecret=shared-secret
```

Current recommendation: start with polling rather than webhooks. Polling is simpler to implement and diagnose in Bubble. Webhooks can be added after the main upload/status flow is stable.

Bubble should store these returned IDs:

- `document.id`
- `job.id`
- `document.silo_id`
- `document.file_name`
- `document.status`

## Status And Timing Workflow

Bubble should poll document status after upload.

Endpoint:

```text
GET /api/v1/documents/{documentId}/status
```

This returns document status, latest job status, progress, heartbeat/timing data, and counts for chunks, embeddings, and assets. Bubble should show:

- Document status.
- Latest job status.
- Latest job stage.
- Processing progress.
- Heartbeat timestamp.
- Started/finished timestamps.
- Runtime duration when available.
- Chunk count.
- Embedding count.
- Asset count.
- Last error if failed.

For provider performance after or during PDF vision ingestion, call:

```text
GET /api/v1/documents/{documentId}/ingestion-stats
```

It reports calls, successes, failures, response-time minimum/maximum/mean/
population standard deviation, pages-per-call minimum/maximum/mean/population
standard deviation, and the same breakdown by provider and model. Add `jobId`
to select a specific older ingestion or reprocessing run.

Important statuses:

```text
uploaded
queued
extracting_text
ocr_running
vision_running
embedding
ready
failed
deleted
```

Bubble should not allow Ask or extraction against a document/silo until the relevant document status is `ready` and embeddings exist for vector/hybrid search.

## Document Search And Browsing

Bubble needs two related search/browse paths:

1. Database document browsing.
2. RAG content search.

For document browsing, use:

```text
GET /api/v1/silos/{siloId}/documents?page=1&pageSize=20
GET /api/v1/silos/{siloId}/documents?status=ready&page=1&pageSize=20
GET /api/v1/documents/{documentId}
GET /api/v1/documents/{documentId}/chunks
```

For RAG content search, use:

```text
POST /api/v1/silos/{siloId}/rag-search
```

RAG search supports:

- Keyword search.
- Vector search.
- Hybrid search.
- Score cutoff.
- Top-K result limits.
- Optional document filter.
- Source document name and ID in results.
- Neighbor chunk context.
- Original or Markdown retrieval references.

Bubble should display both:

- The matching chunk/snippet.
- The `sourceDocument.id` and `sourceDocument.name`.

This matters because multiple documents can have the same file name.

## Ask Workflow

Endpoint:

```text
POST /api/v1/silos/{siloId}/ask
```

Ask body example:

```json
{
  "question": "What are the main recommendations related to sidewalks?",
  "searchMode": "vector",
  "convertRequestToModelTools": true,
  "webhookUrl": "https://your-bubble-webhook-url",
  "webhookSecret": "shared-secret"
}
```

The webhook fields are optional. When configured, every model-authored status
update sends a `model.status.updated` callback containing the original Ask
question and the structured `modelStatus` object. Ask create, list, and status
responses expose `webhookConfigured` and `webhookSigned`, but never return the
URL or secret.

`convertRequestToModelTools` is optional and Ask-only. When enabled, the
configured Ask model first compiles the original question into a more precise
request using a manifest of the selected silo's actual RAG, library, Federated
Data, Template Group, workspace, output-file, and swarm capabilities. The
manifest also contains a compact source-document inventory for the active
scope. The preflight uses lightweight reasoning and returns a structured plan
so repetition is removed before the main coordinator receives it. The original
question is preserved for history and reruns. Admins edit the
conversion policy through the **agentic instructions for Ask queries** line in
Configuration, and Ask users enable it with **Convert request to model-specific
tools** on the Ask tab. The converted request and capability summary are
recorded in the run events and usage telemetry.

Optional generated-file output:

```json
{
  "question": "Create a short JSON summary of the sidewalk-related projects.",
  "searchMode": "vector",
  "outputFile": {
    "enabled": true,
    "format": "json",
    "fileName": "sidewalk-projects.json"
  }
}
```

Bubble should store:

- `answer`
- `confidence`
- `sources`
- `askRun.id` (the durable run ID; this is also the question log ID)
- `generatedFile.id` when returned
- `usage.searchMode`
- `usage.embedding`
- `usage.modelTrace` for completed model/tool-loop diagnostics

`topK` is optional on direct Ask and Extraction calls. If Bubble omits it, Railway uses the saved Ask or Extraction model task configuration. Direct RAG search still has its own `topK` because it does not run through a model task.

### Streaming And Disconnect Recovery

For live progress, use:

```text
POST /api/v1/silos/{siloId}/ask/stream
Accept: application/x-ndjson
```

The request body, API-key scope, and idempotency rules are the same as ordinary
Ask. Railway returns one JSON event per line. Events cover retrieval, model
calls, provider-supported reasoning/thinking summaries, model output, executed
tools and their results, generated-file work, and final success or failure.
`ask.completed.payload.result` contains the same final result shape returned by
the ordinary Ask endpoint.

The server persists each event before or while it is streamed. Save the
`X-Ask-Run-Id` response header or the `runId` field from any event. If Bubble
disconnects, the Ask run continues independently and can be recovered with:

```text
GET /api/v1/ask-runs/{runId}?afterSequence=0&eventLimit=100
```

Advance `afterSequence` to the largest event sequence already stored by Bubble
and poll until `askRun.terminal` is true. The event journal is ordered and
durable, so reconnecting does not require restarting the model call. A repeated
stream POST with the same idempotency key reports the original run ID and status
URL as an `ask.replayed` event rather than executing the Ask again.

If the caller did not retain the run ID, it can discover persisted history
with:

```text
GET /api/v1/ask-runs?siloId={siloId}&projectId={optionalProjectId}&status={status}&page=1&pageSize=50
```

Use the returned `statusUrl` to load the full event journal and final answer.
Both list and detail responses also include `rerunRequest`, which preserves the
effective question, scope, RAG mode, Top K, and output-file settings for
prefilling a new Ask. The Ask page's **Use in new Ask** action restores those
values without modifying or automatically rerunning the historical record.
Ask and Extraction's editable Model Task instructions are tool-neutral; enabled
tools contribute their own current descriptions and invocation contracts at
runtime instead of being copied into those saved instructions.
Old terminal history can be cleared with `DELETE /api/v1/ask-runs` using the
same silo/project query filters, `confirm=true`, and a unique
`Idempotency-Key`. Active runs and generated files are retained.

The Ask agent loop can execute the enabled `rag_documents`, `rag_search`,
`list_files`, `get_document_markdown`, and `write_file` tools. `rag_documents`
is read-only document discovery for Ask and general Extraction: it accepts
exactly one query or a batch of 1-12 string/keyed queries, uses only the
server-bound tenant/silo/project scope, and returns distinct ranked documents
per query. Its score and percentile are ranking evidence rather than calibrated
confidence; `unobserved` is not proof of absence. Models use the separate
`rag_search` tool to retrieve answer passages. The staged template planner and
Phase 2 workers never receive `rag_documents`. When an Ask requests an output
file, a final format-specific instruction requires the coordinator to author
the exact Markdown, JSON, CSV, or text artifact with `write_file` or a published
`cache_file`; the normal answer is not wrapped into the file. DOCX output first
considers assigned Template Groups and falls back to a structured blank Word
document when none is suitable. Ask and Extraction also receive
the automatic run-scoped `sequential_plan`, `cache_file`, and `model_status`
tools whenever model tools are enabled. The first keeps concise operational
state; the second lets a model incrementally edit multiple temporary outputs
and publish one completed non-DOCX body without emitting it again; the third
publishes user-visible milestones using server-owned Ask, Extraction, and Task
item scope. The cache description directs models to
start the cache before drafting outputs expected to exceed 16,000 characters or
roughly 25 records. Extraction can automatically publish a large direct body
through the same cache as a logged fallback; a requested Ask file instead sends
direct answer text back to the coordinator and requires an explicit file-tool
completion. Named caches can also serve as
owner-labelled task slots with optimistic revision checks and a sealed `ready`
handoff, so independent slots can be assembled concurrently without silent
same-slot overwrites. Requested output formats are validated before a cache
publish completes. Both workspaces are cleared when the run ends. OpenAI OAuth,
capable Ollama models, and capable Modular, Together AI, and OpenRouter routes
receive retrieval and workspace tools through native function calling; safe
same-turn reads/searches run concurrently, state changes remain ordered, and a
route that rejects native tools falls back to the JSON tool-message loop.
Structured JSON containing a top-level `tasks` array is normalized
before storage: model-owned `entityFingerprint` values are replaced with a
versioned server fingerprint based on stable silo, source-document, scope, and
evidence-statement identity rather than the model's title or formatting.
Railway binds the selected
silo and optional project before calling the model; model-visible tool
arguments never contain a silo ID. Complete Markdown retrieval requires a
document ID found through scoped search/listing and is returned in exact ranges
with `nextOffset` until `complete` is true. The loop limit is configured
separately for Ask and Extraction from 1-250, with a default of 120. Every provider
call also receives current UTC plus the task's configured reference location
and IANA time zone.

Ask and Extraction also have independent **Max RAG searches per request**
settings from 0-100, defaulting to 24. The model sees the request first and
chooses whether retrieval is necessary. The RAG ceiling is separate from the
overall tool limit so document editing can continue after retrieval stops.

## Extraction Workflow

Endpoint:

```text
POST /api/v1/silos/{siloId}/extractions
```

Extraction body example:

```json
{
  "request": "Extract every project name, location, estimated cost, and timeline. Return unknown for absent values and include source references.",
  "documentId": "document-uuid",
  "outputFormat": "json",
  "webhookUrl": "https://your-bubble-webhook-url",
  "webhookSecret": "shared-secret",
  "outputFile": {
    "enabled": true,
    "format": "json",
    "fileName": "project-extraction.json"
  }
}
```

The optional webhook receives every `model.status.updated` callback with the
original Extraction request and structured `modelStatus`. Extraction create,
list, and status responses include `webhookConfigured`, `webhookSigned`, and
the latest `progress` value without exposing the URL or secret.

This standalone endpoint executes synchronously. A successful HTTP `200`
response already contains `extractionRun`, `extractionResult`, `generatedFile`,
model timing/tool metadata, a preview, and `queued: false`. Store the returned
extraction and generated-file IDs. Bubble can reopen the persisted records
later with:

```text
GET /api/v1/extractions/{extractionId}
```

The extraction response can include:

- Extraction run status.
- Result JSON.
- Result Markdown.
- Result CSV.
- Missing fields.
- Source references.
- Generated files.

## Download Workflow

Bubble should support downloads from three categories.

Original uploaded source:

```text
GET /api/v1/documents/{documentId}/download
```

Generated Markdown/text version of an ingested document:

```text
GET /api/v1/documents/{documentId}/text
```

Generated files from Ask/Extraction/Vision/PDF assembly:

```text
GET /api/v1/generated-files/{fileId}/download
```

For browser-facing downloads, Bubble should request a short-lived signed URL instead of exposing the protected byte endpoint:

```text
POST /api/v1/documents/{documentId}/download-ticket
POST /api/v1/documents/{documentId}/markdown-download-ticket
POST /api/v1/generated-files/{fileId}/download-ticket
```

Send `{"expiresIn":120}`. The allowed range is 60 through 300 seconds. Open the returned `download.url` immediately and do not store it as a durable Bubble record.

Generated files can be listed by silo:

```text
GET /api/v1/silos/{siloId}/generated-files?page=1&pageSize=20
```

Bubble should preserve returned file metadata:

- `id`
- `file_name`
- `output_format`
- `mime_type`
- `byte_size`
- `task_key`
- `document_id`
- `question_log_id`
- `extraction_run_id`
- `created_at`
- `downloadUrl`
- `downloadTicketUrl`

## Cleanup And Recovery

Current API support:

- Cancel a stuck document job: `POST /api/v1/documents/{documentId}/cancel`
- Reprocess a document: `POST /api/v1/documents/{documentId}/reprocess`
- Retry embeddings only: `POST /api/v1/documents/{documentId}/embed`
- Delete a document: `DELETE /api/v1/documents/{documentId}`
- Delete a generated file: `DELETE /api/v1/generated-files/{fileId}`

Embedding-only retry is important for large documents. If PDF-to-Markdown and chunking succeeded but embeddings timed out, Bubble can call the embed endpoint and the worker will skip embeddings already stored for matching chunks.

## Pagination

List endpoints use:

```text
page
pageSize
```

Maximum `pageSize` is `100`.

Bubble should implement pagination for:

- Silo list.
- Document list.
- Document chunks.
- Extraction runs.
- Generated files.

## Standard Error Shape

All JSON API errors follow this shape:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Request body did not match the API contract.",
    "details": {}
  },
  "requestId": "request-uuid"
}
```

Bubble should display `error.message` to admins and preserve `requestId` in diagnostic logs.

Common error handling:

- `401`: API key missing or invalid.
- `403`: API key lacks the required scope.
- `409`: Idempotency key conflict or replay of a deleted resource.
- `422`: Request fields are invalid.
- `500`: Railway/Supabase/storage/model failure.

## API Usage Logs

Every authenticated public API request writes an `api_usage_logs` row. These logs include:

- API key ID.
- Request ID.
- Method.
- Path.
- Required scope.
- Status code.
- Latency.
- Error code.
- Query metadata.
- Whether an idempotency key was present.

Bubble and the Railway API test interface can retrieve redacted logs with:

```text
GET /api/v1/usage-logs?scope=current&page=1&pageSize=60
```

The route requires `api-usage:read`. It supports status, method, error code, path, request ID, and date filters. `scope=current` limits results to the calling key; `scope=tenant` includes all keys in the tenant.

## Current Limitations

1. API keys are scoped by capability, not by individual silo.
2. Each Bubble application must configure and initialize its own private API Connector/plugin calls and environment-specific Railway key.
3. Standalone Extraction is a potentially long synchronous call. Saved Task runs are the durable queued option for multi-step or background extraction workflows.
4. Vector/hybrid search depends on existing `document_embeddings` rows for the active embedding version. If embeddings are incomplete, RAG search can fall back to keyword behavior and report embedding availability in usage metadata.
5. Webhooks are available for ingestion/reprocess, Ask model-status,
   standalone Extraction model-status, and Task lifecycle/model-status events,
   but Bubble webhook receiver/HMAC verification has not yet been implemented.
6. Provider/model/admin configuration should remain in Railway admin, not Bubble, unless a later Bubble admin interface is intentionally added.

## Bubble Implementation Phases

### Phase 1: API Connector Smoke Test

Configure:

- `GET /health`
- `GET /me`
- `GET /silos`

Goal: prove Bubble can authenticate and read from Railway.

### Phase 2: Silo And Document Upload

Configure:

- `POST /silos`
- `POST /silos/{siloId}/documents`
- `GET /documents/{documentId}/status`

Goal: create a silo, upload a file, and poll ingestion until ready.

### Phase 3: Browse And Download

Configure:

- `GET /silos/{siloId}/documents`
- `GET /documents/{documentId}`
- `GET /documents/{documentId}/chunks`
- `GET /documents/{documentId}/download`
- `GET /documents/{documentId}/text`
- `POST /documents/{documentId}/download-ticket`
- `POST /documents/{documentId}/markdown-download-ticket`

Goal: inspect uploaded documents, chunks, original files, and generated Markdown.

### Phase 4: RAG Search And Ask

Configure:

- `POST /silos/{siloId}/rag-search`
- `POST /silos/{siloId}/ask`

Goal: search indexed content and ask grounded questions.

### Phase 5: Extraction And Generated Files

Configure:

- `POST /silos/{siloId}/extractions`
- `GET /extractions/{extractionId}`
- `GET /silos/{siloId}/generated-files`
- `GET /generated-files/{fileId}/json`
- `GET /generated-files/{fileId}/download`
- `POST /generated-files/{fileId}/download-ticket`

Goal: execute extraction workflows and retrieve generated JSON/CSV/Markdown outputs.

### Phase 6: Admin Recovery Tools

Configure:

- `POST /documents/{documentId}/cancel`
- `POST /task-runs/{runId}/cancel`
- `POST /documents/{documentId}/reprocess`
- `POST /documents/{documentId}/embed`
- `DELETE /documents/{documentId}`
- `DELETE /generated-files/{fileId}`

Goal: allow Bubble-side recovery and cleanup for long-running or failed jobs.

## Minimum Bubble Data Types

Bubble should store or mirror at least:

- Silo: `id`, `name`, `description`, `created_at`.
- Document: `id`, `silo_id`, `file_name`, `status`, `page_count`, `mime_type`, `last_error`, `created_at`, `updated_at`.
- Processing job: `id`, `document_id`, `status`, `stage`, `progress`, `started_at`, `finished_at`.
- RAG source: `sourceDocument.id`, `sourceDocument.name`, `chunkId`, `pageNumber`, `snippet`, `score`.
- Ask result: `question`, `answer`, `confidence`, `questionLog.id`, `sources`, `generatedFile.id`.
- Extraction run: `id`, `silo_id`, `document_id`, `status`, `result`, `generatedFiles`.
- Generated file: `id`, `silo_id`, `document_id`, `task_key`, `file_name`, `output_format`, `downloadUrl`, `created_at`.
- API diagnostics: `requestId`, `error.code`, `error.message`.

## Implementation Readiness

The Railway API already exposes the core functionality needed for Bubble to reach parity with the API test website:

- Silo management.
- File ingestion.
- Status polling.
- Document browsing.
- Original and Markdown downloads.
- RAG search.
- Ask.
- Synchronous Extraction execution with persisted run/result access.
- Generated-file browsing and downloading.
- Job cancellation/reprocess/embed recovery.
- API usage logging.
- API-key-scoped usage-log retrieval.
- Short-lived download tickets.
- Canonical multipart retry hashing.

The next step is Bubble API Connector configuration, starting with health/auth/silo listing before moving to multipart upload and long-running job polling.
