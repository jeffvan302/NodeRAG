# Document Engine — Phase Implementation Plan

**Status:** Template catalog, runnable DOCX ingestion, silo assignment,
Ask/Extraction discovery tools, and the first placeholder-driven,
template-preserving deterministic DOCX renderer are implemented. Persisted
blueprint approval and advanced image/conditional rendering remain phased work.
**Scope:** How the Template Analyzer / Blueprint Compiler and the Agent Document
Write / Render Tool are built inside this repository, in what order, and with
what blast radius on existing behaviour.

Source specifications, which this plan implements rather than restates:

- [document_engine_overview.md](document_engine_overview.md) — why the engine exists.
- [template_catalog_and_group_tool_spec.md](template_catalog_and_group_tool_spec.md) — first-class template ownership, discovery, and group tools.
- [template_docx_ingestion_and_storage_spec.md](template_docx_ingestion_and_storage_spec.md) — per-template storage, configuration snapshots, DOCX splitting, and extracted assets.
- [document_template_analyzer_blueprint_spec.md](document_template_analyzer_blueprint_spec.md) — analyzer contract.
- [agent_document_write_render_tool_spec.md](agent_document_write_render_tool_spec.md) — renderer and tool contract.

Reference fixture: `docs/Templates/Fincentiv_Town_Manager_Report_Template_v1.docx`.

---

## 0. Decisions this plan is built on

Four questions were open before the work could be sequenced. They are settled
here, with the reason, because each one changes the shape of several phases.

### 0.1 Templates get their own database segment

Templates do **not** reuse `libraries` or `library_projects`. A first-class set
of tables prefixed `document_template_*` is created.

Each template has one required `template_group_id`. A Template Group is both
the administrative container and one dynamic model tool. Its tool searches the
titles and description vectors of renderable templates in that group only.
There is no many-to-many template/project membership and no Library parent.

A `library_projects` row means _one RAG evidence-search tool_. A
`document_template_groups` row means _one template-discovery tool_. The two
tool types have different stored items, ranking units, results, and final
actions, so sharing a table or UI would blur an authorization and semantic
boundary.

The cost accepted: the silo-grant and task-binding patterns are implemented for
Template Groups as separately scoped tables. These are small and
security-sensitive enough that explicit ownership is preferable to a generic
cross-subsystem binding table.

### 0.2 Ingestion uses one durable job with deterministic and model checkpoints

Deterministic extraction over a large template plus a semantic model call is not
safe inside one HTTP request. A durable DOCX-ingestion job therefore follows a
typed instruction envelope, persists the deterministic package artifacts first,
then runs the selected provider through the bound Template Ingestion tools. The
stage journal makes the deterministic output inspectable even when model
analysis fails. Description embedding remains a separate queue because it has a
different input, model profile, and retry boundary.

Rendering, by contrast, is synchronous. It is deterministic ZIP/XML work with no
model call, and the tool contract in the render spec §31 requires that
`write_document` only returns after persistence succeeds.

### 0.3 Page rendering and vision are a later phase

Phases 1–7 compile a blueprint from structure, text, and deterministic
heuristics only. No LibreOffice service, no page images, no multimodal call.

This is affordable because the blueprint schema, the model prompt contract, and
the confidence policy already have room for previews: adding them later adds
inputs to an existing stage rather than changing any stored shape. It is also
sufficient for the reference fixture, which is 100% placeholder-driven — see
§11.1. Templates that rely on visually-implied bindings will compile with lower
confidence and land in review until Phase 8 is built.

### 0.4 Current implementation boundary

Production code now covers the Template navigation, editable groups, uploads,
provider-neutral model task, deterministic package split, model tool execution,
ingestion-generated description and embedding queue, editable inspection metadata, retry/redo, progress,
inspection ZIP download, silo assignment, assigned-group tool resolution and
catalog search in Ask/Extraction, a semantic render contract, real
`get_template_contract` / `write_document` tool execution, and preservation-first
DOCX generation from explicit placeholders and repeating rows. Generated files
are persisted and downloadable through the existing generated-file system.
The remaining phases below still define persisted blueprint review, visually
implied bindings, conditional structures, and image replacement without making
those later stages a prerequisite for renderer testing.

For the current DOCX-ingestion acceptance boundary, an operator can upload a
DOCX, observe durable stage progress, use any configured supported provider,
inspect extracted images and exact structure/model outputs in a ZIP, edit the
generated catalog description and download metadata, retry a failed run, and
redo a successful run against the preserved DOCX with the current model-task
settings and instructions.

For the current DOCX-renderer acceptance boundary, an Ask or Extraction model
with an assigned Template Group can select a template, request its hash-bound
semantic contract, supply scalar values, paragraphs/headings, generated tables,
and repeating table rows, and receive a persistent DOCX file ID. The v1 engine
preserves the original package layout and images and rejects stale
version/contract pairs. It does not yet replace images or infer slots that have
no explicit placeholder structure.

---

## 1. Blast radius

The engine is additive. The table below is the complete list of existing files
that must change, and nothing outside it should be touched.

| Existing file / object                                                                                                  | Change                                                                                                                                                                                                                                                                                                 | Phase           |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `packages/rag-core/src/index.ts`                                                                                        | `STORAGE_BUCKETS` += `document-templates`; `MODEL_TASK_KEYS` += template authoring/analysis/vision; `MODEL_TOOL_NAMES` += `write_document`, `get_template_contract`; `OUTPUT_FILE_FORMATS` += `docx`; Template Configuration, ingestion-instruction, blueprint, asset-manifest, and Agent Data schemas | 1, 2, 3, 5, 7   |
| `apps/web/src/lib/generated-files.ts`                                                                                   | Accept a binary body; format-aware content preview                                                                                                                                                                                                                                                     | 5               |
| `apps/worker/src/index.ts`                                                                                              | Queue claims for template-description embedding, deterministic DOCX ingestion, and semantic analysis; shared binary generated-file writer                                                                                                                                                              | 2, 3, 5         |
| `apps/web/src/lib/ask-model-execution.ts`, `extraction-model-execution.ts`                                              | `write_document` and `get_template_contract` as real tool calls                                                                                                                                                                                                                                        | 7               |
| `apps/web/src/lib/ask-model-context.ts`, `extraction-model-context.ts`                                                  | Inject the template contract when templates are bound                                                                                                                                                                                                                                                  | 7               |
| `apps/web/src/lib/api-keys.ts`                                                                                          | `API_KEY_SCOPES` += `templates:read`, `templates:write`, `templates:grant`                                                                                                                                                                                                                             | 2               |
| `apps/web/src/app/configuration/page.tsx`                                                                               | Template authoring/analysis task cards; OAuth-provider allowlist; `MODEL_TASK_ORDER`, `taskLabel`, and agent/retrieval guards                                                                                                                                                                          | 3               |
| `apps/web/src/app/templates/*`                                                                                          | New first-class Templates section: groups, template metadata, versions, search preview, access, and bindings                                                                                                                                                                                           | 2, 4, 6         |
| `apps/web/src/app/apitest/page.tsx`                                                                                     | Template Engine panel; `ApiKeyScope` union                                                                                                                                                                                                                                                             | 2, 4, 5         |
| `supabase/migrations/*`                                                                                                 | Four new migrations (§2.7)                                                                                                                                                                                                                                                                             | 2, 3, 5, 6      |
| `platform/supabase-resources.v1.json`, `platform/migration-checksums.v1.json`, `platform/environment-variables.v1.json` | New bucket + tables + functions, checksums, migration head                                                                                                                                                                                                                                             | every migration |
| `docs/api-usage.md`, `docs/api/rest-api-command-reference.md`                                                           | Every new `/api/v1` route, twice each (§12.2)                                                                                                                                                                                                                                                          | 2, 4, 5, 6      |

Explicitly **not** changed: `documents`, `document_chunks`,
`document_embeddings`, `match_document_embeddings`, `rag-retrieval.ts`, the
document-ingestion pipeline, the existing `write_file` behaviour, `libraries`,
`library_projects`, `library_project_documents`, `library_project_access`,
`library_tool_bindings`, and `resolve_library_tools`.

A template is never chunked and has no document-RAG path. Its detailed catalog
description is embedded once in the separate
`document_template_description_embeddings` table so the containing Template
Group tool can perform semantic selection. Template search results are
candidates for rendering, never evidence for an answer.

