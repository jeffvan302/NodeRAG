# Library RAG Tools

Status: implemented except the public `/api/v1` surface and its scopes.
Last reviewed: 2026-08-03.

Built: schema and `resolve_library_tools`, library retrieval with the
unscoped-search guard, the library predicate on `match_document_embeddings`,
dynamic tool names in both agent loops with per-tool poll limits, admin routes
under `/api/libraries`, library document upload and ingestion with status and
re-run controls, and the Libraries tab at `/library` covering libraries, tools,
documents, silo access, and Ask/Extraction bindings.

The operator guide is [reference libraries](../library/README.md). This
document remains the design record and rationale.

Portable export/import of library definitions, original files, and canonical
Markdown is planned separately in
[Portable Library Export And Import](library-portability.md). That package does
not carry chunks, embeddings, silo access grants, or Ask/Extraction bindings.

Outstanding: the `/api/v1/libraries/...` routes, the `libraries:read`,
`libraries:write`, and `libraries:grant` scopes, and the fix to the
implicit-all scope expansion described below.

## Purpose

A library is a shared reference collection that any silo can be granted access
to, exposed to Ask and Extraction as a named RAG tool with its own description.

The motivating case: a set of building regulations should be searchable from
several silos without copying the documents into each one, and without any silo
being able to read another silo's material.

## Why Not Cross-Silo Search

The obvious implementation is to let a silo's RAG tool point at another silo's
project. That was rejected. The system's central invariant is that every
retrieval is bound to the selected silo before the model sees results, and that
the model never supplies silo IDs. A cross-silo tool is a hole in that rule,
and holes are hard to audit: the public API is scoped as
`/api/v1/silos/{siloId}/...`, so a Bubble key holding access to one silo would
gain read access to another through a configuration object rather than through
its scopes.

A library is a second scope rather than an exception to the first. Silo
retrieval matches `silo_id = X`. Library retrieval matches membership of an
enabled library project. Neither query can return the other's rows.

## Documents Are Shared, Ownership Is Not

Library documents live in the existing `documents` table with `silo_id = null`.

Twelve tables reference `documents(id)`. Giving libraries their own document
table would mean duplicating at least six of them - files, pages, assets,
chunks, embeddings, processing jobs - plus a parallel worker path, a parallel
vector search function, and parallel storage handling. Every future improvement
to PDF parsing, vision analysis, DOCX conversion, or chunking would then have to
be made twice.

Isolation does not require that duplication. `silo_id IS NULL` cannot match any
silo-scoped query, because `NULL` never equals anything. Every existing
retrieval path filters on a concrete silo, so a library document is invisible to
all of them without changing a line of that code.

### Required Guard

Because both kinds of document share `document_chunks`, a query that forgets its
scope filter would mix them. The RAG entry point must therefore reject a call
that supplies neither a silo ID nor a library project ID, so an unscoped search
fails loudly instead of returning too much. This guard is the trade for not
duplicating the pipeline and is not optional.

## Schema

```text
libraries
  id, tenant_id, name, slug, description, created_at, updated_at
  unique (tenant_id, slug)

library_projects                     -- one row becomes one RAG tool
  id, tenant_id, library_id
  tool_name        -- model-facing identifier, snake_case
  display_name
  description      -- long text; this is the tool selection mechanism
  enabled
  created_at, updated_at
  unique (tenant_id, tool_name)

library_project_documents            -- many-to-many
  library_project_id, document_id, added_at
  primary key (library_project_id, document_id)

library_project_access               -- which silos may use this library project
  library_project_id, silo_id, created_at
  primary key (library_project_id, silo_id)

library_tool_bindings                -- per project + task enablement
  id, tenant_id, project_id, task_key, library_project_id
  max_polls        -- separate from the shared tool budget, see below
  unique (project_id, task_key, library_project_id)
```

`library_project_access` exists because a silo may represent a topic inside one
customer or a whole separate customer, and the code cannot tell which. Granting
access explicitly is safe under both readings. A library project with no access
rows is visible to nobody.

Access and binding rows are managed either from the admin dashboard or through
an API key holding the `libraries:grant` scope described below.

Enablement cannot live in `model_task_configs.metadata`: that table is unique on
`(tenant_id, scope_key, task_key)`, so there is exactly one Ask configuration
per tenant and per-silo choices would collide. `library_tool_bindings` is keyed
on the project instead.

### Ask And Extraction Without A Project

Ask and Extraction can run with a silo and no project. Bindings are keyed on
project, so those calls would otherwise receive no library tools at all.

Resolution order: use the project's bindings when a project is selected and has
any; otherwise fall back to bindings recorded against the silo. Store silo-level
bindings in the same table with a null `project_id` and a `silo_id` column, so
one lookup covers both.

## Dynamic Tool Names

Tool names are currently a closed set in three places. All three must become
dynamic, and the first is the one that will waste an afternoon if missed.

