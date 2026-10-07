# Reference Libraries

Last reviewed: 2026-08-04.

A library is a collection of documents that belongs to no silo. Each library
project inside it becomes one named RAG tool that a granted silo can enable on
its Ask and Extraction calls.

The motivating case: one set of building regulations searchable from several
silos, without copying the documents into each one and without any silo gaining
the ability to read another silo's material.

Everything described here is managed on the **Libraries** tab at `/library`.
Administrators always have access. An API username sees the same tab when its
associated API key includes `libraries:read`; edit and silo-connection controls
follow `libraries:write` and `libraries:grant` respectively.

## How Isolation Works

Silo retrieval matches `silo_id = <the selected silo>`. Library documents are
stored with a **null silo**, and `NULL` never equals anything, so a library
document cannot be returned by any silo-scoped query. Library retrieval is a
separate path that matches membership of a library project.

Two positive filters that cannot overlap. A library is a second scope rather
than a hole in the first one.

Because both kinds of document share `document_chunks`, the retrieval entry
point rejects a call that supplies neither a silo, a library project, nor a
document. An unscoped search fails loudly instead of returning everything.

## The Objects

| Object          | Purpose                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Library         | A container. Its name and description are for humans organising the material.                   |
| Library project | Becomes one RAG tool. Carries the tool name, display name, and the description the model reads. |
| Document        | An ordinary row in `documents` with a null silo. May belong to several library projects.        |
| Access grant    | Which silos may use a library project. No grants means nobody.                                  |
| Binding         | Enables a tool on one silo's Ask or Extraction, with its own poll limit.                        |

### Tool Names

The tool name is what the model emits as `{"tool":"building_regulations"}`, so
it must match `^[a-z][a-z0-9_]{2,48}$`, be unique across the tenant, and must
not collide with a built-in tool: `rag_search`, `rag_documents`, `list_files`,
`write_file`,
`get_document_markdown`, `render_pdf_page`, `get_document_image`,
`sequential_plan`, `cache_file`, or any DOCX workspace tool.

### The Description Is Not Documentation

The library project description is the **only** signal the model uses when
choosing between two libraries. A vague description produces silently wrong
retrieval rather than an error. It is required and must be at least 30
characters.

Write what the collection contains and when it should be searched, not what it
is called.

## Setting One Up

1. **Create a library.** Name and description. Both editable afterwards.
2. **Add a library project.** Pick the library, set the tool name, a display
   name, and the description. This is the object that becomes a tool.
3. **Upload documents.** Select the project, choose files, and press _Upload
   and ingest_. Documents run through the same pipeline silo documents use:
   canonical Markdown, chunking, embeddings.
4. **Grant silo access.** Tick the silos allowed to use the tool. A project
   with no grants is invisible to everyone.
5. **Bind it to a task.** In _Connect library tools to silo workflows_, choose
   a silo, a project (or the silo default), and Ask or Extraction, then tick
   the tools and set each one's poll limit.

## Admin Layout

The Libraries tab presents those steps as an explicit hierarchy rather than a
single combined tool list:

1. **Our libraries** lists the existing top-level containers. Select a library
   to reveal only the projects inside it.
2. **Projects in the selected library** lists that library's document groups.
   No project is selected automatically.
3. **Project documents** contains upload, ingestion status, reprocessing, and
   embedding controls for the selected project.
4. **Project tool** contains the project name, model-facing tool identifier,
   description, and enabled state.
5. **Silo access** is a separate connection step. It grants a silo permission
   to use the selected project without moving or copying any documents.
6. **Silo workflow bindings** enable granted tools for Ask or Extraction at
   the silo default or for one specific silo project.

This ordering keeps library construction independent from later silo access.
Selecting a library does not silently select one of its projects, and the silo
connection controls do not appear inside the document-management section.

## Document Status And Re-running Ingestion

Each document row shows its status, the current job stage, chunk and embedding
counts, page count, and any error. The list refreshes every five seconds while
anything is active.

| Action    | Effect                                                                  |
| --------- | ----------------------------------------------------------------------- |
| Ingest    | Runs the pipeline on a document that has not been processed.            |
| Reprocess | Runs the full pipeline again on a document that already has.            |
| Re-embed  | Recreates embeddings from existing chunks. Disabled until chunks exist. |
| Cancel    | Stops a queued or running job.                                          |
| Remove    | Takes the document out of this library project.                         |