---

## 2. The template database segment

### 2.1 Shape

```text
document_template_groups                       one container + dynamic tool
   ├── document_template_authoring_proposals    reviewed model proposals
   ├── document_templates                      required one-group ownership
   │       ├── document_template_configurations versioned ingestion/analyzer config
   │       ├── document_template_description_embeddings
   │       └── document_template_versions      immutable bytes + sha256
   │               ├── document_template_blueprints
   │               ├── document_template_assets
   │               ├── document_template_asset_usages
   │               ├── document_template_ingestion_jobs/events
   │               ├── document_template_analysis_jobs
   │               └── document_template_analysis_events
   ├── document_template_group_access          silo grants
   └── document_template_group_bindings        ask / extraction enablement

document_template_catalog_settings             one embedding profile per tenant
```

Three rules the schema enforces rather than merely documents:

1. Every template belongs to exactly one Template Group in the same tenant.
   There is no membership join table.
2. One Template Group defines one tenant-unique dynamic tool name. That tool
   can return templates from its own group only.
3. A binding may reference only a group the silo has been granted. Granting is
   an administrative act; enabling is a per-task choice.

### 2.2 Core tables

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

create table document_template_catalog_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  embedding_provider text not null
    check (embedding_provider in ('supabase', 'ollama', 'openai')),
  embedding_model text not null,
  embedding_dimensions integer not null,
  embedding_source_version text not null default 'template-description-v1',
  updated_at timestamptz not null default now()
);

create table document_template_description_embeddings (
  template_id uuid primary key
    references document_templates(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  embedding_provider text not null,
  embedding_model text not null,
  embedding_dimensions integer not null,
  embedding_source_version text not null,
  source_sha256 text not null,
  embedding vector not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, template_id)
);

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

create table document_template_configurations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_id uuid not null references document_templates(id) on delete cascade,
  revision integer not null,
  schema_version text not null default '1.0',
  configuration_json jsonb not null,
  configuration_sha256 text not null,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'superseded')),
  created_by text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique (template_id, revision)
);

create unique index document_template_configurations_one_active_idx
on document_template_configurations (template_id)
where status = 'active';

create table document_template_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_id uuid not null references document_templates(id) on delete cascade,
  version_number integer not null,
  file_name text not null,
  mime_type text not null,
  bucket text not null default 'document-templates',
  storage_path text not null,
  byte_size bigint not null,
  sha256 text not null,
  configuration_id uuid not null
    references document_template_configurations(id) on delete restrict,
  configuration_sha256 text not null,
  ingestion_status text not null default 'uploaded'
    check (ingestion_status in (
      'uploaded', 'queued', 'validating_package', 'inventorying_parts',
      'resolving_relationships', 'extracting_assets',
      'extracting_structure', 'persisting_manifest', 'ingested', 'failed'
    )),
  analysis_status text not null default 'not_started'
    check (analysis_status in (
      'not_started', 'queued', 'semantic_analysis', 'merging',
      'validating_blueprint', 'needs_review', 'approved', 'failed'
  )),
  structure_json jsonb,          -- deterministic element map, §4.3
  ingestion_manifest_json jsonb,
  ingestion_manifest_sha256 text,
  package_manifest_sha256 text,
  asset_manifest_sha256 text,
  structure_sha256 text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_id, version_number),
  unique (bucket, storage_path)
);

-- Restored after both templates and versions, avoiding a circular FK restore.
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

create table document_template_blueprints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_version_id uuid not null
    references document_template_versions(id) on delete cascade,
  blueprint_schema_version text not null default '1.0',
  blueprint_json jsonb not null,
  analyzer_version text not null,
  model_provider text,
  model_name text,
  overall_confidence numeric(4,3),
  review_status text not null default 'draft'
    check (review_status in ('draft', 'needs_review', 'approved', 'rejected')),
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one approved blueprint per template version. Generation resolves a
-- template version to exactly one contract, and "the newest approved one" is
-- the kind of implicit rule that produces two different documents from the same
-- request six months apart.
create unique index document_template_blueprints_one_approved_idx
on document_template_blueprints (template_version_id)
where review_status = 'approved';

create table document_template_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_version_id uuid not null
    references document_template_versions(id) on delete cascade,
  package_part_path text not null,
  safe_file_name text not null,
  asset_type text not null
    check (asset_type in ('image', 'chart', 'embedded_object', 'other')),
  mime_type text not null,
  bucket text not null default 'document-templates',
  storage_path text not null,
  byte_size bigint not null,
  sha256 text not null,
  width_pixels integer,
  height_pixels integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (template_version_id, package_part_path),
  unique (bucket, storage_path)
);

create table document_template_asset_usages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_version_id uuid not null
    references document_template_versions(id) on delete cascade,
  asset_id uuid references document_template_assets(id) on delete cascade,
  source_part_path text not null,
  relationship_id text,
  element_id text,
  usage_kind text not null
    check (usage_kind in (
      'inline', 'anchor', 'background', 'header', 'footer',
      'shape_fill', 'ole_preview', 'unknown'
    )),
  relationship_status text not null default 'resolved'
    check (relationship_status in ('resolved', 'external', 'dangling', 'orphaned')),
  placement jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index document_template_asset_usages_version_idx
on document_template_asset_usages (template_version_id, source_part_path);
```

`structure_json` lives on the version rather than the blueprint deliberately.
It is a property of the bytes, it is recomputed identically on every reanalysis,
and the renderer needs it to resolve element IDs even when a blueprint is being
re-cut.

The version's `configuration_id` and SHA are the immutable ingestion snapshot.
Later semantic reanalysis may snapshot a newer configuration on its analysis
job, but it cannot silently change which instructions produced the stored
package manifest, structure, and extracted assets.

`document_template_assets` stores one byte-for-byte copy per physical media
part. `document_template_asset_usages` stores each drawing/relationship
occurrence separately, so one shared image used in four headers produces one
asset and four usages. A dangling reference has a nullable `asset_id` and a
warning rather than a fabricated file.

Tenant-consistency triggers additionally enforce that a version's configuration
belongs to the same template, and that every asset usage plus referenced asset
belongs to the same version. These are required invariants, not application-only
checks.

The catalog embedding is computed from the normalized title plus the detailed
description, using the versioned canonical form in the catalog/group-tool spec
§5.3. The provider, model, dimensions, source format version, and source SHA are
stored with every vector. A query vector is compared only with rows from the
active compatible profile; matching dimensions alone are insufficient.

### 2.3 Embedding, ingestion, and analysis queues

A separate queue, not `processing_jobs`. That table's `job_type` check is
`('ingest','reprocess','extract','embed','delete')` and its `document_id` is a
foreign key to `documents` — a template is not a document and never becomes one.

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

create table document_template_ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_version_id uuid not null
    references document_template_versions(id) on delete cascade,
  configuration_id uuid not null
    references document_template_configurations(id) on delete restrict,
  source_sha256 text not null,
  configuration_sha256 text not null,
  instructions_json jsonb not null,
  status processing_job_status not null default 'queued',
  stage text not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  progress jsonb not null default '{}'::jsonb,
  error_message text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  locked_at timestamptz,
  locked_by text
);

create unique index document_template_ingestion_jobs_active_idx
on document_template_ingestion_jobs (template_version_id)
where status in ('queued', 'running');

create table document_template_ingestion_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  job_id uuid not null
    references document_template_ingestion_jobs(id) on delete cascade,
  sequence integer not null,
  event_type text not null,
  stage text,
  label text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (job_id, sequence)
);

create table document_template_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_version_id uuid not null
    references document_template_versions(id) on delete cascade,
  configuration_id uuid not null
    references document_template_configurations(id) on delete restrict,
  configuration_sha256 text not null,
  status processing_job_status not null default 'queued',
  stage text not null default 'semantic_analysis',
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  requested_config jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  error_message text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  locked_at timestamptz,
  locked_by text
);

-- One live job per version. A double-click on "Analyze" must not spend two
-- model calls.
create unique index document_template_analysis_jobs_active_idx
on document_template_analysis_jobs (template_version_id)
where status in ('queued', 'running');

create table document_template_analysis_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  job_id uuid not null
    references document_template_analysis_jobs(id) on delete cascade,
  sequence integer not null,
  event_type text not null,
  stage text,
  label text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (job_id, sequence)
);
```

