# Template Catalog And Template Group Tools

**Status:** Foundation implemented on 2026-08-16; model-tool resolution,
embedding execution, semantic ranking, review, and rendering remain planned.
**Purpose:** Define Templates as a first-class product area, define the
Template Group ownership and tool boundary, and define group-scoped title and
semantic search over reusable document templates.

This specification supersedes the earlier proposal to place templates inside
Libraries or to assign one template to several library template projects.
The per-template storage namespace and DOCX split contract are defined in
[Template DOCX Ingestion And Storage](template_docx_ingestion_and_storage_spec.md).

---

## 1. Decision Summary

Templates are their own subsystem.

- The application has a top-level **Templates** section at `/templates`.
- Every template belongs to exactly one **Template Group**.
- A Template Group is the model-facing tool definition.
- One Template Group contains many templates.
- A template cannot exist without a group and cannot belong to several groups.
- A template has a title and a detailed, model-facing description.
- The description is embedded and stored as vector data.
- The title and description vector are searchable only inside the selected
  Template Group.
- Template search is separate from document RAG. Templates never become
  `documents`, `document_chunks`, or `document_embeddings` rows.
- Every template has a stable private storage namespace for versioned
  configuration, source DOCX files, extracted images, manifests, structure, and
  blueprints.
- Approved template versions and blueprints continue to be the rendering
  source of truth described in the other Document Engine specifications.

The core hierarchy is:

```text
Tenant
  └── Template Group                  one dynamic model tool
        ├── Template                  one searchable catalog entry
        │     ├── Description embedding
        │     └── Template versions
        │            ├── Blueprint
        │            └── Assets
        ├── Model authoring proposals
        ├── Silo access grants
        └── Ask / Extraction bindings
```

There is deliberately no Library or Library Project in this hierarchy.

---

## 2. Why Templates Are Not Libraries

A reference library and a template catalog solve different problems.

| Concern        | Reference library                         | Template catalog                              |
| -------------- | ----------------------------------------- | --------------------------------------------- |
| Stored item    | Source document                           | Reusable output design                        |
| Retrieval unit | Document chunk                            | Template catalog entry                        |
| Vector meaning | Evidence-bearing source text              | Description of when and how to use a template |
| Tool result    | Source passages                           | Candidate templates                           |
| Final action   | Answer from evidence                      | Load a contract and render a document         |
| Ownership      | Library → library project → documents     | Template Group → templates                    |
| Membership     | A document may appear in several projects | A template belongs to exactly one group       |

Keeping the systems separate prevents several dangerous ambiguities:

- a template search result is never presented as factual evidence;
- a library RAG tool never returns a DOCX template as a source document;
- deleting a reference library cannot delete a reusable template;
- template search ranking can be tuned for selection intent instead of passage
  relevance;
- a Template Group can be enabled as a tool without also granting access to a
  body of reference material.

---

## 3. Product Objects

### 3.1 Template Group

A Template Group is both an administrative container and one dynamic model
tool.

Examples:

- `municipal_reports`
- `grant_documents`
- `board_governance_templates`
- `client_correspondence`

The group stores:

- an administrator-facing name and slug;
- a unique model-facing `tool_name`;
- a detailed `tool_description` explaining when the model should search it;
- enabled state;
- default search mode and result limit;
- access grants and task bindings.

The group description explains the collection. It does not replace the detailed
description on each template.

### 3.2 Template

A Template is the logical identity across immutable DOCX versions.

It stores:

- one required `template_group_id`;
- a concise, distinctive title;
- a stable slug within the group;
- a detailed description used for semantic selection;
- the active approved version;
- embedding lifecycle state;
- authoring and audit metadata.

The template row does not contain mutable Word bytes. Uploaded bytes remain in
`document_template_versions`.

Each template also has one active versioned Template Configuration. The upload
layer snapshots that configuration onto every template version and passes a
typed DOCX-splitting instruction envelope to the dedicated ingestion worker.

### 3.3 Template Version And Blueprint

Version and blueprint behavior remains as defined in:

- [Document Template Analyzer & Blueprint Compiler](document_template_analyzer_blueprint_spec.md)
- [Agent Document Write & DOCX Render Tool](agent_document_write_render_tool_spec.md)

Only an immutable version with an approved blueprint can be selected for
rendering. Search may optionally show draft templates to administrators, but a
model tool must return only renderable templates by default.

---

## 4. Description Contract

The description is operational metadata for a selecting model. It is not a
marketing summary and it is not the full blueprint.

Each description should explain:

1. the document's purpose;
2. the situations in which it should be used;
3. the situations in which it should not be used;
4. the intended audience;
5. the expected source information;
6. the major sections, collections, tables, and assets;
7. the output type and tone;
8. distinctive terminology a user may use when asking for it;
9. important limitations or prerequisites;
10. how it differs from nearby templates in the same group.

Recommended application validation is 200–12,000 trimmed characters. The lower
bound prevents descriptions such as "monthly report" from producing weak,
indistinguishable vectors. The upper bound prevents a blueprint or entire
source document from being copied into catalog metadata.

An authoring model may draft or improve this description, but the saved value
must be visible and editable before approval.

---

## 5. Database Structure

Names retain the `document_template_*` prefix so they cannot be confused with
Railway deployment templates or generic prompt templates.

### 5.1 Template Groups

```sql
create table document_template_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  slug text not null,
  tool_name text not null,
  tool_description text not null,
  enabled boolean not null default true,
  default_search_mode text not null default 'hybrid'
    check (default_search_mode in ('title', 'semantic', 'hybrid')),
  default_top_k integer not null default 5
    check (default_top_k between 1 and 20),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, slug),
  unique (tenant_id, tool_name)
);
```

`tool_name` follows the same model-tool identifier rules as library tools:
lowercase ASCII, digits and underscores, starts with a letter, and does not
collide with a built-in or another dynamic tool visible to the same run.

### 5.2 Templates

```sql
create table document_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_group_id uuid not null,
  title text not null,
  slug text not null,
  description text
    check (description is null or char_length(trim(description)) between 200 and 12000),
  title_normalized text generated always as
    (lower(regexp_replace(trim(title), '\s+', ' ', 'g'))) stored,
  title_search tsvector generated always as
    (to_tsvector('simple', coalesce(title, ''))) stored,
  description_sha256 text,
  description_embedding_status text not null default 'awaiting_ingestion'
    check (description_embedding_status in (
      'awaiting_ingestion', 'queued', 'processing', 'ready', 'stale', 'failed'
    )),
  enabled boolean not null default true,
  created_by text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (template_group_id, slug),
  foreign key (tenant_id, template_group_id)
    references document_template_groups(tenant_id, id) on delete restrict
);

create index document_templates_group_idx
on document_templates (tenant_id, template_group_id, enabled)
where deleted_at is null;

create index document_templates_exact_title_idx
on document_templates (tenant_id, template_group_id, title_normalized)
where deleted_at is null;

create index document_templates_title_search_idx
on document_templates using gin (title_search)
where deleted_at is null;
```

The active approved version pointer is stored after both the template and
version exist. Keeping it in a separate relation avoids a circular portable
restore dependency:

```sql
create table document_template_active_versions (
  template_id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_version_id uuid not null unique,
  activated_at timestamptz not null default now(),
  foreign key (tenant_id, template_id)
    references document_templates(tenant_id, id) on delete cascade,
  foreign key (tenant_id, template_version_id)
    references document_template_versions(tenant_id, id) on delete cascade
);
```

The upload contract intentionally has no description field. A new row begins
with `description = null` and `awaiting_ingestion`; the Template Ingestion model
derives the first detailed description from the DOCX during finalization. Only
then is the description checksum created and its embedding queued. Authorized
users may edit the generated text afterward, which queues a replacement vector.

The non-null composite foreign key enforces the two important ownership rules:
the group belongs to the same tenant and every template has exactly one group.
There is no template/group join table.

Changing `template_group_id` is an explicit audited move. It does not require a
new description vector because the description did not change, but it changes
which tool may return the template immediately.

### 5.3 Description Embeddings

Template catalog vectors use their own table. They are never mixed with RAG
chunk vectors.

