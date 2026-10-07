# Template DOCX Ingestion And Storage

**Status:** Storage, version, configuration, job-envelope, asset-table, UI, and
the fixed expanded-DOCX model/tool contract implemented on 2026-08-16;
package extraction and model execution remain planned.
**Purpose:** Define the dedicated storage namespace, versioned Template
Configuration, extracted-image model, and deterministic ingestion instructions
used to split a DOCX template into safe, reusable components.

This specification sits between the Template Catalog and the Template
Analyzer. It defines how uploaded bytes become the structure, assets, and
configuration inputs consumed by semantic blueprint analysis.

---

## 1. Decision Summary

Every template receives its own stable storage namespace. Every immutable DOCX
version is ingested into a version subspace containing:

- the untouched source DOCX;
- the exact Template Configuration snapshot used for ingestion;
- a package and relationship manifest;
- normalized structural data;
- extracted image/media copies;
- an asset-usage graph describing where each image appears;
- later blueprint and preview artifacts.

The ordinary document-ingestion pipeline must not infer how to handle a template.
The caller supplies a typed `TemplateIngestionInstructions` envelope that says
the resource is a DOCX template and identifies the authorized template,
version, and configuration. Safety-critical extraction behavior is fixed by the
application rather than written as a free-form model prompt.

The boundary is:

```text
Uploaded DOCX
  → dedicated Template ingestion instructions
  → safe package validation
  → immutable source persistence
  → package/relationship inventory
  → image and media extraction
  → physical structure extraction
  → persisted ingestion manifest
  → semantic Template Analyzer
  → reviewed Blueprint
```

Template ingestion does not create canonical Markdown, RAG chunks, or document
embeddings.

---

## 2. Why A Dedicated Template Ingestion Path Is Required

An ordinary source document is ingested so its content can be retrieved as
evidence. A template is ingested so its physical layout and mutation points can
be reused safely.

| Concern          | Document ingestion              | Template DOCX ingestion                            |
| ---------------- | ------------------------------- | -------------------------------------------------- |
| Primary output   | Canonical Markdown and chunks   | Package structure, assets, and blueprint inputs    |
| Original layout  | Useful context                  | Immutable source of truth                          |
| Images           | Described for retrieval         | Extracted, stored, and mapped back to exact usages |
| Relationships    | Usually hidden after conversion | Required for safe later mutation                   |
| Unknown Open XML | May not affect extracted text   | Must remain preserved in source package            |
| Model role       | Optional content understanding  | Semantic interpretation after deterministic split  |
| Vector output    | Chunk embeddings                | None; catalog-description embedding is separate    |

Sending templates through the document path would discard precisely the data
the renderer later needs: relationship IDs, drawing anchors, section parts,
table prototypes, and exact package locations.

The model does not receive an opaque DOCX upload and it does not receive a
series of rendered-page batches. The ingestion worker opens the DOCX as an
OOXML ZIP package, validates it, inventories every part and relationship, and
supplies the complete logical package to one selected model. Readable package
parts are preloaded; original image and media bytes remain worker-bound and are
available through dedicated asset tools.

---

## 3. One Stable Storage Space Per Template

The private `document-templates` bucket uses identifiers, never mutable group
names, titles, or slugs, in object paths.

```text
templates/{tenantId}/{templateId}/
  configuration/
    revisions/{configurationId}.json
  versions/{versionId}/
    source/template.docx
    manifests/package-manifest.json
    manifests/asset-manifest.json
    structure/document-structure.json
    assets/{assetId}/{safeOriginalFileName}
    blueprints/{blueprintId}.json
```

Rules:

- `tenantId`, `templateId`, `versionId`, `configurationId`, `assetId`, and
  `blueprintId` are server-generated and authorization-checked.
- Moving a template to another Template Group does not move storage objects.
- Renaming a template does not change a storage path.
- `source/template.docx` is immutable after its SHA-256 is recorded.
- Extracted artifacts are derived from one source version and never shared
  implicitly between versions.
- Object paths are stored in database rows; models never construct them.
- The bucket remains private and service-role-only. Downloads use authorized,
  short-lived URLs.

The database remains the authoritative index. JSON copies in storage are
versioned audit/recovery artifacts and inputs for isolated workers; they do not
replace relational authorization checks.