Both event journals follow `ask_run_events`: the HTTP view is one view over a
persisted run, so a lost connection during DOCX splitting or semantic analysis
does not lose progress. The semantic analysis job may be queued only after its
version has reached `ingested` and its structure/asset-manifest hashes validate.

### 2.4 Template Group access and bindings

```sql
create table document_template_group_access (
  template_group_id uuid not null
    references document_template_groups(id) on delete cascade,
  silo_id uuid not null references silos(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (template_group_id, silo_id)
);

create table document_template_group_bindings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  silo_id uuid not null references silos(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  task_key text not null check (task_key in ('ask', 'extraction')),
  template_group_id uuid not null
    references document_template_groups(id) on delete cascade,
  max_polls integer not null default 3 check (max_polls between 1 and 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct
    (silo_id, project_id, task_key, template_group_id)
);
```

Every table in §2.2, §2.3, and §2.4 gets `enable row level security` and a
`service_role_all_*` policy, and every table carrying `updated_at` gets a
`before update ... execute function set_updated_at()` trigger — matching every
other table in this schema.

### 2.5 Resolution function

```sql
create or replace function resolve_template_group_tools(
  p_tenant_id uuid,
  p_silo_id uuid,
  p_project_id uuid,
  p_task_key text
)
returns table (
  template_group_id uuid,
  tool_name text,
  group_name text,
  tool_description text,
  default_search_mode text,
  default_top_k integer,
  max_polls integer
)
```

Selection rules, all of which are refusals rather than fallbacks:

- the Template Group is `enabled`;
- the silo appears in `document_template_group_access`;
- a binding exists for the task, project-level winning over the silo-level
  default exactly as `resolve_library_tools` does;
- the group has at least one enabled, non-deleted template with a
  `document_template_active_versions` row and an approved blueprint;
- its dynamic tool name does not collide with any built-in or other resolved
  dynamic tool.

The group tool resolves first. A call then runs `search_document_templates`
with the resolved `template_group_id`; the model never supplies a tenant or
group ID. Title, semantic, and hybrid candidate branches filter by that group
before ranking. A template with no approved blueprint is excluded from the
model-facing search result rather than offered in degraded form.

```sql
create or replace function search_document_templates(
  p_tenant_id uuid,
  p_template_group_id uuid,
  p_query_text text,
  p_query_embedding vector default null,
  p_search_mode text default 'hybrid',
  p_top_k integer default 5
)
returns table (
  template_id uuid,
  title text,
  description_excerpt text,
  template_version_id uuid,
  blueprint_id uuid,
  title_rank double precision,
  semantic_score double precision,
  combined_rank double precision
)
```

The exact SQL follows the catalog/group-tool spec §7: exact normalized titles
receive a deterministic boost; semantic search compares only compatible
vectors; hybrid mode uses reciprocal-rank fusion rather than adding unrelated
raw scores. Title search stays operational while a description vector is
queued or stale, but such a row cannot enter the semantic branch.

`semantic` mode fails if query embedding is unavailable. `hybrid` may degrade
to title-only only with an explicit `semanticUnavailable: true` result marker;
it never embeds with an incompatible fallback profile.

V1 performs exact cosine ranking over the group-filtered subset. It must not
take a tenant-wide approximate Top K and filter afterward, because that can lose
the true group-local nearest neighbors. Dimension-specific HNSW indexes are a
later optimization only if filter-aware recall is preserved.

### 2.6 Generated-document provenance

`generated_files` gains seven nullable columns and no behaviour change for
existing rows:

```sql
alter table generated_files
  add column template_group_id uuid
    references document_template_groups(id) on delete set null,
  add column template_tool_name text,
  add column template_version_id uuid
    references document_template_versions(id) on delete set null,
  add column template_configuration_id uuid
    references document_template_configurations(id) on delete set null,
  add column template_ingestion_manifest_sha256 text,
  add column blueprint_id uuid
    references document_template_blueprints(id) on delete set null,
  add column agent_data_sha256 text;
```

`template_tool_name` is a snapshot. A later group rename or template move must
not rewrite how a historical run discovered its template.

The Agent Data snapshot itself is written to the templates bucket at
`generated/{tenantId}/{generatedFileId}/agent-data.json` and referenced from
`metadata`, not stored inline. A report with forty initiative rows and full
provenance is not a row-sized object, and `generated_files` is read on every
file listing.

### 2.7 Migration sequence

Four migrations, each independently deployable, each landing with its own
`platform:checksums` run and manifest update (§12.1):

1. `..._document_template_segment.sql` — §2.2, §2.3, RLS, indexes.
2. `..._document_template_group_tools.sql` — §2.4, §2.5,
   `search_document_templates`, RLS, and tenant/access consistency triggers.
3. `..._document_template_model_tasks.sql` — `model_task_configs.task_key`
   check extended with `template_authoring`, `template_analysis`, and
   `template_vision`; seed rows for the default tenant copying the pattern in
   `20260716000300_pdf_assembly_task_config.sql`; `api_keys.scopes` default
   extended with `templates:read` and `templates:write`.
4. `..._document_output_format.sql` — `generated_files.output_format` check
   extended with `docx`; the `generated-files` bucket's `allowed_mime_types`
   extended with the DOCX MIME (it is still the original text-only list from
   `20260714000500`); §2.6 columns; built-in-name checks for both
   `library_projects` and `document_template_groups` include `write_document`
   and `get_template_contract`.

   The bucket's size limit needs no change: `20260716000400_large_pdf_ingress_limits.sql`
   already raised `generated-files` to 50 MB. Note that
   [agent_write_file_tool.md](../api/agent_write_file_tool.md) still describes it
   as 10 MB — that doc is stale on this point and should be corrected alongside.

Migration 4 carries the only changes that touch a table existing agent code
writes to. Both are widening constraints — no existing row or code path changes
meaning.

---

## 3. Storage

New private bucket `document-templates`, added to `STORAGE_BUCKETS` in
`packages/rag-core/src/index.ts` and to `storageBuckets` in
`platform/supabase-resources.v1.json`.

```text
templates/{tenantId}/{templateId}/configuration/revisions/{configurationId}.json
templates/{tenantId}/{templateId}/versions/{versionId}/source/template.docx
templates/{tenantId}/{templateId}/versions/{versionId}/manifests/package-manifest.json
templates/{tenantId}/{templateId}/versions/{versionId}/manifests/asset-manifest.json
templates/{tenantId}/{templateId}/versions/{versionId}/structure/document-structure.json
templates/{tenantId}/{templateId}/versions/{versionId}/assets/{assetId}/{safeFileName}
templates/{tenantId}/{templateId}/versions/{versionId}/blueprints/{blueprintId}.json
templates/{tenantId}/{templateId}/versions/{versionId}/previews/pages/page-0001.png
generated/{tenantId}/{generatedFileId}/agent-data.json
```

Bucket settings: private, 25 MB object limit, `allowed_mime_types` restricted to
the DOCX MIME, `application/json`, and the explicitly supported Word image
formats (initially PNG, JPEG, GIF, TIFF, BMP, SVG, EMF, and WMF). The blueprint
JSON is archived here in addition to the database column so a
future portable template-catalog export can carry it without a database dump.
Description vectors are derived data and are not exported; the destination
installation re-embeds the title/description with its catalog profile.

Finished documents keep going to `generated-files`, not here. Templates are
input, generated documents are output, and they have different retention and
different delete semantics.

---

## 4. `packages/docx-engine`

A new workspace package. It has no Supabase import, no network access, and no
knowledge of tenants — it takes bytes and returns bytes or a structure. That is
what makes it unit-testable against the fixture without a database.

```text
packages/docx-engine/src/
  package-reader.ts       ZIP open, part inventory, content types, safety limits
  package-manifest.ts     content types, hashes, support/warning inventory
  relationship-graph.ts   .rels parsing, resolution, relationship manager
  asset-extractor.ts      byte-preserving media extraction + metadata
  asset-usages.ts         drawing/relationship occurrences for each asset
  structure-extractor.ts  WordprocessingML → normalized read-only tree
  element-ids.ts          stable IDs, fingerprints, source order
  logical-text.ts         run-boundary-crossing text + character↔run mapping
  table-extractor.ts      tables, rows, cells, merges, grid
  heuristics.ts           placeholder / instruction / repeater / static hints
  blueprint-schema.ts     zod schema for the compiled blueprint
  blueprint-merge.ts      model output + structure → validated blueprint
  package-writer.ts       byte-preserving ZIP rewrite
  text-renderer.ts        scalar and rich-text replacement
  table-renderer.ts       repeat_row, repeat_row_group, prototype removal
  block-renderer.ts       repeat_block, optional_block
  image-renderer.ts       replace_image (Phase 8: insert_image)
  markdown-renderer.ts    supported Markdown subset → Word block model
  validator.ts            pre-render and post-render package validation
  types.ts
```