```sql
create table document_template_description_embeddings (
  template_id uuid primary key
    references document_templates(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  embedding_provider text not null,
  embedding_model text not null,
  embedding_dimensions integer not null,
  source_sha256 text not null,
  embedding vector not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, template_id)
);
```

Description refresh uses a small durable queue so a metadata save does not wait
on an external model call:

```sql
create table document_template_embedding_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_id uuid not null references document_templates(id) on delete cascade,
  source_sha256 text not null,
  status processing_job_status not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  error_message text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  locked_at timestamptz,
  locked_by text
);

create unique index document_template_embedding_jobs_active_idx
on document_template_embedding_jobs (template_id)
where status in ('queued', 'running');
```

The stored provider, model, dimensions, and source hash are mandatory. Equal
dimension counts do not mean two models share a vector space. Search may compare
a query vector only with rows produced by the same configured provider/model
profile and source format version.

The canonical text embedded for v1 is:

```text
Template title: {title}

Template description:
{description}
```

The exact prefix and whitespace form part of an `embedding_source_version` in
the runtime configuration. Changing that format marks existing rows stale and
queues re-embedding.

### 5.4 Template Catalog Embedding Settings

The catalog should have one active embedding profile per tenant:

```sql
create table document_template_catalog_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  embedding_provider text not null
    check (embedding_provider in ('supabase', 'ollama', 'openai')),
  embedding_model text not null,
  embedding_dimensions integer not null,
  embedding_source_version text not null default 'template-description-v1',
  updated_at timestamptz not null default now()
);
```

This may initially copy the tenant's RAG embedding choice, but it remains a
separate configuration boundary. Changing document-ingestion embeddings should
not silently invalidate template selection, and changing template-selection
embeddings should not re-embed every source document.

### 5.5 Model Authoring Proposals

Model-assisted creation is staged rather than written directly into an approved
template:

```sql
create table document_template_authoring_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_group_id uuid not null,
  source_mode text not null check (source_mode in ('intent', 'upload')),
  request_json jsonb not null,
  proposal_json jsonb not null,
  model_provider text not null,
  model_name text not null,
  status text not null default 'draft'
    check (status in ('draft', 'accepted', 'rejected')),
  accepted_template_id uuid references document_templates(id) on delete set null,
  created_by text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  foreign key (tenant_id, template_group_id)
    references document_template_groups(tenant_id, id) on delete cascade
);
```

Accepting a proposal copies validated catalog metadata into a new or explicitly
selected template, queues the description embedding, and records the created
template ID. It does not approve a blueprint or manufacture raw DOCX XML.

### 5.6 Silo Assignment

```sql
create table document_template_group_silo_access (
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_group_id uuid not null
    references document_template_groups(id) on delete cascade,
  silo_id uuid not null references silos(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (template_group_id, silo_id)
);
```

An assignment makes the group tool available to both Ask and Extraction in the
silo. This deliberately avoids a second task-binding screen: the operator makes
one understandable assignment and both model workflows receive the same tool.
The model-facing instructions still prohibit calling the tool unless the user
explicitly requests use of a template.

Every table receives RLS, tenant-consistency enforcement, and the same
`service_role` policy and `updated_at` trigger conventions as the current
schema.

---

## 6. Embedding Lifecycle

Creating a template or changing its title/description performs these steps:

1. validate and normalize the title and description;
2. compute `description_sha256` from the canonical embedding input;
3. save the template transactionally with status `queued` or `stale`;
4. enqueue a small template-description embedding job;
5. embed with the tenant's active Template Catalog profile;
6. validate finite values and the exact dimension count;
7. upsert the embedding row with provider/model/source metadata;
8. set the template status to `ready` only when the source hash still matches.

An old job that finishes after a later description edit must not overwrite the
newer description's vector.

Title search remains available while a vector is queued, stale, or failed.
Semantic search excludes that template until a compatible ready vector exists.
The administrator UI must show the degraded state rather than pretending the
template participates in semantic ranking.

Template vectors are derived indexes. Portable export includes titles and
descriptions but excludes vectors; import re-embeds them with the destination
tenant's profile.

---

