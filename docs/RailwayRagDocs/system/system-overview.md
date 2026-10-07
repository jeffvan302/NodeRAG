# RAG Railway System Overview

Last reviewed: 2026-08-15.

## Purpose

RAG Railway is a multi-client document ingestion, retrieval, Ask, Extraction,
and generated-file platform. Railway hosts the application and processing
services. Supabase owns data-plane state, private objects, vector data, job
queues, runs, and audit logs. A private Railway settings service owns encrypted
configuration, credentials, API keys, and login records. Ollama Cloud or OpenAI performs configured model work; a dedicated
Railway Ollama service performs local embeddings.

## Service Boundaries

| Component            | Responsibility                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Railway `web`        | Admin dashboard, API test portal, protected admin routes, and public `/api/v1` REST handlers.                                 |
| Railway `worker`     | Long-running queue poller for ingestion and reprocessing, canonical Markdown assembly, chunking, and document embeddings.     |
| Railway `embeddings` | Private local-Ollama `/embed` service for query and document vectors; serverless sleep after idle time.                       |
| Railway `settings`   | Private serverless AES-256-GCM SQLite vault; web wakes it and holds a one-minute activity lease before ten-minute idle sleep. |
| Supabase Postgres    | Silos, projects, documents, chunks, embeddings, jobs, runs, generated-file metadata, audit/usage logs, and lease projections. |
| Supabase Storage     | Private originals, canonical Markdown, page renders, extracted assets, generated files, and parser diagnostics.               |
| Supabase Vault       | Legacy import source only. New and active runtime secrets are stored in Railway `settings`.                                   |
| Ollama Cloud/OpenAI  | Vision, Ask, Extraction, and optional PDF page-group or PDF assembly model execution.                                         |
| Bubble/client apps   | Authenticate with a Railway-issued bearer API key and use only `/api/v1` operations.                                          |

## Data Hierarchy

1. A tenant owns API keys, users, silos, tasks, and usage records.
2. A silo is the primary knowledge boundary and contains documents and
   generated files.
3. A project is a reusable subset of documents in one silo. Project
   membership references existing documents; it never duplicates ingestion.
4. A document is ingested once into its silo and can belong to zero or more
   projects.
5. A Task definition contains ordered Extraction steps and is not tied to a
   silo. A Task run selects one silo and an optional project.
6. A Task step either produces its configured JSON, CSV, Markdown, or DOCX file
   in the selected silo, or runs with file output disabled to build reusable
   Task Dataset state for later steps and future runs. Both modes are counted
   in run completion. Re-running the same enabled output name replaces the
   prior file.

Deleting a project removes only its membership rows. Deleting a document
removes the document and its dependent processing/storage data. Admin-only
silo deletion removes the silo and all attached data after producing and
validating a deletion manifest.

Clearing an Ask, Extraction, Task, or chat queue also removes the conversation
data behind those runs. Deleting a run cascades into `conversation_runs`, and a
conversation whose last run is gone deletes itself along with its messages,
compression state, snapshots, and artifact memory. Conversations that never
received a run row are swept by `purge_orphaned_conversations`. Generated files
and usage logs are deliberately retained: they outlive the run that produced
them.

## Ingestion Flow

1. The web/API service validates authentication, silo/project scope, file
   type, upload size, and idempotency.
2. The original source is stored privately and a `processing_jobs` row is
   queued.
3. The long-running worker claims the job and maintains status, stage,
   heartbeat, progress, elapsed time, and errors.
4. PDF, DOCX, and Excel sources are converted into one canonical Markdown
   document. Markdown, text, and CSV already enter this canonical path.
5. PDF text, page renders, embedded images, charts, maps, and layout anomalies
   are processed according to the selected PDF parsing strategy and vision
   configuration. Full-page vision replaces noisy native OCR for that page.
6. The canonical Markdown is chunked using the configured token target,
   overlap, and source-character offsets.
7. The embedding worker creates vectors for each chunk with the selected
   embedding model. The document becomes `ready` only after persistence and
   embedding work completes.
8. Reprocessing may reuse saved vision Markdown or refresh the complete
   conversion before re-chunking and re-embedding.

## Retrieval And Context

RAG search supports keyword, vector, and hybrid modes and defaults to vector
when no mode is supplied. Results are ordered by score and may include
configurable neighboring context. Chunk records retain canonical Markdown
source offsets, allowing the service to reconstruct previous/current/next
context without repeating overlap text.

Every retrieval is bound to the selected silo before the model sees results.
When `projectId` is supplied, only documents associated with that project are
eligible. The model does not choose or provide silo/project IDs.

The model tool set can include:

- `rag_search` for focused keyword, vector, or hybrid retrieval.
- `rag_documents` for read-only, distinct-document discovery across 1-12
  queries before retrieving answer passages with `rag_search`.
- `list_files` for files visible in the active silo/project scope.
- `get_document_markdown` for exact ranges from a complete canonical source.
- `get_document_image` and `render_pdf_page` for visual source inspection.
- `write_file` for stable generated files in the already-bound silo.
- `sequential_plan` for a private, concise task checklist and working decisions without recording chain-of-thought.
- `cache_file` for multiple temporary, incrementally edited output files; each file can act as an owner-labelled task slot with revision-checked writes and a sealed `ready` handoff. Independent slots support parallel read/write work without allowing stale same-slot updates to overwrite newer revisions. Publishing a completed cache supplies the final non-DOCX result without repeating its body and validates the requested output format before ending the model loop. Large structured outputs are directed to start with a small skeleton and grow through bounded text sections or JSON record batches before publication. Large direct results are automatically cache-published as a provider-neutral fallback and identified in run usage. Native cache publication records the completing model call, usage, and elapsed model time just like direct output.
- `task_dataset` for staged create, inventory, leased source processing,
  idempotent structured writes, receipt/source completion, and current-run
  record reuse when—and only when—the server supplies a verified saved-Task
  dataset context. Phase 3 provides this tool/runtime substrate; Phase 4 will
  bind it automatically to saved Task execution and dataset-aware RAG.