The runtime-facing `TemplateConfigurationSchema` and
`TemplateIngestionInstructionsSchema` live in `packages/rag-core`; the pure
DOCX engine accepts only the validated extraction options and source bytes. It
never receives tenant authorization or storage credentials.

Dependencies: one ZIP library and one namespace-preserving XML parser/builder.
Both are new to the repo. The parser must be configured to preserve namespace
prefixes, attribute order, mixed content, and unknown elements; a parser that
normalizes away what it does not understand will silently destroy Word XML on
round-trip. This is the single highest-risk technical choice in the plan and
gets its own acceptance test in Phase 1 (§5.3).

### 4.1 The round-trip rule

The analyzer never serializes its analysis tree back into a DOCX. It reads. The
renderer keeps every untouched package entry byte-for-byte and re-serializes
only the XML parts it actually mutated. Stated as code:

```ts
// package-writer.ts
export function writePackage(
  original: ReadPackage,
  mutated: Map<string, Uint8Array>,
): Uint8Array;
```

Anything not present in `mutated` is copied from `original` verbatim.

### 4.2 Element addressing

IDs are analyzer-generated and stable per template version, never XPath:

```text
sec_0001  p_000001  r_000001  tbl_000001  tr_000001  tc_000001  drw_000001
```

Each addressable node stores `{ elementId, partPath, elementType, xmlPath,
parentElementId, siblingIndex, fingerprint, sourceOrder }`. `fingerprint` is a
hash of local structure and text. At render time the engine recomputes IDs from
the stored template bytes and compares fingerprints; a mismatch is
`template_hash_mismatch` and the render refuses, per render spec §4.

### 4.3 `structure_json`

The compact model-facing serialization is derived from the full structure and
is what Phase 3 sends to the model — never raw XML. Target: under 120 KB for
the reference fixture, achieved by summarizing table rows that share a
structural fingerprint rather than listing all 152.

---

## 5. Phases

Each phase is independently shippable, ends green on `pnpm test`,
`pnpm typecheck`, and `pnpm docs:check`, and leaves the deployed system working.

### Implementation checkpoint — 2026-08-16

The initial testable foundation is now on `main`:

- top-level `/templates` navigation and workspace;
- Template Group creation with model tool name and description;
- group-owned template creation from a DOCX upload;
- private `document-templates` storage with stable ID-based source paths;
- template, active-version mapping, configuration, version, asset/usage,
  ingestion-job, description-embedding, and embedding-job tables;
- a typed ingestion envelope that binds the tenant, group, template, version,
  configuration, source path, byte size, and hashes;
- immediate group-scoped title search and queued semantic-vector state;
- visible source, ingestion, asset, and vector status in the Templates page.

The deterministic package compiler, page rendering, image extraction, one-model
vision analysis, embedding worker, review/approval, public v1 API, dynamic tool
binding, and renderer remain subsequent work. A queued state is intentionally
shown as queued; the first slice does not manufacture a completed structure.

### Phase 1 — Deterministic package compiler

**Goal:** split a `.docx` into a package manifest, relationship graph,
byte-preserved assets with usage mappings, physical structure, and heuristic
hints. No database, API, storage client, or model.

Build: `package-reader`, `package-manifest`, `relationship-graph`,
`asset-extractor`, `asset-usages`, `structure-extractor`, `element-ids`,
`logical-text`, `table-extractor`, `heuristics`, plus the compact serializer
behind `structure_json`.

Headers and footers are parsed with the same paragraph/table logic as the body
from day one. The reference fixture has four of each, and half the scalar
metadata a report needs lives there.

Package safety, all in `package-reader` and all enforced before any parsing:
maximum upload size, maximum decompressed size, maximum entry count, ZIP-slip
path rejection, bounded XML part size, external-entity processing disabled,
encrypted-package detection, `.docm` and `.doc` rejected, external relationships
inventoried but never fetched.

**Acceptance (unit tests against both fixtures and hand-built minimal cases):**

- 51 tables, 4 sections, 4 headers, 4 footers, 152 rows detected;
- 519 placeholder occurrences and 147 distinct strings recovered, including
  those split across runs;
- a placeholder deliberately fragmented across three `w:t` nodes resolves to one
  logical span with a correct character→run map;
- mixed portrait/landscape section properties read without modification;
- corrupt ZIP, encrypted DOCX, and `.docm` are rejected with distinct errors;
- **round-trip:** read each fixture, write it back with an empty mutation map,
  and assert every entry is byte-identical — including fixture B's 364 KB PNG
  and the `customXml` part;
- all four of fixture B's header drawings resolve through their own
  `word/_rels/headerN.xml.rels` to the one shared `word/media/image1.png`, with
  anchor geometry captured per header: floating, `behindDoc`, `wrapNone`,
  page-relative horizontal and vertical frames at offset 0, extent in EMU. One
  media part reached from four parts is the case that breaks a naive
  relationship model;
- fixture B returns one byte-identical stored-asset candidate for
  `word/media/image1.png` and four distinct header usage records;
- unreferenced media is emitted as an orphaned asset rather than discarded;
- fixture C's `header2/3/4.xml` drawings are reported as **dangling** — a
  `pic:pic` whose `a:blip` carries no `r:embed`, in a part with no `.rels` —
  and surface as a validation warning naming the part, not as a silent skip and
  not as a crash.

**Done when** a developer can run one function on the fixture and get a stable
package manifest, asset/usage graph, and structure whose IDs and hashes do not
change between runs.

### Phase 2 — Template storage, versions, and upload API

**Goal:** a first-class Template Group can be created, a template with required
group ownership and detailed selection metadata can be stored, its active
Template Configuration can be versioned, and immutable DOCX versions can be
split into persisted manifests, extracted images, usages, and structure.

Migrations 1 and 3 from §2.7. New lib module
`apps/web/src/lib/document-templates.ts` mirroring the shape of
`libraries.ts` (typed record mappers, a `DocumentTemplateError` with code and
status).

Routes, all `withApiV1`, tenant-scoped, and group-scoped where shown:

| Method                 | Route                                                                     | Scope                                |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `GET` `POST`           | `/api/v1/template-groups`                                                 | `templates:read` / `templates:write` |
| `GET` `PATCH` `DELETE` | `/api/v1/template-groups/{groupId}`                                       | `templates:read` / `templates:write` |
| `GET` `PUT`            | `/api/v1/template-catalog/settings`                                       | `templates:read` / `templates:write` |
| `POST`                 | `/api/v1/template-catalog/settings/test`                                  | `templates:write`                    |
| `POST`                 | `/api/v1/template-catalog/reembed`                                        | `templates:write`                    |
| `GET` `POST`           | `/api/v1/template-groups/{groupId}/templates`                             | `templates:read` / `templates:write` |
| `GET` `PATCH` `DELETE` | `/api/v1/template-groups/{groupId}/templates/{templateId}`                | `templates:read` / `templates:write` |
| `GET`                  | `/api/v1/templates/{templateId}/configuration`                            | `templates:read`                     |
| `POST`                 | `/api/v1/templates/{templateId}/configuration/revisions`                  | `templates:write`                    |
| `POST`                 | `/api/v1/templates/{templateId}/configuration/{configurationId}/activate` | `templates:write`                    |
| `GET` `POST`           | `/api/v1/templates/{templateId}/versions`                                 | `templates:read` / `templates:write` |
| `GET`                  | `/api/v1/templates/{templateId}/versions/{versionId}`                     | `templates:read`                     |
| `POST`                 | `/api/v1/templates/{templateId}/versions/{versionId}/ingest`              | `templates:write`                    |
| `GET`                  | `/api/v1/templates/{templateId}/versions/{versionId}/ingestion`           | `templates:read`                     |
| `GET`                  | `/api/v1/templates/{templateId}/versions/{versionId}/manifest`            | `templates:read`                     |
| `GET`                  | `/api/v1/templates/{templateId}/versions/{versionId}/assets`              | `templates:read`                     |
| `GET`                  | `/api/v1/templates/{templateId}/versions/{versionId}/structure`           | `templates:read`                     |
| `GET`                  | `/api/v1/templates/{templateId}/versions/{versionId}/download`            | `templates:read`                     |