1. `isExtractionToolName()` in `extraction-output.ts` hardcodes the six names.
   When a name is not recognised, `findExtractionToolCall` returns `null`, and
   the agent loop treats that as _the model produced its final answer_. A call
   to an unknown library tool is therefore silently swallowed and its JSON
   becomes the answer text. It must accept the resolved library tool names for
   the current run.
2. `ModelToolNameSchema` in `rag-core` is a `z.enum` validating `allowed_tools`.
   Library tools are not stored in `allowed_tools`, so this stays as is, but the
   loop's `input.allowedTools.includes(toolCall.tool)` check must consult the
   resolved library tool list as well.
3. `executeTextModelTool` dispatches on `toolCall.tool === "rag_search"` and
   similar. It needs a branch that resolves an unrecognised name against the
   run's library tools and calls the library search path.

### Name Rules

- snake_case, matching `^[a-z][a-z0-9_]{2,48}$`, because the model emits it as
  `{"tool":"name"}`.
- Unique per tenant.
- Rejected if it collides with a built-in: `rag_search`, `rag_documents`,
  `list_files`,
  `write_file`, `get_document_markdown`, `render_pdf_page`,
  `get_document_image`, `sequential_plan`, `cache_file`, or a DOCX workspace
  tool.

### Tool Context

Built-in tools describe themselves through `MODEL_TOOL_CONTEXT_BY_NAME`, which
`buildModelToolContext` assembles into the instructions. Library tools append a
generated block per enabled tool: the tool name, the administrator's
description, and the shared usage note explaining that the tool searches a fixed
reference collection and takes the same arguments as `rag_search`.

The description is not documentation. It is the only signal the model uses to
choose between two libraries, so it is required, with a sensible minimum length.

## Retrieval

`searchSiloRag` takes a single `siloId`. Library search needs a sibling that
filters by `library_project_documents` membership and `silo_id IS NULL` rather
than by silo, reusing `retrieveRankedRagChunks` for ranking, neighbour context,
and scoring.

Embedding compatibility is already guaranteed: `rag_ingestion_settings` is
unique per tenant, so every silo and every library share one embedding provider,
model, and dimension count. **This is now an invariant.** Making embedding
settings per-silo would silently break every library tool by comparing vectors
from different models, producing bad results rather than errors.

## Poll Limits

Three separate concepts, easy to confuse:

| Setting           | Meaning                                    | Default         |
| ----------------- | ------------------------------------------ | --------------- |
| `maxToolRequests` | Ceiling on all tool calls in one run       | 64, range 1-250 |
| `maxRagSearches`  | Ceiling on built-in `rag_search` calls     | 8, range 0-100  |
| `max_polls` (new) | Ceiling on calls to one library group tool | per binding     |

A library poll consumes the shared `maxToolRequests` budget, because it is a
real model round trip. Without that, five enabled libraries could add
twenty-five extra calls to a run.

Library searches use their per-binding poll limit and the shared tool budget.
Only the built-in `rag_search` tool consumes `maxRagSearches`; the runtime no
longer requires a minimum number of searches based on broad-question wording.

## Deletion And Degradation

Libraries are not reachable from `prepare_silo_deletion` and must not be:
deleting a silo must never delete shared reference material.

The rule for a missing library, as specified: **omit it from the tool list**.
Tool resolution happens per run, so a library project that has been deleted,
disabled, stripped of access, or emptied of documents simply does not appear in
the resolved tool set, and its description is not added to the instructions. The
model is never told about a tool it cannot call.

- Deleting a **library project** cascades its documents, access, and binding
  rows. Runs stop offering the tool.
- Deleting a **library** cascades its projects.
- Deleting a **document** removes its membership rows. A library project with no
  remaining documents resolves to no tool rather than to a tool that returns
  nothing, because an empty result reads to the model as "the sources say
  nothing," which is worse than the tool being absent.
- Deleting a **silo** removes its access and binding rows only.
- The admin UI must show when a binding refers to something no longer available,
  rather than leaving a checkbox that silently does nothing.

## Admin Dashboard

A new top-level section beside API Users, API Test, Browse Content, and
Configuration, at `/library`, reachable from a topbar tab.

- Libraries list, create, rename, describe.
- Library projects within a library: tool name, display name, long description,
  enabled toggle.
- Document management: upload into a library project, list, remove, reprocess,
  and view ingestion status, reusing the existing upload and job-status
  components.
- Access: which silos may use each library project.
- A read-only view of which silo projects have bound each tool, so the effect of
  deleting a library project is visible before doing it.

## Public API

Implementation status: complete as of 2026-08-04. The routes and scope model
below are live, including API-user Libraries navigation and explicit
`libraries:grant` assignment.

Library management belongs in `/api/v1` so an authenticated client can maintain
its own reference collections.