---

## 4. Versioned Template Configuration

Every template has an explicit Template Configuration. It is separate from the
compiled Blueprint:

- the **Template Configuration** tells ingestion and analysis how this template
  is to be prepared;
- the **physical structure** records what the uploaded DOCX actually contains;
- the **Blueprint** records the reviewed semantic meaning and permitted render
  operations.

### 4.1 Configuration Table

```sql
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
```

Tenant-consistency constraints/triggers enforce that the configuration and its
template share a tenant. Activating a revision supersedes the previous active
row in one transaction. Creating a template creates an initial draft revision;
DOCX ingestion remains unavailable until a revision is active.

`document_template_versions` records the exact configuration snapshot used:

```sql
alter table document_template_versions
  add column configuration_id uuid
    references document_template_configurations(id) on delete restrict,
  add column configuration_sha256 text,
  add column ingestion_manifest_json jsonb,
  add column ingestion_manifest_sha256 text,
  add column package_manifest_sha256 text,
  add column asset_manifest_sha256 text,
  add column structure_sha256 text;
```

A configuration change does not mutate an existing version's recorded
configuration. Reanalysis with a new configuration creates a new analysis job
and blueprint candidate while retaining the historical snapshot.

### 4.2 Configuration Shape

Conceptual v1 configuration:

```json
{
  "schemaVersion": "1.0",
  "sourceFormat": "docx",
  "ingestion": {
    "preserveSourcePackage": true,
    "inventoryAllPackageParts": true,
    "resolveInternalRelationships": true,
    "externalRelationships": "inventory_only",
    "extractImages": true,
    "extractOrphanedMedia": true,
    "storeOriginalMediaBytes": true,
    "transcodeImages": false,
    "extractHeadersAndFooters": true,
    "extractFootnotesAndEndnotes": true,
    "extractComments": true,
    "extractContentControls": true,
    "unknownParts": "preserve_in_source"
  },
  "analysis": {
    "instructions": "Identify static design, dynamic fields, repeating structures, and replaceable image slots conservatively.",
    "inputMode": "expanded_docx_package",
    "toolContract": "template_ingestion_v1"
  },
  "rendering": {
    "staticAssetPolicy": "preserve",
    "unresolvedRequiredBindingPolicy": "fail",
    "unresolvedOptionalBindingPolicy": "warn"
  }
}
```

Safety invariants cannot be relaxed in saved JSON. V1 always:

- preserves the original package;
- rejects macros and encrypted packages;
- refuses external fetches;
- retains unknown parts in the source DOCX;
- stores extracted media without destructive transcoding;
- prevents models from choosing storage paths or package-write operations.

Configuration can add narrower instructions, but it cannot override these
application-level rules.

### 4.3 Global Template Ingestion Model Task

The Configuration page exposes **Template Ingestion** as a separate model task.
The task stores the provider, model, reasoning effort, and global instructions
using the same settings-service boundary as Ask and Extraction. The execution
contract is provider-neutral: Ollama, OpenAI API, OpenAI OAuth, Modular,
Together AI, OpenRouter, and Mistral use the same package preload and tool
schemas. A selected model is expected to support tool calling and, when it
inspects extracted images, image input. Provider capability errors are reported
on the ingestion job instead of being hidden behind an OpenAI-only allowlist.

There are no pages-per-call, render-resolution, or image-detail controls for
this task. The input and tool contract are application-owned and fixed:

| Initial model context | Contents                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| Package manifest      | Every ZIP part, content type, byte size, checksum, and package path                   |
| Relationship graph    | Resolved internal relationships and inventoried external relationships                |
| Readable parts        | All OOXML, XML, relationship, property, and text parts opened by the worker           |
| Content controls      | Structured document tags, bindings, fields, and source references                     |
| Asset manifest        | Every image/media item with stable asset ID, metadata, checksum, and usage references |

Binary image and media bytes are not expanded into prompt text. The
`get_template_asset` tool gives a capable multimodal model the selected original
asset while keeping storage paths and authorization worker-bound.

The model receives these dedicated tools:

| Access | Tools                                                | Purpose                                                                |
| ------ | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Read   | `list_docx_parts`, `read_docx_part`                  | Revisit exact package inventory and readable parts by worker-issued ID |
| Read   | `list_template_assets`, `get_template_asset`         | List and inspect original images/media by worker-issued asset ID       |
| Write  | `write_template_structure`, `write_template_content` | Store structural and content artifacts with source references          |
| Write  | `write_template_layout`, `write_template_asset_map`  | Store layout rules and asset roles/usages with source references       |
| Write  | `finalize_template_ingestion`                        | Validate and atomically commit the four output categories              |

The read tools cannot escape the bound template version. The write tools cannot
edit source OOXML or choose storage paths. The worker validates every argument,
requires source references, and only finalizes after all required output
categories pass schema validation.

`finalize_template_ingestion` also requires a detailed 200–12,000 character
catalog description derived from the supplied DOCX package. Upload does not ask
the user for this text and does not queue a description embedding. After
successful finalization, the worker stores the generated description and its
checksum, queues its vector, and exposes the text for authorized editing.

Task instructions are the system-wide baseline. The active Template
Configuration's per-template analysis instructions are appended for that
specific ingestion run. Neither instruction layer can relax the deterministic
package safety invariants above. A worker snapshots both the model task and the
active Template Configuration before starting so later settings changes cannot
alter an in-flight job.

### 4.4 Editable inspection artifact

Every immutable template version has an editable inspection-artifact name and
description. These fields describe the downloadable diagnostic package; they
do not rename or mutate the source DOCX and do not affect the source checksum.

Once deterministic package extraction has produced data, the portal can export
an inspection ZIP even when later model analysis fails. A completed or
needs-review run adds its full model outputs. The ZIP contains:

- the immutable source DOCX and source/checksum metadata;
- the saved configuration snapshot;
- the package manifest, relationship graph, readable parts, content controls,
  physical structure, and asset manifest;
- every extracted original image/media file plus database usage records;
- model-authored structure, content, layout, asset map, final summary,
  warnings, unresolved items, and tool-call journal;
- durable ingestion jobs and stage events.

This export is assembled on demand from authorized private storage and database
records. The editable artifact name becomes the ZIP filename, and its editable
description is written into `README.md` and `inspection.json`.

---

## 5. Typed Template Ingestion Instructions

The upload/API layer compiles the active configuration and runtime identity into
one worker envelope:

```ts
type TemplateIngestionInstructions = {
  protocolVersion: "1.0";
  resourceKind: "document_template";
  sourceFormat: "docx";
  tenantId: string;
  templateGroupId: string;
  templateId: string;
  templateVersionId: string;
  configurationId: string;
  configurationSha256: string;
  source: {
    bucket: "document-templates";
    storagePath: string;
    sha256: string;
    byteSize: number;
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  };
  operations: {
    validatePackage: true;
    inventoryParts: true;
    resolveRelationships: true;
    extractAssets: true;
    openReadableParts: true;
    exposeAssetsThroughTools: true;
    analyzeWithConfiguredModel: true;
    extractStructure: true;
  };
};
```

The worker validates this envelope against a shared schema before reading the
source object. It rejects a job when:

- `resourceKind` or `sourceFormat` is wrong;
- the version does not belong to the template;
- the template does not belong to the supplied group and tenant;
- the source bucket/path differs from the stored version row;
- any SHA, MIME, size, or configuration snapshot differs from persisted state;
- a requested operation is not part of the supported protocol version.

The worker does not guess whether an upload is a template based on its filename
or contents. The authorized route creates this instruction envelope explicitly.

---

## 6. DOCX Split Pipeline

The template ingestion job runs these deterministic stages in order.

### 6.1 Authorize And Snapshot

1. Resolve tenant, Template Group, template, version, and active configuration.
2. Confirm the job's source and configuration hashes.
3. Persist the configuration JSON snapshot under the template namespace.
4. Record the job attempt and idempotency key.

### 6.2 Validate The Package

1. Confirm DOCX extension, MIME, and ZIP signature.
2. Reject encrypted Office packages and `.docm` macro-enabled input.
3. Enforce compressed bytes, decompressed bytes, entry count, per-entry size,
   path-depth, XML-size, and processing-time limits.
4. Reject ZIP-slip paths, duplicate canonical entry names, external entities,
   and unsafe XML constructs.