Upload accepts `multipart/form-data` and a remote-URL form, reusing
`readDocumentUpload` from `apps/web/src/lib/document-upload.ts` for the size and
MIME handling that already exists. The MIME allowlist for v1 is exactly the
DOCX type; version numbers are assigned server-side and are strictly increasing;
the same `sha256` uploaded twice returns the existing version rather than
creating a duplicate.

Creating a template also creates a draft default Template Configuration. A DOCX
version cannot enter ingestion until one configuration revision is active. The
upload route stores the immutable source under the template's stable ID-based
namespace, snapshots the active configuration ID/SHA, and compiles a validated
`TemplateIngestionInstructions` envelope. It never dispatches the file to
ordinary document ingestion.

The ingestion worker follows the dedicated spec stages: validate package,
inventory parts, resolve relationships, extract media byte-for-byte, persist
one asset per physical media part and one usage per occurrence, extract stable
structure, commit manifests, then mark the version `ingested`. Only then can the
semantic analysis job be queued.

Template create/update validates a distinctive title and a 200–12,000 character
description, computes the canonical description hash, and enqueues
`document_template_embedding_jobs`. The worker uses the tenant's Template
Catalog embedding profile and only activates a vector when the returned job's
source hash still matches the current row. Title search is available before the
vector is ready; semantic search is not.

The configuration page gains a **Template Catalog Embeddings** card using the
existing provider/model/dimension controls and a sample-vector test, but saving
to `document_template_catalog_settings`. Changing the active profile marks
incompatible template vectors stale and requires an explicit or automatically
confirmed catalog re-embed; it never queues document-chunk re-embedding.

First slice of the test interface: a **Template Engine** panel at `/apitest`
with group create/select, template title/description editor, embedding state,
Template Configuration revisions, template list, upload/ingestion journal,
extracted-image browser, and a structure summary (sections / tables /
placeholders / assets/usages). The production UI begins as a new top-level
`/templates` page, not a tab under `/library`. New scopes are added to the
`ApiKeyScope` union in the page and to `API_KEY_SCOPES`.

**Acceptance:** creating a template without a group or detailed description is
rejected; ingestion without an active configuration or valid typed instruction
envelope is rejected; upload the fixture through `/apitest`, see 51/4/519/147
plus the expected image/usage counts, download the stored source bytes and
confirm the SHA-256 is unchanged; extracted image bytes match the media part;
an exact-title query works immediately, and a semantic query works after a
compatible description vector becomes ready.

### Phase 3 — Analysis job and semantic compilation

**Goal:** a deterministically ingested version compiles to a draft blueprint.

Migration 1's queue and journal (deployed in Phase 2) and the
`template_authoring`, `template_analysis`, and `template_vision` task keys from
migration 3.

**Configuration.** Three new cards in `/configuration`, driven by
`model_task_configs` exactly like `pdf_assembly`:

| Task key             | Stage                                                                                       | Notes                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `template_authoring` | Human intent → proposed title, detailed description, field contract, and authoring guidance | Supports the connected OpenAI OAuth reasoning models after the task/provider allowlist is extended. Structured proposal only. |
| `template_analysis`  | Semantic compilation of structure → blueprint JSON                                          | Provider/model/instructions/reasoning effort. Ships defaulted to the tenant's strongest reasoning model.                      |
| `template_vision`    | Page-image interpretation                                                                   | Registered now, defaults to provider `none`, consumed in Phase 8. Registering it now means Phase 8 adds no migration.         |

Guards in `configuration/page.tsx` that must be updated with intent, not by
pattern-matching. All three keys must be added to `MODEL_TASK_ORDER` and
`taskLabel`, and must be left **out** of `taskSupportsAgentRuntime` and
`taskSupportsRagSearchMode` — the analyzer is a single structured call, not an
agent loop, and giving it tools or a RAG mode would let it search a silo it has
no business reading. `taskSupportsReasoningEffort` should include authoring and
analysis, since both depend on semantic quality.

`ModelTaskConfigSchema` currently rejects `openai_oauth` for every task except
Ask and Extraction. Widen that check deliberately for `template_authoring` and
`template_analysis` (and `template_vision` only when its selected model supports
the required images). This does not change the embedding path: Template Catalog
vectors still use `document_template_catalog_settings`, never the interactive
OAuth credential by assumption.

**Authoring flow.** The `/templates` UI offers upload-first and intent-first
authoring. A structured model call creates a
`document_template_authoring_proposals` row; it never writes an approved
template or raw Word XML directly.

| Method | Route                                                                | Scope             |
| ------ | -------------------------------------------------------------------- | ----------------- |
| `POST` | `/api/v1/template-groups/{groupId}/authoring-proposals`              | `templates:write` |
| `GET`  | `/api/v1/template-groups/{groupId}/authoring-proposals/{proposalId}` | `templates:read`  |
| `POST` | `.../authoring-proposals/{proposalId}/accept`                        | `templates:write` |
| `POST` | `.../authoring-proposals/{proposalId}/reject`                        | `templates:write` |

Accepting copies the validated title and detailed description into a new or
explicitly selected template and queues its catalog embedding. For intent-first
authoring, the resulting template may remain without a version until the author
uploads a matching DOCX. A future deterministic starter-template builder may
materialize a basic DOCX from the proposal, but Phase 3 does not ask a model to
emit Office XML.

**Worker.** `apps/worker/src/index.ts` gains claims for template-description
embedding, template DOCX ingestion, and semantic template analysis in the
existing `main()` loop, checked after `claimNextJob()` returns null so ordinary
document ingestion keeps priority. The claim is the same optimistic pattern
already used:
`select ... where status='queued' order by queued_at limit 1`, then
`update ... where id = ? and status='queued'` so two workers cannot take one
job. `wakeWorker("template-description-embedding")`,
`wakeWorker("template-docx-ingestion")`, and `wakeWorker("template-analysis")`
are fired from their enqueue routes.

Stages, each writing one `document_template_analysis_events` row:

```text
semantic_analysis → merging → validating_blueprint
→ needs_review | approved | failed
```

**The model call.** One tool-enabled run. Before it starts, the worker opens the
DOCX ZIP and preloads the package manifest, relationship graph, every readable
OOXML/XML/text part, parsed content controls, and the asset manifest. Fixed read
tools revisit parts and inspect original assets; fixed write tools capture
structure, content, layout, and asset mappings before atomic finalization. The
job refuses unless package validation is complete and artifact hashes match.
Every model conclusion references worker-issued part, relationship, control, or
asset IDs. The global instruction starts from the Template Ingestion model task
and the active Template Configuration adds template-specific instructions.

**The merge is where safety lives.** `blueprint-merge.ts` rejects, never
repairs: every referenced element ID must exist in `structure_json`; every
prototype row must belong to its stated table; every operation must be legal for
its target's element type; destructive targets must not overlap; field and
collection IDs must be unique; collection relative targets must resolve inside
their prototype. A model result that fails any check fails the job with the
specific violation in the event journal. One malformed-JSON retry is allowed,
using the same task config, before failing.

Review policy is enforced by the validated output and application workflow, not
by a page-render or resolution setting on the Template Ingestion model task.
Any ambiguous destructive operation requires review regardless of model score.

Routes:

| Method | Route                                | Scope             |
| ------ | ------------------------------------ | ----------------- |
| `POST` | `.../versions/{versionId}/analyze`   | `templates:write` |
| `GET`  | `.../versions/{versionId}/analysis`  | `templates:read`  |
| `GET`  | `.../versions/{versionId}/blueprint` | `templates:read`  |

`GET .../analysis` supports `?afterSequence=` and returns the journal, matching
`GET /api/v1/ask-runs/{runId}`.