Library documents do not appear in the silo dashboard's document list, and silo
documents cannot be added to a library project. Attempting the latter returns
`document_belongs_to_silo`, because adopting a silo document would make it
readable from every silo granted access to that library.

## When A Tool Is Offered To A Run

`resolve_library_tools` offers a tool only when **all** of these hold:

- the library project is enabled,
- the silo has been granted access,
- a binding exists for that silo and task, and
- the project holds at least one document with status `ready`.

Anything else and the tool is simply **absent** from the run. Its description is
never added to the instructions and the model is never told about a tool it
cannot call.

This is deliberate. A tool that exists but returns nothing reads to the model as
"the sources say nothing on this subject", which is worse than the tool not
being there. A deleted, disabled, un-granted, or empty library therefore
degrades to silence rather than to a wrong answer.

Project-level bindings win over the silo default when a project is selected.

## Poll Limits

Three separate limits interact, and they are easy to confuse:

| Setting             | Meaning                                  | Default         |
| ------------------- | ---------------------------------------- | --------------- |
| `maxToolRequests`   | Ceiling on **all** tool calls in one run | 64, range 1-250 |
| `maxRagSearches`    | Ceiling on `rag_search` calls in one run | 8, range 0-100  |
| Library `max_polls` | Ceiling on calls to **one** library tool | 3, range 1-20   |

A library call spends the shared `maxToolRequests` budget like any other tool.
When a library hits its own limit, the model is told so and can answer from what
it has or use another source; the run does not fail.

Library searches use their binding limit and the shared tool budget. Only the
built-in `rag_search` tool consumes `maxRagSearches`.

## Deletion

| Deleting          | Effect                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------- |
| A library project | Removes its documents' membership, access grants, and bindings. Runs stop offering the tool. |
| A library         | Cascades to its projects.                                                                    |
| A document        | Removes its membership rows. A project left with no ready documents stops being offered.     |
| A silo            | Removes that silo's access grants and bindings only. The library and its documents survive.  |

Deleting a silo can never remove shared reference material, which is the point
of keeping libraries outside the silo tree.

## Embedding Compatibility

`rag_ingestion_settings` is unique per tenant, so every silo and every library
share one embedding provider, model, and dimension count. Cross-scope search is
therefore compatible.

**This is now an invariant.** Making embedding settings per-silo would break
every library tool by comparing vectors produced by different models, and it
would produce bad results rather than errors.

## Admin API

These routes back the Libraries tab. They are admin routes, not part of the
public `/api/v1` surface.

```text
GET    /api/libraries                 list libraries and projects
POST   /api/libraries                 create a library
PUT    /api/libraries                 rename or re-describe a library
DELETE /api/libraries                 delete a library

GET    /api/libraries/projects        documents and silo access for one project
POST   /api/libraries/projects        create a library project
PUT    /api/libraries/projects        edit, set access, add or remove a document
DELETE /api/libraries/projects        delete a library project

GET    /api/libraries/documents       documents in a project with status
POST   /api/libraries/documents       upload a document (multipart)

GET    /api/libraries/bindings        bindings for a silo and optional project
PUT    /api/libraries/bindings        replace bindings for a silo, project, task
```

Library uploads use their own route rather than the silo upload route, because
that route defaults an omitted `siloId` to the POC silo. Keeping them separate
means a library upload cannot accidentally land in a silo.

## Public API And API Users

The public `/api/v1/libraries/...` routes provide library and project CRUD,
multipart or `fileUrl` ingestion, existing-library-document assignment,
project-scoped RAG search, silo access grants, and Ask/Extraction bindings.
See [the REST command reference](../api/rest-api-command-reference.md) for every
request body and endpoint.

| Scope             | Portal and REST access                                                       |
| ----------------- | ---------------------------------------------------------------------------- |
| `libraries:read`  | Show Libraries to API users; list/search libraries, projects, and documents. |
| `libraries:write` | Create/edit/delete containers, upload files, and change memberships.         |
| `libraries:grant` | Grant projects to silos and bind tools to Ask or Extraction.                 |

`libraries:grant` is not an implicit default. Existing keys retain their stored
scope list, and an administrator must explicitly add library scopes in the API
key editor. This prevents a legacy or empty scope value from gaining permission
to widen a silo's readable document set.

Library documents reached through `/api/v1/documents/{documentId}/...` are
also scope-aware. A key with ordinary `documents:read` cannot read a null-silo
library document unless it separately holds `libraries:read`.