5. Record external relationships but never fetch them.

No derived object is made visible as complete until package validation passes.

### 6.3 Inventory Package Parts

Enumerate every ZIP entry and record:

- normalized part path;
- content type;
- byte size and SHA-256;
- whether it is XML, relationship data, media, or an unknown part;
- inbound and outbound relationships;
- whether it is supported for structural parsing;
- warnings for missing or dangling relationships.

This becomes `package-manifest.json` and the package inventory inside
`ingestion_manifest_json`.

### 6.4 Extract Images And Media

For every media part, including unreferenced `word/media/*` entries:

1. read the original bytes without transcoding;
2. identify MIME and safe extension from content type plus signature;
3. compute SHA-256;
4. create one `document_template_assets` row for the physical media part;
5. write one object under `assets/{assetId}/...`;
6. map every relationship/drawing occurrence to that asset;
7. record orphaned or dangling media as warnings rather than silently dropping
   it.

If one image is used in four headers, the bytes are stored once for that
template version and four usage rows are created. Static images remain in the
source DOCX; extraction creates analysis and audit copies rather than removing
them from the package.

### 6.5 Extract Physical Structure

Parse the main document and supported related parts to produce stable element
addresses for:

- sections and page settings;
- body paragraphs and logical text across runs;
- tables, rows, cells, grids, and merges;
- headers and footers;
- footnotes, endnotes, comments, and content controls when present;
- drawings, anchors, inline objects, and text boxes when supported;
- bookmarks, fields, hyperlinks, and relationship references;
- placeholder and instruction hints.

Persist the compact structure in the database and archive the exact serialized
form as `structure/document-structure.json`.

### 6.6 Commit The Ingestion Manifest

After every required asset and structural artifact succeeds:

1. validate object hashes against database rows;
2. persist the package and asset manifests;
3. set the version's ingestion status to `ingested`;
4. emit a terminal ingestion event;
5. enqueue semantic analysis when instructed.

The semantic model receives the complete logical package contract: the package
manifest, relationship graph, every readable package part, parsed content
controls, asset manifest, configuration analysis instructions, and the fixed
read/write tools. It never receives authority to edit the source package.

---

## 7. Image And Asset Data Model

The physical asset and each place it is used are separate records.

### 7.1 Stored Asset

```sql
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
```

### 7.2 Asset Usage

```sql
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

`asset_id` is nullable for a dangling image reference whose relationship or
media part is missing. Retaining that usage row lets analysis warn about the
broken slot while continuing to process the rest of the template.

Tenant/version consistency enforcement also requires every usage and referenced
asset to belong to the same template version. RLS and service-role policies
follow the rest of the Template subsystem.

---

## 8. Database And Object Atomicity

Supabase database transactions cannot atomically commit object storage writes.
Template ingestion therefore uses a staged prefix:

```text
templates/{tenantId}/{templateId}/versions/{versionId}/.staging/{jobId}/...
```

Recommended completion behavior:

1. write derived artifacts to the exact job staging prefix;
2. validate every object and hash;
3. insert/update asset, usage, structure, and manifest rows transactionally;
4. promote/copy objects to their final paths;
5. mark the job and version complete only after final objects are readable;
6. clean the staging prefix asynchronously after success;
7. clean or quarantine it after terminal failure.

An alternative implementation may write directly to final content-addressed
paths when every operation is idempotent. It must still avoid a completed
version pointing at missing objects.

Retries use `templateVersionId + sourceSha256 + configurationSha256` as the
logical idempotency identity. A retry may rebuild missing derived artifacts but
never replace source bytes or silently switch configurations.

After a completed or needs-review run, Redo creates a new durable ingestion job
against the same immutable DOCX version. It uses the Template Ingestion model
selection and global instructions current when the worker starts the new job.
A successful redo replaces the version's model-authored artifacts and generated
description, then queues a replacement vector; prior ingestion job and event
history remains available for diagnosis.

---

## 9. State Machine And Events

Recommended ingestion states:

```text
uploaded
  → validating_package
  → inventorying_parts
  → resolving_relationships
  → extracting_assets
  → extracting_structure
  → persisting_manifest
  → ingested | failed

ingested
  → queue separate semantic-analysis job
  → semantic_analysis
  → needs_review | approved | failed