## 7. Search Within One Group

There is no tenant-wide model tool that searches every template. The dynamic
tool already identifies the group, and the runtime binds `template_group_id`
from the resolved tool definition. A model never supplies a group or tenant ID.

### 7.1 Search Modes

- `title`: full-text title matching with an exact normalized-title boost;
- `semantic`: cosine similarity against compatible description vectors;
- `hybrid`: title and semantic candidates combined with reciprocal-rank fusion;
  this is the default.

Reciprocal-rank fusion is preferred over adding raw title rank to cosine
similarity because the two scores have unrelated scales.

If query embedding is unavailable, `semantic` fails explicitly. `hybrid` may
return title-only candidates only when the tool result includes
`semanticUnavailable: true` and the provider error is logged; it must not
silently claim that title-only ranking was hybrid. No query is embedded with a
different provider/model as an automatic fallback.

Both candidate branches apply the group predicate before ranking:

```sql
where t.tenant_id = p_tenant_id
  and t.template_group_id = p_template_group_id
  and t.enabled = true
  and t.deleted_at is null
```

The model-facing path also requires:

- the group is enabled, granted, and bound to the run;
- the template has an active immutable version;
- that version has exactly one approved blueprint;
- semantic candidates use the active compatible embedding profile.

### 7.2 Search Function

Conceptual contract:

```sql
search_document_templates(
  p_tenant_id uuid,
  p_template_group_id uuid,
  p_query_text text,
  p_query_embedding vector default null,
  p_search_mode text default 'hybrid',
  p_top_k integer default 5
)
```

Results include:

```text
template_id
title
description_excerpt
template_version_id
blueprint_id
title_rank
semantic_score
combined_rank
```

The SQL function must reject a semantic/hybrid query whose vector is
incompatible with the active catalog embedding profile. It must never compare
vectors merely because their dimensions happen to match.

For v1, use an exact cosine scan over the already-filtered group subset. Template
Groups are expected to contain far fewer rows than document chunk indexes, and
this guarantees correct group-local Top K. Do not take a tenant-wide approximate
nearest-neighbor Top K and filter it by group afterward; that can omit the true
nearest templates in a small group. If scale later requires HNSW, use the same
dimension-specific cast/index pattern as document embeddings together with a
filter-aware/iterative scan strategy that preserves group-local recall.

### 7.3 Exact Title Behavior

An exact case-insensitive normalized title match within the group is always the
first result unless that template is disabled or not renderable. Prefix and
token matches follow. Semantic similarity resolves natural-language requests
such as "a monthly update for elected officials covering initiatives and
funding gaps" even when none of those words occur in the title.

---

## 8. The Template Group As A Tool

Each resolved Template Group becomes one dynamically named tool.

Example group:

```json
{
  "name": "Municipal reports",
  "toolName": "municipal_reports",
  "toolDescription": "Search approved municipal reporting templates when the user asks for a town manager, council, initiative, capital, or operational report."
}
```

Model call:

```json
{
  "tool": "municipal_reports",
  "query": "monthly town manager report with initiative status and funding gaps",
  "searchMode": "hybrid",
  "topK": 5
}
```

Tool result:

```json
{
  "group": "Municipal reports",
  "results": [
    {
      "templateId": "uuid",
      "title": "Town Manager Monthly Report",
      "descriptionExcerpt": "Relevant excerpt from the detailed model-facing description...",
      "templateVersionId": "uuid",
      "blueprintId": "uuid",
      "match": {
        "titleRank": 0.73,
        "semanticScore": 0.89,
        "combinedRank": 1
      }
    }
  ]
}
```

The dynamic group tool selects candidates. It does not return the full
blueprint or an unbounded 12,000-character description, and it does not render
a document. After selection:

1. `get_template_contract` loads the approved semantic contract;
2. the agent treats every field and collection instruction in that contract as
   a research requirement and issues focused silo `rag_search` calls;
3. the agent opens a template workspace and builds Agent Data incrementally;
4. `edit_document` updates fields and collections across bounded calls;
5. `finalize_document` renders and persists the final DOCX.