**Acceptance:** the fixture compiles to a draft blueprint containing at minimum
the scalar report metadata, the Town Manager summary as a `rich_text`
instruction field, the priority-initiative table as a `repeat_row` collection
whose prototype is one row (not five), the initiative detail section as a
`repeat_block`, and the developer/implementation sections flagged for
suppression. Every element ID in the blueprint exists. A blueprint referencing a
fabricated element ID fails the job rather than persisting. With
`template_authoring` configured to an available OpenAI OAuth model, an
intent-first request produces a reviewable structured proposal; accepting it
creates group-owned metadata and queues its description vector without creating
or approving raw DOCX bytes. Attempting analysis before the version reaches
`ingested`, or after a structure/asset-manifest hash mismatch, fails before any
model call.

### Phase 4 — Review and approval

**Goal:** a human turns a draft into an approved contract.

Routes:

| Method  | Route                                  | Scope             |
| ------- | -------------------------------------- | ----------------- |
| `PATCH` | `.../blueprints/{blueprintId}`         | `templates:write` |
| `POST`  | `.../blueprints/{blueprintId}/approve` | `templates:write` |
| `POST`  | `.../blueprints/{blueprintId}/reject`  | `templates:write` |

`PATCH` accepts blueprint metadata edits only — rename a field, change a data
type, move a collection boundary, mark a region static, edit an instruction. It
never accepts element IDs the structure does not contain and it never touches
the DOCX. Approval re-runs the full blueprint validation from analyzer spec
§23, sets `review_status = 'approved'`, records `approved_by` and
`approved_at`, and upserts the template's
`document_template_active_versions` row. An approved blueprint is immutable: a
later edit creates a new blueprint row for the same version.

Approval is deliberately an administrative action. A model may compile a
blueprint; it may not approve its own compilation.

Second slice of the test interface: blueprint viewer (fields, collections,
blocks, assets, warnings, confidence per binding), inline metadata editing, and
approve/reject.

**Acceptance:** a reviewer renames `initiative_1` to `initiative`, marks a
decorative table static, approves, and the template becomes renderable and
eligible for group-scoped admin search. Approving a blueprint whose template
bytes have been replaced fails. Model-facing group resolution remains disabled
until the access and binding work in Phase 6.

### Phase 5 — Renderer and binary generated files

**Goal:** an approved blueprint plus hand-written Agent Data produces a real
DOCX. No agent involvement yet — this is the phase that proves the engine end to
end while still touching nothing in the agent loops.

Migration 4. `packages/docx-engine` gains the renderer modules. The mutation
order is fixed and is the one in render spec §11.2 — resolve and validate every
target first, then expand structures, then remove prototypes, then populate,
then images, then relationships and content types, then final scan. Resolving
last is how targets disappear before they are used.

**Generated-file writing must be unified in this phase.** The current writer is
duplicated between `apps/web/src/lib/generated-files.ts` and
`apps/worker/src/index.ts`; adding a second binary path to both would make it
four. One shared implementation accepting `string | Uint8Array`, with a
format-aware preview — first N characters for text, a generated summary for
DOCX, never a UTF-8 decode of binary bytes.

Route:

| Method | Route                                   | Scope             |
| ------ | --------------------------------------- | ----------------- |
| `POST` | `/api/v1/templates/{templateId}/render` | `templates:write` |

Body carries `templateVersionId`, `blueprintId`, `fileName`, `agentData`, and
`options`. Tenant, silo, and project are runtime-bound from the API key and are
never read from the body. Returns the render spec §10.1 response shape.

Third slice of the test interface: paste or generate Agent Data against the
approved contract, render, download the DOCX, and see the validation report.

**Acceptance:** the full table matrix from render spec §40 — 0, 1, 2, 6, and 50
records against a five-sample-row template; merged cells preserved;
repeat-header preserved; multi-row prototype groups; split-run scalar
replacement; a supported Markdown block; optional block removed when its
collection is empty. Output opens in Word, every relationship resolves, no
`{{...}}` remains, untouched parts are byte-identical to the template.

**Image preservation is a Phase 5 requirement, not a Phase 8 one.** Fixture B
makes it testable now, and it is the default behaviour the whole preserve-first
design rests on: render a full report from fixture B and assert that
`word/media/image1.png` is byte-identical, `word/_rels/header1.xml.rels` is
untouched, and every attribute of the `wp:anchor` in `header1.xml` is unchanged
after 40 initiative rows were added to the body. A renderer that silently drops
a header image while the body renders correctly is the worst failure mode
available, because the DOCX still opens.

`replace_image` — swapping that border for a supplied asset while keeping the
anchor — is unblocked by fixture B and may be pulled into this phase. It is
listed separately in Phase 8 only because it needs no new engine concepts, so it
can slip a phase without blocking anything.

### Phase 6 — Template Group search tools and silo access (implemented selection slice)

**Goal:** an approved template becomes discoverable through the one dynamic tool
defined by its Template Group.

The implemented product contract treats a silo assignment as availability in
both Ask and Extraction. It uses `document_template_group_silo_access`,
`resolve_template_group_tools`, and `search_document_templates`; there is no
second task-binding screen to configure the same assignment twice.

Routes:

| Method      | Route                                                      | Scope             |
| ----------- | ---------------------------------------------------------- | ----------------- |
| `GET`       | `/api/v1/template-groups`                                  | `templates:read`  |
| `GET`       | `/api/v1/template-groups/{templateGroupId}`                | `templates:read`  |
| `PATCH`     | `/api/v1/template-groups/{templateGroupId}`                | `templates:write` |
| `GET` `PUT` | `/api/v1/template-groups/{templateGroupId}/silos`          | `templates:grant` |
| `DELETE`    | `/api/v1/template-groups/{templateGroupId}/silos/{siloId}` | `templates:grant` |

`templates:grant` is excluded from `DEFAULT_API_KEY_SCOPES`, exactly as
`libraries:grant` is, because granting widens what a silo's runs can produce.

UI: `/templates` owns the catalog and editable tool definition.
`/template-silo` presents the groups on the left and one straight silo
checklist on the right. It cannot create groups.

**Current acceptance:** one enabled, assigned, non-empty group resolves to one
dynamic tool in both Ask and Extraction. A named template is queried by title;
a general document purpose uses hybrid title/description-vector search. The
query embedding must match the stored provider/model profile and safely falls
back to title search when embeddings are unavailable. A silo without an
assignment and an empty group resolve no tool. Rendering from the selected
template is implemented through `get_template_contract` and `write_document`.

### Phase 7 — `write_document` in Ask and Extraction

**Goal:** the agent generates the document itself.

**Implemented runtime:** Ask resolves silo Template Group tools before any RAG
search and passes the original request to the model first. An explicit template
request must proceed through group selection, `get_template_contract`, focused
RAG searches derived from the contract, and `write_document`. The runtime
blocks a premature render, refuses a text-only completion after template
selection, stores the exact effective tool instructions in the run trace, and
uses raw-question retrieval only as a no-model/non-template failure fallback.

`MODEL_TOOL_NAMES` gains `write_document` and `get_template_contract`; both
become reserved names for library tools and Template Group tools in the same
migration.

**Tool injection and selection.** When a run has bound Template Groups, the
runtime injects each resolved group as its dynamically named search tool, using
the group's `tool_description`. The model calls the relevant group tool with a
natural-language use-case query and receives a compact ranked catalog result —
template ID, title, bounded description excerpt, active version, and blueprint
ID — not every blueprint. `get_template_contract` fetches the full description
and semantic contract for the selected template on demand. A single template
contract can be large; injecting every bound contract into every Ask would
spend the context window on templates the model will not use.

**Real tool execution.** `write_document` is executed as a genuine tool call,
not as a loop terminator. The runtime parses the call, invokes the render
service, and feeds the `fileId` result back into the loop as a tool result. The
completion invariant: when a run requires document output, the run cannot
succeed without `write_document.success === true`. This is the architectural
mismatch called out in render spec §24 and in
[agent_write_file_tool.md](../api/agent_write_file_tool.md); the document tool
must not inherit it.

`write_file` behaviour is unchanged. Existing Ask and Extraction runs with no
Template Group binding see no difference: no group search tool is offered and
no template code path runs.

Fail early — before any model call — when a document is requested and no
template is selected, the blueprint is unapproved, the task does not allow the
tool, or the scope is missing.

Telemetry: the `generated_document.*` events from render spec §39 as
`ask_run_events` rows, with durations separated for the agent phase, validation,
render, package validation, and persistence.