```text
GET    /api/v1/libraries
POST   /api/v1/libraries
GET    /api/v1/libraries/{libraryId}
PATCH  /api/v1/libraries/{libraryId}
DELETE /api/v1/libraries/{libraryId}

GET    /api/v1/libraries/{libraryId}/projects
POST   /api/v1/libraries/{libraryId}/projects
PATCH  /api/v1/libraries/{libraryId}/projects/{projectId}
DELETE /api/v1/libraries/{libraryId}/projects/{projectId}

GET    /api/v1/libraries/{libraryId}/projects/{projectId}/documents
POST   /api/v1/libraries/{libraryId}/projects/{projectId}/documents
DELETE /api/v1/libraries/{libraryId}/projects/{projectId}/documents/{documentId}

POST   /api/v1/libraries/{libraryId}/projects/{projectId}/search
```

```text
GET    /api/v1/libraries/{libraryId}/projects/{projectId}/access
PUT    /api/v1/libraries/{libraryId}/projects/{projectId}/access
DELETE /api/v1/libraries/{libraryId}/projects/{projectId}/access/{siloId}

GET    /api/v1/silos/{siloId}/library-tools
PUT    /api/v1/silos/{siloId}/library-tools
GET    /api/v1/silos/{siloId}/projects/{projectId}/library-tools
PUT    /api/v1/silos/{siloId}/projects/{projectId}/library-tools
```

Three new scopes, added to `API_KEY_SCOPES`:

| Scope             | Permits                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `libraries:read`  | List libraries, projects, documents, and search a granted library.   |
| `libraries:write` | Create and edit libraries and projects, add and remove documents.    |
| `libraries:grant` | Grant a library project to a silo, and bind tools to Ask/Extraction. |

`libraries:grant` is separated deliberately. It is the only scope that widens
what a silo can read: a key holding it can attach any library to any silo and
enable it on that silo's Ask. `libraries:write` lets a client curate its own
reference material without being able to change who sees it, which is the
common case and should be the common grant.

The blast radius stays inside the tenant, because keys and libraries are both
tenant-scoped and no route accepts a tenant ID from the caller.

### Existing Keys And The Implicit-All Default

`normalizeApiKeyScopes` expands an empty or absent scope list to _every_ scope
in `API_KEY_SCOPES`. Two consequences matter here.

Adding these scopes does not retroactively grant them. Key creation persists
`normalizeApiKeyScopes(parsed.scopes)`, so a key created without an explicit
list already has the then-current names stored literally. It will not pick up a
name added later.

But the same function runs on read, so any row whose stored list is empty, null,
or contains only names that no longer exist in the enum will expand to every
scope including `libraries:grant`. That is a pre-existing escalation path, not
one this feature introduces, and it is worth closing before adding a scope that
controls cross-silo reach. Either treat an empty stored list as no scopes, or
exclude `libraries:grant` from the implicit expansion so it is only ever held
when named explicitly.

Document ingestion, status, download, and reprocess reuse the existing
`/api/v1/documents/{documentId}/...` routes, since library documents are
ordinary rows in `documents`. Those handlers currently resolve scope through the
owning silo and need a branch for `silo_id IS NULL` that authorises through
library membership instead.

`POST .../documents` mirrors the silo upload contract: multipart upload,
idempotency key, size and MIME validation, then a queued `processing_jobs` row.
The worker needs no change, because it already guards every silo-scoped write
behind `if (documentContext.silo_id)`.

Granting access and binding tools are available to API clients through
`libraries:grant` rather than being restricted to the admin dashboard. The
dashboard offers the same operations; neither is privileged over the other.

Every grant and binding change is written to the API usage log with the library
project, the target silo or project, and the acting key, because these are the
operations that change what a silo can read.

## Build Order

1. Schema, `rag-core` types, and the unscoped-search guard.
2. Library CRUD, admin section, ingestion into a library project.
3. Library retrieval path and the three dynamic tool-name sites.
4. Binding UI on the Ask and Extraction tasks, with poll limits.
5. Public API routes and the three scopes, plus the fix to the implicit-all
   scope expansion, which lands before `libraries:grant` is introduced.
6. Deletion, degradation, and the admin warnings for stale bindings.

Steps 1 to 3 produce a working internal library. Step 4 makes it selectable.
Nothing before step 4 changes the behaviour of an existing run.

## Open Questions

- Does a silo separate topics inside one customer, or separate customers? This
  decides whether `library_project_access` should default to every silo or to
  none. Until it is answered, the default is none.
- Should a library document be downloadable through the public API by any key
  holding `libraries:read`, or only by keys that also hold access to a silo the
  library is granted to?
- Should the implicit-all-scopes expansion be removed outright, or only made to
  exclude `libraries:grant`? Removing it is the safer fix but would change the
  behaviour of any key currently relying on it.
- Should library ingestion count against the same usage and quota records as
  silo ingestion, given the documents are shared rather than owned by one silo?