Ask does not run RAG against the raw user request before this sequence. The
model sees the request and available group tools first. For a general request
such as “complete the monthly report using the templates,” the template
contract helps the model determine which operational, financial, staffing,
project, and other source searches are actually needed. Retrieval is not
mechanically required when the request already supplies sufficient information.

The assigned group list is capability context. The model receives each tool's
name, description, and intended outcome and decides whether a Template Group is
relevant. A named or explicitly requested template is a strong signal, but the
runtime does not gate group calls through a keyword questionnaire. Guidance
directs the model away from unrelated templates without suppressing valid
outcome-based selection.

All group and document-editor calls consume the shared run `maxToolRequests`
budget. `rag_search` additionally has an independent per-request maximum, and
library bindings retain their per-group `max_polls` budgets.

### 8.1 Resolution Rules

`resolve_template_group_tools` offers a group tool only when all of these hold:

- the group belongs to the run's tenant and is enabled;
- the target silo has an access grant;
- `tool_name` does not collide with any other resolved tool;
- the group contains at least one enabled template with a `needs_review`,
  `approved`, or `completed` version that the deterministic renderer can load;
- at least title search is operational.

An empty, deleted, ungranted, unbound, or entirely unapproved group is absent
from the model tool list. The model is never told to call a tool that cannot
return a renderable template.

---

## 9. Provider-Neutral Model Role

Connected OpenAI OAuth models are one strong fit for semantic authoring tasks,
provided the system preserves a deterministic boundary around storage and Word
package mutation.

The same contract applies to capable Ollama, OpenAI API, Modular, Together AI,
OpenRouter, and Mistral models selected in Configuration. Provider selection
changes transport and credentials, not template ownership, tool schemas,
validation, storage paths, or approval rules.

Recommended model tasks:

| Task key             | Purpose                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `template_authoring` | Turn a user's intent into a proposed title, detailed description, field contract, and authoring guidance. |
| `template_analysis`  | Interpret an uploaded DOCX structure and produce a semantic blueprint proposal.                           |
| `template_vision`    | Later page-image interpretation for visually implied regions.                                             |

Two authoring paths are supported conceptually:

1. **Upload-first:** an author uploads a designed DOCX; the model proposes its
   title, detailed description, and semantic blueprint from the extracted
   structure.
2. **Intent-first:** an author describes the needed output; the model produces a
   validated `TemplateAuthoringSpec` containing title, detailed description,
   audience, fields, collections, assets, and layout guidance. The author then
   supplies a matching DOCX. A later deterministic starter-template builder may
   materialize a basic DOCX from that spec, but free-form model-generated Word
   XML is not an accepted creation path.

Conceptual authoring result:

```json
{
  "title": "Town Manager Monthly Report",
  "description": "Detailed 200–12,000 character selection description...",
  "audience": ["Town Council", "department leadership"],
  "fields": [
    {
      "fieldId": "executive_summary",
      "type": "rich_text",
      "instruction": "Summarize the reporting period in 2–4 paragraphs."
    }
  ],
  "collections": [
    {
      "collectionId": "priority_initiatives",
      "fields": ["initiative", "owner", "status", "funding_gap"]
    }
  ],
  "layoutGuidance": [
    "Use a repeating initiative table",
    "Preserve municipal branding"
  ]
}
```

The current application validation allows `openai_oauth` only for Ask and
Extraction. Implementation must deliberately extend that allowlist to
`template_authoring`, `template_analysis`, and later `template_vision` before
the provider can be selected for those cards.

OAuth-backed reasoning models do not replace the embedding provider. Template
description vectors come from the configured Template Catalog embedding model.
The current embedding providers are a separate runtime path, and the system
must not assume that a connected interactive OAuth account authorizes general
`/v1/embeddings` requests.