**Acceptance:** an Ask run chooses the correct group tool, finds the fixture by
title or semantic description within that group, loads its contract, and
produces a DOCX whose row counts match the RAG evidence rather than the
template's sample rows. A text-only answer to a document-required request is
rejected; a retry with the same `runId + toolCallId + templateVersionId`
idempotency key does not produce a second file; a failed upload returns tool
failure rather than silent success.

### Phase 8 — Deferred

Separate specs, separate plans, in rough priority order:

1. **Page rendering and vision** — LibreOffice headless render service, page
   images into `template_vision`, higher confidence on implicit bindings.
2. **Images beyond preservation** — `replace_image` against fixture B's header
   border (may be pulled into Phase 5), then inline images, images in table
   cells, and one image referenced from two parts, each needing a fixture that
   does not exist yet (§11.3). `insert_image` into an empty marker is a
   distinct, harder operation and is not v1.
3. **Charts** — server-rendered PNG into a chart slot; no embedded workbook.
4. **PDF and visual QA** — DOCX → PDF, page images, vision QA for unresolved
   placeholders and layout damage. A PDF failure must not invalidate a valid
   DOCX.
5. **Advanced Word features** — content controls, VML, text boxes,
   footnotes/endnotes, tracked-changes policy, custom XML parts.
6. **Portable template-catalog export** — Template Groups, template metadata,
   versions, blueprints, and assets in a distinct package. Description vectors,
   silo grants, and bindings are excluded and rebuilt/reassigned at the
   destination. Do not overload the reference-library package described in
   [library-portability.md](../requirements/library-portability.md).

---

## 6. What the model is and is not allowed to do

Worth stating in one place, because it is the invariant every phase protects.

| Actor                                    | Owns                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `package-reader` / `structure-extractor` | What physically exists and where                                             |
| `template_authoring` model               | Proposed title, detailed description, field contract, and authoring guidance |
| `template_analysis` model                | What regions mean and what belongs in them                                   |
| Template Catalog embedding runtime       | Compatible query and detailed-description vectors for group-scoped selection |
| `blueprint-merge` + reviewer             | Whether that interpretation is accepted                                      |
| Ask / Extraction model                   | The factual content, sourced through existing RAG                            |
| Renderer                                 | Every byte written into the Word package                                     |

The analyzer model never emits Word XML, never invents an element ID, and never
approves its own output. The agent model never sees a part path, a relationship
ID, or a run boundary. The renderer never decides what a region means.

---

## 7. Security

Inherited from existing patterns, restated because templates are a new class of
untrusted upload:

- tenant, silo, and project are runtime-bound from the API key on every route
  and every tool call; the model supplies none of them;
- template and blueprint IDs are authorization-checked against the calling key's
  tenant and Template Group access before any bytes are read;
- uploads are treated as hostile: size, decompressed size, entry count,
  ZIP-slip, XML size, and external-entity limits are enforced in
  `package-reader` before parsing (§5, Phase 1);
- the worker accepts only a schema-validated `TemplateIngestionInstructions`
  envelope whose tenant/template/version/source/configuration identities match
  persisted state;
- Template Configuration may narrow analysis behavior but cannot disable source
  preservation, macro/encryption rejection, external-fetch refusal, or
  byte-preserving media extraction;
- macros are neither executed nor supported; `.docm` is rejected in v1;
- external relationships are inventoried and never fetched;
- blueprints carry no executable expressions — optional-block conditions are a
  fixed vocabulary evaluated by the renderer;
- both buckets stay private and `service_role`-only;
- every template version and every generated document is auditable to a run.

---

## 8. Idempotency and failure

Rendering uses a runtime-generated key of `runId + toolCallId +
templateVersionId`. A repeated call for a completed render returns the existing
generated file rather than producing a second one.

If the database write fails after the storage upload, the uploaded object is
deleted — the cleanup semantics the existing generated-file writer already uses.

Analysis jobs retry to `max_attempts`. A failed job leaves the version in
`failed` with the failing stage and the specific validation violation in the
journal; it never leaves a partial blueprint approved.

DOCX ingestion uses `templateVersionId + sourceSha256 +
configurationSha256` as its logical idempotency identity. Derived objects are
written through a job-specific staging prefix or content-addressed final paths;
the version is not marked `ingested` until every required manifest, structure,
asset, usage row, and final object is readable and hash-verified.

---

## 9. Error vocabulary

The codes in render spec §29 are adopted as-is and returned as
`{ code, message, stage, recoverable, fieldId?, collectionId?, elementId?,
requestId }`. Storage paths, credentials, and raw source text never appear in a
message returned to a model.

Analyzer-side additions: `template_package_invalid`,
`template_package_encrypted`, `template_format_unsupported`,
`template_configuration_missing`, `template_configuration_mismatch`,
`template_ingestion_instructions_invalid`, `template_package_manifest_failed`,
`template_asset_extraction_failed`, `template_asset_storage_failed`,
`template_structure_extraction_failed`, `template_ingestion_manifest_mismatch`,
`template_not_ingested`, `blueprint_model_output_invalid`,
`blueprint_target_not_found`, `blueprint_validation_failed`, and
`template_version_immutable`.

---

## 10. How each phase is verified

Every phase ends with something a person can run. The important asymmetry: the
`docx-engine` phases need no infrastructure at all, while every database phase
needs a deployed stack **and its own Supabase** (§10.3).

### 10.1 Test gate per phase

| Phase                     | What proves it                                                                                                                                                           | Infrastructure needed                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| 1 — DOCX splitter         | `pnpm --filter @bubble-rag/docx-engine test`: package/asset manifests, usage graph, structure counts, split-run placeholders, byte-identical round trip, all fixtures    | none — pure functions over fixture bytes     |
| 2 — storage and ingestion | `/apitest` Template Engine panel: configuration snapshot, source upload, ingestion journal, extracted images/usages, manifests, structure, download, and SHA-256 match   | web + worker + Supabase + migrations 1 and 3 |
| 3 — semantic analysis     | `/apitest`: prove the ingestion gate, run analyze, watch the separate analysis journal, and read the draft blueprint. Worker unit tests cover both claim types           | + a configured `template_analysis` model     |
| 4 — review                | `/apitest`: edit blueprint metadata, approve it, and confirm the template becomes renderable and eligible for admin search                                               | same as 3                                    |
| 5 — renderer              | `docx-engine` unit tests for the whole table matrix and image preservation, then `/apitest` render with pasted Agent Data, opened in Word                                | unit: none. End-to-end: web + Supabase       |
| 6 — group search tools    | `/apitest` + `/templates`: preview title/vector/hybrid search, grant, bind, and confirm `resolve_template_group_tools` returns exactly one correctly scoped dynamic tool | web + Supabase                               |
| 7 — `write_document`      | An Ask run calls the bound group tool, selects a template, and produces a DOCX whose row counts follow the evidence, not the template                                    | full stack                                   |

### 10.2 The three harnesses that already exist

- **`pnpm test`** — vitest per package. Phases 1 and 5 live here almost
  entirely, which is why they are the cheapest phases to get right and the ones
  worth over-testing. The byte-identical round-trip assertion is the single
  highest-value regression test in the plan: it catches an XML builder that
  quietly reorders attributes, which is the failure mode that would otherwise
  surface as a corrupt document months later.
- **`/apitest` + `/api/apitest/v1/[...path]`** — the portal proxies to the real
  `/api/v1` surface with a real API key, so anything tested there is tested
  through the same authorization and scope path Bubble will use. This is why
  each phase ships its UI slice rather than deferring the interface to the end.
- **`scripts/bubble-api-smoke.mjs`** — 1,143 lines of end-to-end assertions
  against a live deployment, run by `pnpm test:bubble-api`. **Extend this file
  once per phase.** By Phase 7 it should walk group → create template → activate
  configuration → upload → ingest/split DOCX → generate and embed description →
  inspect assets → analyze → approve → grant → bind → search → render →
  download and clean up after itself, which
  turns "can we test as we go" into one command.

### 10.3 The constraint that decides how phases are tested

Four of the seven phases carry a migration. Per
[production-and-staging-tracks.md](../setup/production-and-staging-tracks.md),
a staging deploy against a **shared** Supabase project takes production down on
the first migration: the maintenance service applies the new head, production's
web and worker still carry the older `RAG_RAILWAY_EXPECTED_MIGRATION_HEAD`,
they detect `database_ahead`, and they fail closed by design.