```

Ingestion and semantic analysis use separate jobs and journals. Each transition
writes a durable event with counts and warnings, including:

- package parts inventoried;
- relationships resolved/external/dangling;
- assets extracted;
- asset usages recorded;
- paragraphs, tables, headers, footers, and drawings found;
- bytes written;
- configuration ID and SHA;
- source version and SHA;
- failure code and safe message.

Raw file contents, signed URLs, credentials, and model secrets are never stored
in event details.

---

## 10. Failure And Reprocessing Rules

- A corrupt package fails before semantic analysis.
- A missing image relationship creates a warning and nullable usage record when
  the remaining package can still be parsed safely.
- A failed asset upload prevents `ingested` status.
- A failed semantic model call does not invalidate successfully ingested source,
  structure, or assets.
- Re-running deterministic ingestion against the same source/configuration may
  repair derived artifacts without creating a new DOCX version.
- Using a different configuration creates a new analysis attempt and immutable
  configuration snapshot; it never edits the historical snapshot.
- Uploading different DOCX bytes always creates a new template version.
- Deleting a soft-deleted template is prohibited while generated-document
  provenance still references its versions.

---

## 11. API And Worker Boundary

Recommended API routes:

```text
GET    /api/v1/templates/{templateId}/configuration
POST   /api/v1/templates/{templateId}/configuration/revisions
POST   /api/v1/templates/{templateId}/configuration/{configurationId}/activate

POST   /api/v1/templates/{templateId}/versions
POST   /api/v1/templates/{templateId}/versions/{versionId}/ingest
GET    /api/v1/templates/{templateId}/versions/{versionId}/ingestion
GET    /api/v1/templates/{templateId}/versions/{versionId}/manifest
GET    /api/v1/templates/{templateId}/versions/{versionId}/assets
GET    /api/v1/templates/{templateId}/versions/{versionId}/assets/{assetId}
```

The upload route stores and hashes the source version. The explicit `ingest`
operation queues the typed instruction envelope. Upload may call it
automatically, but the queue boundary remains observable and retryable.

The worker owns package parsing and derived objects. The web process owns
authorization, configuration activation, source upload, and job creation. The
semantic analyzer consumes completed ingestion outputs and cannot bypass the
ingested-state gate.

---

## 12. Acceptance Criteria

### Storage Space

- A created template has a stable ID-based namespace independent of title and
  Template Group changes.
- Every version stores an immutable source DOCX and exact configuration hash.
- Manifests, structure, assets, blueprints, and previews land in predictable
  version subpaths.

### Instructions And Dispatch

- The worker refuses a DOCX job without a valid
  `TemplateIngestionInstructions` envelope.
- A template upload cannot enter document chunking or RAG embedding.
- A mismatched tenant, group, template, version, source SHA, configuration ID,
  or configuration SHA fails before package parsing.
- Safety invariants cannot be disabled through configuration JSON.

### Image Extraction

- Every supported media part is copied byte-for-byte to private template asset
  storage.
- One image referenced from several locations produces one asset and several
  usage rows.
- Headers and footers are included in relationship and usage mapping.
- Orphaned media is inventoried and stored.
- Dangling image references are retained as warnings/usages with no fabricated
  asset.
- Static images remain present and byte-identical in the original source DOCX.

### Structure And Analysis Handoff

- Stable element IDs cover supported body, table, header/footer, and drawing
  structures.
- The persisted structure and asset manifest hashes match the objects read by
  semantic analysis.
- Semantic analysis cannot start before deterministic ingestion reaches
  `ingested`.
- Reprocessing the same source/configuration is idempotent.

---

## 13. Final Boundary

The template's private storage space is a durable decomposition of one immutable
DOCX version, not a replacement for the DOCX.

```text
Template Configuration tells ingestion what to extract
DOCX source preserves every original package byte
Package manifest records what physically exists
Asset rows store each extracted image/media object
Asset usages record every place those bytes are referenced
Structure JSON supplies stable addresses
Blueprint supplies reviewed semantic meaning
Renderer mutates only an authorized working copy
```

The ingestion module owns safe decomposition. The analyzer model owns semantic
proposals. The reviewer owns approval. The renderer owns deterministic output.
None of those responsibilities are interchangeable.