## Ask And Extraction

Ask and Extraction use the same bounded agent-loop foundation with separate
task configurations. Each may select its provider/model, instructions,
reasoning effort, RAG mode, Top K, enabled tools, context limits, maximum tool
requests (`1-250`, default `120`), and an independent maximum for built-in RAG
searches (`0-100`, default `24`).

OpenAI OAuth, capable Ollama models, and capable Modular, Together AI, and
OpenRouter routes use native retrieval/workspace function calls. Independent
same-turn reads and searches run concurrently. Cache mutations remain ordered,
and revision checks reject stale writes. A provider that rejects only parallel
tool calls is retried with ordinary native calls; a model that rejects native
tools falls back to the JSON tool-message protocol.

The request reaches the model before retrieval. The model decides whether it
has enough information, may use `rag_documents` to identify likely source
documents, and may issue focused `rag_search` calls when answer passages are
missing. `rag_documents` is available only to Ask and general Extraction—not to
the staged template Phase 1 planner or Phase 2 workers. It accepts exactly one
query or 1-12 string/keyed queries, rejects model-supplied scope identifiers,
and returns distinct documents per query with rank, score, percentile,
observation state, and bounded anchors. Score is ranking evidence rather than
confidence, and `unobserved` is not verified absence. There is no
keyword-driven minimum-search questionnaire.

Ask streaming uses durable run and event records. NDJSON clients can observe
reasoning summaries, model output, tool starts/completions, research-coverage
redirects, and the final answer. A disconnected client can retrieve the run
and event history later with its run ID or list prior runs by silo/project.
JSON outputs containing a top-level `tasks` array receive versioned,
server-generated `entityFingerprint` values from stable source/evidence identity
before the answer and generated file are stored.

Extraction returns or writes type-aware output. JSON is validated as JSON;
CSV and Markdown receive format-specific instructions and repair handling.
Saved Tasks execute their Extraction steps sequentially and record status,
timing, source count, generated-file ID, and errors per step.

## Reference Libraries

A library holds documents that belong to no silo. Each library project becomes
one named RAG tool that a granted silo can enable on Ask and Extraction.

Library documents are ordinary rows in `documents` with a null `silo_id`, so
they reuse the whole ingestion pipeline while remaining invisible to every
silo-scoped query: those filter on a concrete silo and `NULL` matches nothing.
Library retrieval is a separate path keyed on library project membership. The
retrieval entry point rejects a call with no silo, library, or document, so an
unscoped search fails rather than returning both kinds.

A tool is offered to a run only when the project is enabled, the silo has been
granted access, a binding exists for the task, and at least one document is
ready. Otherwise it is absent from the run entirely rather than present and
empty, because an empty result reads to the model as an absence of evidence.

Each binding carries its own poll limit, separate from the shared
`maxToolRequests` budget that library calls still consume. Library searches
count toward broad-question coverage.

See [reference libraries](../library/README.md) for the operator guide.

## Context Window Management

Ask and Extraction can opt into hierarchical structured compression. It is off
by default at both the tenant config and the per-task toggle, so a task that has
not opted in behaves exactly as before.

Each run creates a conversation that owns one context window. Messages are
persisted as the agent loop produces them, and compression is re-evaluated at
every tool-call boundary rather than only between prompts, because an agent loop
can run many tool calls inside a single turn.

Compression triggers when live tokens reach the configured percentage of the
model's context window, or after a configured number of prompts. The window is
resolved from a researched entry, then a measured Ollama profile, then a
baseline table of known model families; when none of those apply, only the
frequency trigger can fire and the run emits `context.window.unknown`.

- Layer 1 pins user-authored turns verbatim. Deterministic, no model call.
- Layer 2 maintains a narrative summary.
- Layer 3 maintains a structured JSON state object.
- Layer 4 keeps the most recent turns verbatim.
- Layer 0 artifact memory is stored but not executed yet.

Layers 2 and 3 can run concurrently. When either uses Ollama and the access
point pool cannot supply a slot for each layer beside the agent's own call, they
fall back to sequential execution rather than waiting for a lease and failing.
A layer that errors keeps its previous value, and the error is recorded on the
compression snapshot instead of failing the run.

## Security And Audit

- Admin browser access uses server-side sessions and bootstrap-token recovery.
- API users can be promoted to delegated administrators from **API Usernames**.
  Their signed session retains the API-user identity for auditing while granting
  the Admin Dashboard and protected admin functionality. The primary
  `admin_users` account is never listed in API-user management, and logged-in
  API-user accounts cannot open the original-admin setup/recovery surface.
  Promotion or removal takes effect when that API user signs in again.
- External clients use backend-generated `brk_` API keys with explicit scopes.
- State-changing REST calls require idempotency keys where documented.
- Provider credentials are never returned to the browser and are stored in the
  encrypted local settings vault.
- Storage buckets are private; API downloads use authenticated responses or
  short-lived signed tickets.
- API usage logs record request IDs, method/path, redacted request and response
  metadata, status, latency, key identity, and errors.
- Model/run logs retain enough input, output, tool, progress, and failure data
  for diagnosis without exposing provider secrets.

## Operational Reading

- [Deployment notes](../deployment.md)
- [Database construction](../database/database-construction.md)
- [Railway, Supabase, and provider setup](../setup/railway-supabase-model-provider-setup.md)
- [Public REST API](../api/rest-api-command-reference.md)