So phase-by-phase testing against a live stack requires a staging Railway
project with **its own Supabase project**. Standing that up is a prerequisite of
Phase 2, not an optional nicety — without it, the only safe cadence is to test
Phases 1 and 5 locally and batch every database phase into a single production
deploy, which defeats the point of phasing.

### 10.4 Local-first order

Where a choice exists, build the deterministic part first and the persisted part
second. Phase 1 and Phase 5 together are the entire document engine, and both
can be finished, tested, and reviewed on a laptop against the two fixtures
before a single migration is written. That ordering also means a schema mistake
in Phase 2 costs a migration, not a rewrite of the renderer.

---

## 11. Reference fixtures

Three fixtures, all in `docs/Templates/`. Fixture A is the semantics case,
fixture B (`sample.docx`) is the working image case and the one to develop
against, and fixture C is B before repair — kept as the broken-relationship
negative case.

### 11.1 Fixture A — `Fincentiv_Town_Manager_Report_Template_v1.docx`

72,181 bytes. Verified by direct package inspection:

- 51 tables, 152 table rows;
- 4 sections, mixed portrait and landscape;
- 4 header parts and 4 footer parts;
- 519 `{{...}}` occurrences, 147 distinct strings;
- **no** `word/media/*` — no embedded images at all;
- **no** `w:sdt` — no content controls;
- one `customXml` part, which the round-trip test must preserve untouched.

These match the analyzer spec §25 claims exactly.

It exercises explicit placeholders, instruction-style placeholders such as
`{{2–4 sentence executive narrative: ...}}`, numbered sample placeholders
(`{{initiative_1}}`), repeating table rows, repeating blocks, multi-section
layout, and header/footer bindings.

### 11.2 Fixture B — `sample.docx`

434,742 bytes. Identical body to fixture A — same 51 tables, 152 rows, 4
sections, 519/147 placeholders, no `w:sdt` — plus a full-height left-border
image on every page of all four sections.

It was repaired from `..._v1_left-border-single-image.docx`, in which only
`header1.xml` carried a working image: headers 2–4 held a `pic:pic` whose
`a:blip` had no `r:embed`, in parts with no `.rels`, so the border rendered on
section 1 only. The repair added the three missing relationship parts, pointed
every blip at the one media part, and normalized all four anchors:

| Section | Orientation | Header        | Strip                  | Page height              |
| ------- | ----------- | ------------- | ---------------------- | ------------------------ |
| 1       | portrait    | `header1.xml` | 581,025 EMU (0.635 in) | 10,058,400 EMU (11.0 in) |
| 2       | landscape   | `header2.xml` | 446,700 EMU (0.489 in) | 7,772,400 EMU (8.5 in)   |
| 3       | portrait    | `header3.xml` | 581,025 EMU (0.635 in) | 10,058,400 EMU (11.0 in) |
| 4       | landscape   | `header4.xml` | 446,700 EMU (0.489 in) | 7,772,400 EMU (8.5 in)   |

All four anchors are `behindDoc="1"`, `wrapNone`, `positionH`/`positionV`
`relativeFrom="page"` at offset 0 — flush to the paper's top-left corner. This
is exactly the case overview §6 describes, and preserving these anchors
unchanged while the body is rewritten is the whole point of the preserve-first
rule.

**The strip width is the section's left-margin width, not the source aspect
ratio.** The PNG is 205 × 2172 (aspect 0.0944); a strip that wide would run
under the text column. Portrait margins are 936 twips and landscape 720, so the
strips are sized to 97.7% of each, and `<a:stretch><a:fillRect/>` handles the
distortion. Verified by rendering all 15 pages: the strip ends at 0.489 in on
landscape and the table column begins at 0.500 in — flush neighbours, no
overlap. A renderer that "corrects" this to the source aspect ratio has broken
the document.

The original unrepaired file is kept alongside it as the negative fixture — see
§13.7.

### 11.3 What the pair proves, and what it still cannot

Together they cover: floating/anchored images, images in headers, image-bearing
sections in both orientations, a resolvable relationship graph across four
header parts, one media part shared by four header parts, a dangling picture
reference (fixture C), and a 364 KB binary part that must survive a rewrite
byte-for-byte.

Still uncovered, and still needing a fixture before the relevant work:
**inline** images, an image inside a table cell, the same image referenced from
two parts, `w:sdt` content controls, native charts, and the visually-implied
bindings that motivate the vision phase.

Neither fixture is the schema. Nothing named in either may be hard-coded
anywhere in the engine.

---

## 12. Repository gates

Three CI checks will fail a phase that forgets its bookkeeping. Listed because
each has failed a previous change in this repo.

### 12.1 Migration bookkeeping

Every migration requires, in the same commit:

1. `pnpm platform:checksums` — regenerates `platform/migration-checksums.v1.json`;
2. `expectedMigrationHead` in `platform/supabase-resources.v1.json` updated to
   the new head filename, and the new tables, functions, and buckets added to
   its resource lists;
3. `EXPECTED_MIGRATION_HEAD` in `platform/environment-variables.v1.json`
   updated — `verify-platform-contract.mjs` compares all three and this is the
   copy that has drifted before.

### 12.2 API documentation

`scripts/verify-api-docs.mjs` requires every exported HTTP method on every
`/api/v1` route to appear in `docs/api-usage.md` **twice**: once as a
`### \`METHOD /api/v1/...\``heading and once as a summary-table row. The
plan adds roughly 30 method/route pairs, so this is around 60 documentation
entries, plus the mirrored entries in`docs/api/rest-api-command-reference.md`.

### 12.3 Build and test

`pnpm test` builds `rag-core` first, so a schema added there must compile before
anything importing it will. `pnpm typecheck` and `pnpm lint` run per package.
`pnpm-workspace.yaml` already globs `packages/*`, so `packages/docx-engine` is
picked up automatically — but it needs its own `build`, `lint`, `test`, and
`typecheck` scripts, or `pnpm -r` will skip it silently and the round-trip tests
will never run in CI.

---

## 13. Open questions

1. **ZIP and XML library choice.** Round-trip preservation is the hard
   requirement (§4). A short spike comparing two candidate XML builders on both
   fixtures, asserting byte-identical output, should precede Phase 1 rather than
   being discovered inside it. Fixture B is the sharper test of the two: a
   364 KB binary part and four header parts with mixed relationship states.
2. **Template deletion (resolved).** Deletion soft-deletes the catalog entry,
   disables model discovery, cancels active ingestion/embedding jobs, removes
   its description vector, and frees the original slug for a replacement.
   Immutable versions and blueprints remain private because generated files
   retain template provenance for reproducibility.
3. **Tool rename aliases.** Generated files snapshot the tool name used for
   historical selection. Decide whether renaming a group's `tool_name` should
   also retain a temporary callable alias for in-flight/replayed runs, or whether
   retries must always resolve the current name from the stored group ID.
4. **Instruction-text suppression.** The fixture's developer/implementation
   sections should not reach a Council-facing document. Is suppression a
   blueprint policy per template, a render option per call, or both?
5. **`generated_files` size limit.** Already 50 MB, so no change is planned.
   Fixture B is 435 KB before any content is added; confirm 50 MB is enough for
   image-bearing reports before Phase 8 item 2.
6. **Reserved tool names.** Adding `write_document` and `get_template_contract`
   to the reserved list will reject an existing library tool or future Template
   Group tool that uses either name. Verify no existing library tool conflicts
   before migration 4, and reject conflicts when groups are created.
7. **Fixture C — `..._v1_left-border-single-image.docx`.** The unrepaired
   original of fixture B, kept deliberately: headers 2–4 carry a picture with no
   image reference and no `.rels` part, which is the "missing relationship
   handled as validation error" case from analyzer spec §24.5 and is awkward to
   construct on purpose. The engine decision it forces: a template carrying a
   dangling picture should compile to a blueprint **with a warning**, not fail
   analysis. A broken image in a source template is the author's problem to see,
   not a reason to refuse the other 147 bindings. Confirm that reading before
   Phase 3, and delete the file only if the negative case is covered another
   way.
8. **Staging Supabase.** §10.3 makes a separate staging Supabase project a
   prerequisite of Phase 2. Confirm that exists, or accept that database phases
   are tested in batch against production.