This boundary also matches the official OpenAI platform surface: API
authentication documents API-key or workload-identity bearer credentials, and
the model catalog lists `text-embedding-3-small` and
`text-embedding-3-large` as dedicated embedding models. See
[OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication)
and [OpenAI models](https://developers.openai.com/api/docs/models/all).

The authoring/analyzer model may emit structured proposals only. It does not:

- write directly to database tables;
- approve its own blueprint;
- emit or mutate raw Word XML;
- choose a tenant, silo, project, group, or access grant;
- create a stored vector itself.

Application code validates the proposal, a person approves material semantic
changes, deterministic DOCX code owns Word-package bytes, and the embedding
runtime creates the vector.

---

## 10. Templates User Interface

Add a top-level **Templates** navigation item and route at `/templates`.

Recommended layout:

1. **Template Groups** — create, rename, describe, enable, and define the tool.
2. **Templates in the selected group** — title, description, active version,
   blueprint state, and embedding state.
3. **Create or upload** — author with a configured model or upload an existing
   DOCX, always selecting/creating the group first.
4. **Configuration and ingestion** — versioned Template Configuration,
   immutable files, DOCX-split journal, package manifest, extracted-image
   browser, asset usages, and structure summary.
5. **Analysis and approval** — semantic-analysis journal, blueprint review, and
   active-version approval.
6. **Search preview** — run title, semantic, and hybrid queries inside the
   selected group and show why each result ranked.
7. **Templates Assigned to Silos** — a separate `/template-silo` page with
   groups on the left and one vertical silo checklist on the right.
8. **Catalog embedding settings** — select/test the provider, model, and
   dimensions; show incompatible/stale vector counts before re-embedding.

Selecting a group filters every panel. The interface must never show an
unscoped template list that suggests templates can float outside groups.

---

## 11. Public API Shape

The API is rooted under `/api/v1/template-groups`, not `/api/v1/libraries`.
The currently implemented group and assignment surface is:

```text
GET    /api/v1/template-groups
GET    /api/v1/template-groups/{templateGroupId}
PATCH  /api/v1/template-groups/{templateGroupId}
GET    /api/v1/template-groups/{templateGroupId}/templates
DELETE /api/v1/template-groups/{templateGroupId}/templates/{templateId}
GET    /api/v1/template-groups/{templateGroupId}/silos
PUT    /api/v1/template-groups/{templateGroupId}/silos
DELETE /api/v1/template-groups/{templateGroupId}/silos/{siloId}
```

The broader Document Engine target remains:

```text
GET    /api/v1/template-groups
POST   /api/v1/template-groups
GET    /api/v1/template-groups/{groupId}
PATCH  /api/v1/template-groups/{groupId}
DELETE /api/v1/template-groups/{groupId}

GET    /api/v1/template-catalog/settings
PUT    /api/v1/template-catalog/settings
POST   /api/v1/template-catalog/settings/test
POST   /api/v1/template-catalog/reembed

GET    /api/v1/template-groups/{groupId}/templates
POST   /api/v1/template-groups/{groupId}/templates
GET    /api/v1/template-groups/{groupId}/templates/{templateId}
PATCH  /api/v1/template-groups/{groupId}/templates/{templateId}
DELETE /api/v1/template-groups/{groupId}/templates/{templateId}

POST   /api/v1/template-groups/{groupId}/search

POST   /api/v1/template-groups/{groupId}/authoring-proposals
GET    /api/v1/template-groups/{groupId}/authoring-proposals/{proposalId}
POST   /api/v1/template-groups/{groupId}/authoring-proposals/{proposalId}/accept
POST   /api/v1/template-groups/{groupId}/authoring-proposals/{proposalId}/reject

GET    /api/v1/templates/{templateId}/configuration
POST   /api/v1/templates/{templateId}/configuration/revisions
POST   /api/v1/templates/{templateId}/configuration/{configurationId}/activate

GET    /api/v1/templates/{templateId}/versions
POST   /api/v1/templates/{templateId}/versions
POST   /api/v1/templates/{templateId}/versions/{versionId}/ingest
GET    /api/v1/templates/{templateId}/versions/{versionId}/ingestion
GET    /api/v1/templates/{templateId}/versions/{versionId}/manifest
GET    /api/v1/templates/{templateId}/versions/{versionId}/assets
POST   /api/v1/templates/{templateId}/versions/{versionId}/analyze
GET    /api/v1/templates/{templateId}/versions/{versionId}/analysis
GET    /api/v1/templates/{templateId}/versions/{versionId}/blueprint
POST   /api/v1/templates/{templateId}/render

```

Scopes remain separated by authority:

| Scope             | Permits                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `templates:read`  | Read groups, templates, configurations, versions, ingestion manifests/assets, blueprints, analysis state, and search results. |
| `templates:write` | Create/edit/delete groups, templates, and configurations; upload/ingest versions; analyze, review, approve, and render.       |
| `templates:grant` | Assign or remove Template Groups from silos.                                                                                  |

`templates:grant` must never be included by an implicit default-all expansion.

---

## 12. Lifecycle, Moves, And Deletion

- A new template must name an existing group or create a group in the same
  transaction/workflow.
- Moving a template changes its `template_group_id`, is audited, and immediately
  changes which group tool may return it.
- Editing title or description marks the embedding stale and queues a refresh.
- Activating a Template Configuration affects future ingestion and is snapshotted
  by every job/version; it never rewrites a historical snapshot.
- Uploading a new DOCX creates a version; it does not replace old bytes.
- Semantic analysis is gated on completed deterministic DOCX ingestion.
- Approving a blueprint may activate that version explicitly. Approval and
  activation are separate audit events.
- Disabling a template removes it from model search but preserves versions and
  generated-document provenance.
- Deleting a template soft-deletes and disables its catalog entry, cancels
  active ingestion and embedding jobs, removes its description vector, and
  changes its slug so a replacement can reuse the original title. Immutable
  source versions, extraction artifacts, and job history remain private for
  reproducibility.
- Deleting a group with templates is restricted. An administrator must move,
  delete, or disable its templates first.
- Templates referenced by generated files should be soft-deleted so historical
  outputs remain reproducible.
- Generated-file provenance snapshots the Template Group ID and tool name used
  for selection as well as the template version, blueprint, and Agent Data hash.

---

## 13. Acceptance Criteria

### Ownership

- Creating a template without `template_group_id` fails.
- Assigning a template to a group in another tenant fails.
- A template belongs to one group without a membership join table.
- Moving a template makes it disappear from the old group and appear in the new
  group atomically.

### Search

- An exact title query returns the matching renderable template first within
  the group.
- A natural-language use-case query finds a relevant template through its
  detailed description even when the title shares no query terms.
- A template in another group never appears.
- Hybrid search combines title and semantic rank without adding incomparable raw
  scores.
- A stale or failed vector is excluded from semantic ranking but remains
  eligible for title search.
- A query vector from another model/profile is rejected.
- A semantic provider failure is explicit; any hybrid title-only degradation is
  labeled in the tool result.

### Tool Resolution

- One enabled and bound Template Group produces exactly one dynamic tool.
- The group tool returns candidates and never returns source-document evidence.
- An empty, ungranted, unbound, disabled, or wholly unapproved group produces no
  model tool.
- Group calls respect both `maxToolRequests` and `max_polls`.

### Authoring And Rendering

- A configured OpenAI OAuth model can be selected for the approved template
  authoring/analysis task keys after the provider allowlist is extended.
- OAuth model output is validated structured data and cannot write Word XML or
  approve itself.
- The selected template resolves to one active immutable version and one
  approved blueprint before `write_document` runs.
- Generated-document provenance records the template, version, blueprint, and
  Agent Data hash, plus the Template Group ID and tool-name snapshot used for
  discovery.

---

## 14. Final Boundary

The complete flow is:

```text
Administrator creates Template Group
  → group defines one model tool
  → author uploads or model-assists a template
  → template receives a detailed description
  → embedding runtime stores its description vector
  → analyzer compiles and reviewer approves a blueprint
  → administrator grants and binds the group tool
  → agent calls the group tool with a use-case query
  → runtime searches title + vector inside that group only
  → agent loads the selected template contract
  → agent gathers evidence and builds Agent Data
  → deterministic renderer persists the final DOCX
```

Template Groups own discovery. Templates own identity and semantic selection
metadata. Versions own immutable DOCX bytes. Blueprints own the rendering
contract. Models own semantic proposals and content. Deterministic application
code owns authorization, vector compatibility, validation, persistence, and all
Word-package mutation.
