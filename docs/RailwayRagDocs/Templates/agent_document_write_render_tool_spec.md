# Agent Document Write & DOCX Render Tool

**Status:** Implemented v1 for placeholder-driven DOCX templates; advanced
blueprint and image-slot operations remain specified future work
**Purpose:** Define the agentic document-generation runtime that combines an approved Word Template Blueprint, source information obtained through the existing RAG/tooling system, structured Agent Data, and a deterministic DOCX renderer to produce and persist a final Word document.

How the runtime discovers that template through a Template Group tool is defined
in [Template Catalog And Template Group Tools](template_catalog_and_group_tool_spec.md).

---

## 1. Executive summary

The existing agent system already performs research/extraction and successfully produces Markdown output. The next step is to add a **real document-writing tool** that allows the agent to take the same supported content and place it into an arbitrary, pre-analyzed Word template while preserving the template’s layout, branding, tables, images, sections, and formatting.

The recommended tool is separate from the existing text-oriented `write_file` tool.

Recommended name:

```text
write_document
```

The responsibilities are intentionally divided:

### Agent

- reads the user’s task;
- uses the existing RAG/search/document tools;
- determines factual content;
- follows the Template Blueprint’s instructions;
- builds a structured **Agent Data** payload;
- optionally generates/retains a Markdown narrative/preview;
- calls `write_document`.

### `write_document` tool/runtime

- loads the approved template version and blueprint;
- validates the Agent Data against the blueprint;
- copies the original DOCX package;
- performs only blueprint-authorized Open XML modifications;
- expands or removes rows/blocks dynamically;
- inserts/replaces images and chart images;
- preserves all unrelated template structure/layout;
- validates the output package;
- uploads the finished DOCX;
- writes the generated-file database record;
- returns a persistent `fileId` to the model/runtime.

### Optional rendering service

- converts the completed DOCX to PDF;
- produces page images for visual QA;
- is not required for DOCX generation.

The core principle is:

> **The model decides content. The blueprint defines where content belongs. The renderer performs deterministic document mutations.**

### 1.1 Implemented runtime checkpoint — 2026-08-16

The repository now contains the first production renderer increment:

- `get_template_contract` loads an assigned, enabled, successfully ingested
  template, verifies its immutable source SHA-256, and returns a semantic
  contract bound to the selected version and a contract digest;
- `write_document` accepts only IDs from that contract plus schema-validated
  Agent Data, renders the exact immutable DOCX source, uploads the binary to the
  generated-files bucket, and returns the persistent generated-file record;
- Ask and Extraction advertise these tools only when the active silo has at
  least one assigned Template Group;
- models can write scalar text, formatted paragraph/heading runs, generated
  tables, and any number of rows in detected repeating template tables;
- the renderer preserves unchanged package parts and existing images, validates
  internal relationship targets, reopens the generated package, and scans for
  unresolved placeholders before persistence;
- render metadata records the template/version IDs, source hash, contract
  digest, Agent Data hash, provider/model, validation result, and warnings.

This increment compiles its contract deterministically from explicit
`{{...}}` placeholders and numbered/repeated table rows at render time. It does
not yet depend on the later persisted blueprint-review workflow. Conditional
blocks, visually implied binding slots, model-requested image replacement,
charts, and PDF generation remain future blueprint/renderer capabilities.

---

## 2. Relationship to the current `write_file` system

The current generated-file infrastructure remains valuable as the persistence/provenance layer, but it requires changes before DOCX output is first-class.

The current implementation is text-centric:

- supported formats are `txt`, `csv`, `md`, and `json`;
- the private `generated-files` bucket currently permits only corresponding text MIME types;
- content is represented as UTF-8 text;
- Ask and Extraction currently treat `write_file` primarily as a loop terminator and let the application write the final body afterward;
- only the Vision path currently executes `write_file` as a true persistent tool call;
- `get_new_id` is currently advertised but not implemented.

The document implementation should not copy those limitations.

### Required runtime direction

For document artifacts, a run is complete only after the tool has actually returned a persistent generated-file result.

Do not use a `write_document` call merely as a “final answer signal.”

---

## 3. High-level architecture

```text
User request
    │
    ▼
Agent run
    │
    ├── Template Blueprint context
    │
    ├── RAG search
    │
    ├── source/document tools
    │
    └── reasoning/content generation
    │
    ▼
Structured Agent Data
    │
    ▼
write_document tool
    │
    ├── load immutable template DOCX
    ├── load approved blueprint
    ├── validate input
    ├── copy original DOCX package
    ├── execute render operations
    ├── validate generated DOCX
    └── persist generated file
    │
    ▼
Generated DOCX fileId
    │
    ├── optional PDF conversion
    └── optional visual QA
```

---

## 4. Preconditions

Before an agent can generate a document:

1. the template belongs to exactly one Template Group;
2. that group is granted and bound to the active tenant/project/silo task;
3. the Word template has been uploaded;
4. deterministic template ingestion has snapshotted its configuration and
   persisted hash-verified package, asset, usage, and structure manifests;
5. the Template Analyzer has produced a blueprint from those exact artifacts;
6. the blueprint has passed structural validation;
7. the blueprint status is allowed for generation, normally `approved`;
8. the template version is immutable and has a stored SHA-256 hash;
9. the active template version is one returned by the resolved group tool;
10. `write_document` is enabled for the model task/run.

The generation tool must refuse to render against a different template hash/version than the one referenced by the blueprint.

---

## 5. Do not put Word mechanics into the model prompt

The agent should never need to understand:

- ZIP package entries;
- `word/document.xml`;
- run IDs;
- relationship IDs;
- XML namespaces;
- drawing anchors;
- media part paths;
- section XML.

The agent receives a **semantic template contract** derived from the blueprint.

Example:

```json
{
  "template": {
    "name": "Town Manager Report",
    "templateVersionId": "uuid"
  },
  "fields": [
    {
      "fieldId": "municipality_name",
      "type": "text",
      "required": true,
      "instruction": "Official municipality name."
    },
    {
      "fieldId": "town_manager_summary",
      "type": "rich_text",
      "required": true,
      "instruction": "Write 2–4 concise sentences covering accomplishments, emerging issues, material changes, and next-period management focus."
    }
  ],
  "collections": [
    {
      "collectionId": "priority_initiatives",
      "instruction": "One item per current priority initiative.",
      "fields": [
        "initiative",
        "owner",
        "execution_status",
        "target_milestone",
        "funding_gap",
        "leadership_note"
      ]
    }
  ]
}
```

The exact element locations remain server-side inside the blueprint.

---

## 6. Agent Data

The model produces a structured payload called **Agent Data**.

Agent Data is the interface between reasoning/RAG and deterministic rendering.

### 6.1 Recommended top-level shape

```json
{
  "schemaVersion": "1.0",
  "templateVersionId": "uuid",
  "blueprintId": "uuid",
  "fields": {
    "municipality_name": "Georgetown",
    "town_manager_summary": "..."
  },
  "collections": {
    "priority_initiatives": [
      {
        "initiative": "Water Main Replacement",
        "owner": "Public Works",
        "execution_status": "WATCH",
        "target_milestone": "Bid award — September 15, 2026",
        "funding_gap": 125000,
        "leadership_note": "Confirm grant match source."
      }
    ]
  },
  "assets": {
    "municipality_logo": {
      "fileId": "uuid"
    }
  },
  "charts": {
    "funding_summary": {
      "chartType": "bar",
      "data": {
        "labels": ["Required", "Secured", "Gap"],
        "values": [2500000, 1800000, 700000]
      }
    }
  },
  "provenance": {
    "sourceRecords": []
  }
}
```

### 6.2 Why structured Agent Data is preferred over raw Markdown

Markdown is excellent for freeform prose output, but it is insufficient by itself for arbitrary template operations such as:

- six-column table rows;
- multiple repeating collections;
- conditional blocks;
- image slots;
- status labels;
- structured dates/currency;
- source-traceability data;
- charts.

Therefore the preferred model contract is structured data.

Markdown can remain:

- a human-readable preview;
- a fallback rich-text input type;
- an intermediate product;
- a compatibility input for templates whose dynamic region is a single narrative block.

---

## 7. Compatibility with the existing Markdown workflow

The system already generates Markdown successfully. Do not discard that capability.

Support two paths.

### Path A — preferred: generate structured Agent Data directly

The model performs the same RAG work it performs today, but instead of ending with only Markdown it builds data matching the template’s semantic schema.

It may also generate a Markdown preview if useful.

### Path B — compatibility: map existing Markdown into Agent Data

When an existing workflow already creates a Markdown file:

1. load the Markdown body;
2. provide it to the agent with the blueprint semantic schema;
3. instruct the model to map the supported Markdown content into fields/collections;
4. use RAG only for missing fields when permitted;
5. generate structured Agent Data;
6. call `write_document`.

This preserves existing workflows while moving the final rendering boundary to structured data.

### 7.1 Do not blindly inject the entire Markdown file into one Word field

That should only happen if the blueprint explicitly defines a single `markdown_block` region.

For a structured Word template, Markdown headings/tables/bullets need to be mapped to the correct blueprint fields and collections.

---

## 8. Agent run phases

Recommended logical phases:

### Phase 0 — Discover and select a template

When the request does not name an exact template, the agent calls the relevant
dynamically named Template Group tool. The runtime performs title, semantic, or
hybrid search within that group only and returns compact renderable candidates.
The agent selects one template ID/version/blueprint tuple. The group search
result is selection metadata, not RAG evidence.

### Phase 1 — Load template contract

Application injects:

- template title/version;
- blueprint semantic fields;
- collection schemas;
- local instructions;
- required/optional flags;
- null behavior;
- evidence/source requirements;
- status logic if specified;
- maximum item counts if any.

The agent does not receive low-level Word XML.

### Phase 2 — Gather source information

Agent uses existing tools, including:

- `rag_search`;
- document retrieval;
- source page/image rendering where required;
- any other approved read tools.

Existing RAG behavior remains unchanged.

### Phase 3 — Build Agent Data

The agent fills only supported values.

If a blueprint/report rule requires “Not Available from Source,” the model must use that rather than inventing a value.

### Phase 4 — Validate completeness before tool call

The model/runtime should check:

- required fields populated;
- collections have correctly shaped items;
- enumerated values are valid;
- dates/currency types are valid;
- evidence-required fields carry provenance if the application requires it;
- unknown data is represented according to null policy.

### Phase 5 — Call `write_document`

The model emits the structured data to the real tool.

### Phase 6 — Tool result

The runtime returns a persisted file result. Only then can the document-generation run complete.

---

## 9. Recommended agent system instruction

A task-specific system instruction can be derived from the blueprint.

Recommended core text:

```text
Tool available: write_document.

You are generating a Word document from a pre-analyzed template. The template layout, formatting, tables, images, sections, headers, footers, and other presentation details are controlled by the document renderer. Do not attempt to write DOCX XML or describe layout instructions to the renderer.

You are responsible for the factual and narrative content only.

You will receive a semantic Template Blueprint describing fields and repeating collections that can be populated. Follow each field/collection instruction exactly.

Use the available RAG/source tools to obtain supported information. Do not fabricate unsupported factual values. When the blueprint specifies a null/unsupported-value rule, follow it exactly.

Build structured Agent Data using only field IDs and collection IDs defined by the template contract. Do not invent new binding IDs.

The number of rows shown in the original Word template does not constrain a repeating collection. Supply one array item per supported record, subject only to explicit min/max rules in the blueprint.

When your Agent Data is complete, call write_document. A document-generation task is not complete until write_document returns success and a generated file ID.

Do not return the final document body in place of the tool call when document output is required.
```

### 9.1 Blueprint-derived field instructions

Append concise machine-generated instructions such as:

```text
FIELD municipality_name
Type: text
Required: yes
Instruction: Official municipality name.

FIELD town_manager_summary
Type: rich_text
Required: yes
Instruction: 2–4 sentence executive narrative covering accomplishments, emerging issues, material changes, and next-period management focus.

COLLECTION priority_initiatives
Repeat: one item per priority initiative.
Fields: initiative, owner, execution_status, target_milestone, funding_gap, leadership_note.
```

Avoid sending the full blueprint internal structure if it is not needed by the model.

---

## 10. `write_document` tool contract

Recommended tool schema:

```json
{
  "tool": "write_document",
  "command": "render",
  "templateId": "uuid",
  "templateVersionId": "uuid",
  "blueprintId": "uuid",
  "fileName": "Georgetown_Town_Manager_Report_2026-08.docx",
  "agentData": {
    "schemaVersion": "1.0",
    "fields": {},
    "collections": {},
    "assets": {},
    "charts": {},
    "provenance": {}
  },
  "options": {
    "outputFormat": "docx",
    "generatePdf": false,
    "visualQa": false
  }
}
```

Tenant/project/silo IDs should be runtime-bound, not model-supplied, following the same security principle as the existing generated-file tool.

### 10.1 Tool response

```json
{
  "success": true,
  "generatedFile": {
    "id": "uuid",
    "fileName": "Georgetown_Town_Manager_Report_2026-08.docx",
    "outputFormat": "docx",
    "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "byteSize": 284319
  },
  "template": {
    "templateId": "uuid",
    "templateVersionId": "uuid",
    "blueprintId": "uuid"
  },
  "validation": {
    "unresolvedRequiredBindings": 0,
    "packageValid": true,
    "relationshipTargetsValid": true
  },
  "warnings": []
}
```

If PDF conversion is enabled, return an additional generated-file object rather than hiding the PDF inside metadata.

---

## 11. Renderer design

The renderer must begin with the **exact original template version**.

### 11.1 Render algorithm

```text
Load template bytes
    │
Verify SHA-256 == blueprint template hash
    │
Open DOCX ZIP package
    │
Load blueprint
    │
Validate Agent Data
    │
Resolve blueprint element IDs
    │
Clone package to working copy
    │
Apply authorized mutations in deterministic order
    │
Validate relationships/content types/XML
    │
Write ZIP as DOCX bytes
    │
Persist file
```

### 11.2 Mutation ordering

Suggested order:

1. resolve/validate all targets before modifying anything;
2. prepare images/chart assets;
3. expand repeating block/row structures;
4. remove unused prototype rows/blocks;
5. populate repeated-instance fields;
6. populate scalar text/rich text;
7. replace/insert images;
8. apply status-style mappings;
9. update relationships/content types;
10. final unresolved-binding scan;
11. package validation.

This avoids target IDs disappearing before they have been resolved.

---

## 12. Scalar text replacement

Text replacement must preserve template formatting as much as possible.

### 12.1 Simple replacement

For a target paragraph/cell whose entire content is a placeholder/instruction:

- retain paragraph properties;
- retain the most appropriate prototype run formatting;
- remove only dynamic text runs/content;
- create the necessary runs/text nodes for the new value;
- preserve surrounding static runs.

### 12.2 Placeholder split across runs

The renderer must use the analyzer’s logical text/run mapping. Never assume the placeholder exists in one `w:t` node.

Algorithm:

1. identify character range represented by the binding;
2. find all physical runs/text nodes intersecting the range;
3. retain formatting from the designated prototype run;
4. remove/trim old dynamic text across the range;
5. insert replacement content;
6. preserve static prefix/suffix text.

### 12.3 Whitespace

Ensure `xml:space="preserve"` is used where leading/trailing spaces require preservation.

---

## 13. Rich text and Markdown rendering

Some fields may need paragraphs, bullets, emphasis, or line breaks rather than plain text.

Blueprint data types can distinguish:

- `text` — plain inline text;
- `rich_text` — structured paragraph/run representation;
- `markdown_block` — Markdown converted to a limited Word block model.

### 13.1 Supported Markdown v1 subset

Recommended:

- paragraphs;
- bold;
- italic;
- inline links;
- unordered lists;
- ordered lists;
- line breaks;
- simple headings only when allowed by the slot;
- simple tables only for slots explicitly marked to accept a nested/generated table.

Unsupported Markdown should be normalized or rejected rather than converted unpredictably.

### 13.2 Styling policy

Generated paragraphs should inherit/reference styles already present in the template whenever possible.

The blueprint may provide style hints:

```json
{
  "paragraphStyleId": "BodyText",
  "bulletStyle": "ListBullet"
}
```

Avoid hard-coding fonts/colors unless the blueprint explicitly requires them.

---

## 14. Repeating table rows

Variable row counts are a primary use case.

Blueprint example:

```json
{
  "collectionId": "priority_initiatives",
  "operation": "repeat_row",
  "targetTableId": "tbl_000006",
  "prototypeElementIds": ["tr_000042"],
  "emptyBehavior": "remove"
}
```

### 14.1 Rendering algorithm

For each collection:

1. locate the table and prototype row(s);
2. deep-clone the prototype row/group once per Agent Data item;
3. assign transient render-instance IDs internally;
4. replace fields inside each clone using relative blueprint targets;
5. insert clones at the prototype location in source order;
6. remove original sample/prototype rows according to the blueprint;
7. preserve table grid, style, borders, widths, row properties, and cell formatting.

### 14.2 Two rows in data vs six rows in template

If the template shows six example rows and the blueprint identifies one row as the prototype with the other rows designated as samples:

- two data items → render two body rows;
- six data items → render six rows;
- twelve data items → render twelve rows;
- zero data items → follow `emptyBehavior`.

Word handles page flow when the user opens the DOCX. The renderer does not need to calculate exact final pagination to create a valid document.

### 14.3 Multi-row record groups

Some designs represent one record with two or more rows. Support `repeat_row_group` with an ordered prototype array.

---

## 15. Repeating document blocks

A repeating block may contain:

- heading;
- KPI table;
- narrative paragraphs;
- image;
- page break.

The Template Analyzer defines start/end/prototype elements.

The renderer deep-clones the entire block per collection item and resolves relative fields inside each clone.

This is appropriate for sections such as “Priority Initiative Detail — Repeating Block.”

---

## 16. Optional blocks

Blueprint may define:

```json
{
  "blockId": "public_highlights",
  "operation": "optional_block",
  "condition": "collection_non_empty:public_highlights",
  "emptyBehavior": "remove"
}
```

The renderer—not the model—evaluates deterministic conditions that are expressible in the blueprint.

Avoid arbitrary code expressions in templates/blueprints for security and predictability.

---

## 17. Images

### 17.1 Preserve static images

Static images already in the template remain untouched.

No extraction/reinsertion is necessary during generation unless the package mutation requires it. The template package is copied intact.

### 17.2 Replaceable image slot

For a blueprint-defined image slot:

1. load the supplied Agent Data asset/file;
2. validate MIME/type/size;
3. locate the original drawing and relationship;
4. preserve drawing placement/crop/wrap geometry where possible;
5. either replace the existing media part bytes or add a new media part and update the relationship;
6. update content types if needed;
7. preserve alternate text where the blueprint requires it.

This allows a placeholder logo on the left edge of a page, for example, to be replaced while keeping its exact Word positioning.

### 17.3 Insert-new image slot

If the template contains an empty marker rather than an existing image, the blueprint must include enough deterministic insertion metadata to create a drawing safely.

This is more complex than replacing an existing image and should be treated as a separate operation.

---

## 18. Charts

For v1, render charts as images.

Recommended flow:

```text
Agent Data chart specification
        │
        ▼
Server chart renderer
        │
        ▼
PNG/SVG rasterized as required
        │
        ▼
Insert into blueprint chart slot
```

Benefits:

- deterministic;
- no embedded Excel workbook required;
- simpler package relationships;
- predictable cross-platform rendering.

Native editable Word charts can be added later as a separate advanced feature.

---

## 19. Status visual treatment

Some templates contain colored status boxes/rows.

The blueprint can define a style map:

```json
{
  "styleMapId": "execution_status",
  "values": {
    "ON TRACK": { "prototypeStyleRef": "status_green" },
    "WATCH": { "prototypeStyleRef": "status_amber" },
    "ACTION REQUIRED": { "prototypeStyleRef": "status_red" },
    "COMPLETE": { "prototypeStyleRef": "status_blue" },
    "NOT STARTED": { "prototypeStyleRef": "status_gray" }
  }
}
```

Prefer copying style properties already present in the template rather than hard-coding color values in model output.

---

## 20. Headers, footers, sections, and layout

The renderer should preserve these by default.

Only modify a header/footer/section if the blueprint explicitly contains a binding there.

For example, a municipality name in a header may be replaceable while page-number fields remain static/preserved.

Never globally rebuild section properties just because table rows were added.

The Word application will repaginate the document when opened.

---

## 21. Package relationship handling

Whenever new media or relationships are introduced:

- choose a relationship ID not already used in that source part;
- add the relationship to the correct `.rels` part;
- use a unique package target path;
- add/verify `[Content_Types].xml` declarations;
- verify all internal relationship targets exist before packaging;
- never fetch external relationships automatically.

The renderer should contain a reusable package relationship manager rather than letting individual render operations edit `.rels` files ad hoc.

---

## 22. Generated-file persistence changes

The existing generated-file store can remain the destination, but it must support binary output.

### 22.1 New format

Add:

```text
docx
```

MIME:

```text
application/vnd.openxmlformats-officedocument.wordprocessingml.document
```

If PDF is supported:

```text
application/pdf
```

### 22.2 Storage bucket MIME policy

The existing `generated-files` bucket currently allows text MIME types only. Its policy/migration must be updated to permit DOCX and optionally PDF.

The bucket's current object limit is 50 MB. Keep that limit for the first DOCX
release and measure image-bearing outputs before deciding whether it needs to
change.

### 22.3 Binary writer

Refactor the generated-file persistence layer so it can receive:

```ts
type GeneratedFileBody = string | Buffer | Uint8Array;
```

The content-preview behavior should be format-aware:

- text formats: first N characters;
- DOCX/PDF: generated summary, metadata, or no raw content preview.

Do not attempt to UTF-8 decode DOCX bytes for preview.

---

## 23. Recommended database metadata for generated documents

Every generated DOCX should retain reproducibility/provenance metadata such as:

```json
{
  "generated_from": "write_document",
  "template_group_id": "uuid",
  "template_tool_name": "municipal_reports",
  "template_id": "uuid",
  "template_version_id": "uuid",
  "template_sha256": "...",
  "template_configuration_id": "uuid",
  "template_configuration_sha256": "...",
  "template_ingestion_manifest_sha256": "...",
  "blueprint_id": "uuid",
  "blueprint_schema_version": "1.0",
  "renderer_version": "1.0.0",
  "agent_data_schema_version": "1.0",
  "source_markdown_file_id": "uuid-if-used",
  "question_log_id": "uuid-if-applicable",
  "extraction_run_id": "uuid-if-applicable",
  "validation": {
    "package_valid": true,
    "unresolved_required_bindings": 0
  }
}
```

The application should also retain a canonical Agent Data snapshot or hash so a document can be reproduced later.

---

## 24. Real tool execution in Ask / Extraction

The document tool must correct the current architectural mismatch in which `write_file` is treated as a loop terminator on Ask/Extraction.

Recommended behavior:

1. model emits `write_document` tool call;
2. runtime parses and validates the call;
3. runtime invokes the document service;
4. service renders and persists the DOCX;
5. runtime receives tool result containing `fileId`;
6. tool result is made visible to the model/run state;
7. the run may then terminate successfully.

The application should not discard the model’s template/file/options fields and independently recreate the file later.

### 24.1 Completion invariant

When document output is required:

```text
run.success requires write_document.success == true
```

A plain final text response is not considered a successful document-generation result.

---

## 25. `get_new_id`

The existing text tool advertises `get_new_id` but does not implement it.

For the new document tool, choose one of two clean designs:

### Option A — no preallocated ID

Preferred for v1.

`write_document.render` performs the write atomically and returns the generated file ID.

### Option B — real reservation command

Only implement if the workflow genuinely requires a file ID before content is complete.

```json
{
  "tool": "write_document",
  "command": "reserve"
}
```

Return a real reserved UUID/row and define cleanup behavior for abandoned reservations.

Do not advertise a non-functional command.

---

## 26. Validation before rendering

The tool validates Agent Data against the semantic blueprint.

Checks include:

- template/blueprint IDs belong together;
- template hash matches;
- blueprint approved;
- all required scalar fields present;
- field data types valid;
- collection item schemas valid;
- min/max rules valid;
- enum values valid;
- asset references resolvable;
- chart specifications valid;
- null rules respected;
- prohibited/unrecognized field IDs rejected or warned per strictness policy.

Recommended default is strict: unknown field/collection IDs are errors.

---

## 27. Validation after rendering

Before storing the file:

### Package validation

- DOCX ZIP can be opened;
- required package entries exist;
- `[Content_Types].xml` parses;
- relationship parts parse;
- every internal relationship target exists;
- modified Word XML parts are well formed;
- no duplicate relationship IDs within a source part;
- no unresolved mandatory blueprint bindings remain.

### Structural checks

- repeated rows/blocks have expected item count;
- prototype markers/sample placeholders removed where required;
- inserted assets exist;
- required text fields are not empty unless allowed.

### Optional semantic checks

- scan visible text for unresolved `{{...}}` patterns;
- scan for known template instructions such as “enter ... here” if blueprint marks them replaceable;
- check the output does not contain internal developer-only instructions when those sections are configured for removal.

---

## 28. Optional LibreOffice/PDF/visual QA

The core renderer creates DOCX **without LibreOffice**.

Optional post-processing:

```text
DOCX
  │
  ├── persist immediately
  │
  └── optional LibreOffice/render service
          │
          ├── PDF
          └── page images → vision QA
```

Visual QA can detect:

- obvious overflow;
- clipped images;
- unexpectedly blank pages;
- unresolved visible placeholders;
- broken table layout;
- missing chart/image;
- inappropriate page breaks.

A PDF failure should not necessarily invalidate a correctly generated DOCX unless the caller explicitly required PDF as part of the same atomic output contract.

---

## 29. Tool error model

Use explicit machine-readable errors.

Suggested codes:

- `document_tool_disabled`
- `template_not_found`
- `template_version_not_found`
- `template_blueprint_not_found`
- `template_blueprint_not_approved`
- `template_blueprint_mismatch`
- `template_hash_mismatch`
- `agent_data_invalid`
- `required_field_missing`
- `collection_item_invalid`
- `asset_not_found`
- `asset_type_invalid`
- `render_target_not_found`
- `render_operation_failed`
- `relationship_validation_failed`
- `docx_package_invalid`
- `generated_file_upload_failed`
- `generated_file_database_failed`
- `pdf_render_failed`
- `visual_qa_failed`

Each error should include:

- `code`;
- safe message;
- stage;
- recoverable flag;
- optional field/collection/element ID;
- correlation/run ID.

Do not expose storage credentials, private object paths, or raw source secrets to the model.

Ask and Extraction return a failed DOCX workspace operation to the model as
corrective tool feedback for up to two attempts. The operation is not applied,
and the model can edit or inspect the existing workspace before retrying
`finalize_document`. Repeated failures still end the run with the explicit tool
error. This distinguishes correctable Agent Data or revision mistakes from a
successful final render.

---

## 30. Idempotency and retries

Rendering may be retried because of model/tool/network failures.

Use a runtime-generated idempotency key combining, for example:

```text
runId + toolCallId + templateVersionId
```

The document service should avoid creating duplicate generated files for the same successfully completed tool call.

If the database write fails after storage upload, delete the newly uploaded object, matching the cleanup semantics already used by the existing generated-file writer.

---

## 31. Concurrency

Rendering is CPU/memory work but does not require a full office suite.

Use a worker/job boundary if large templates or images make synchronous web execution undesirable.

Recommended pattern:

```text
Agent runtime
    │
    ▼
write_document call
    │
    ▼
Document render service/worker
    │
    ▼
Storage + generated_files row
    │
    ▼
Tool result
```

If the agent loop expects synchronous tool calls, keep render jobs bounded and return only after persistence succeeds. If asynchronous generation is introduced later, the tool protocol must explicitly support pending job state instead of pretending the file already exists.

---

## 32. Security model

- tenant/project/silo are runtime-bound;
- model cannot choose another tenant’s template;
- template and blueprint IDs are authorization-checked;
- source asset file IDs are scope-checked;
- no arbitrary filesystem paths accepted from model calls;
- no arbitrary executable expressions in blueprints;
- no macro execution;
- no external relationship fetching;
- reject unsupported asset MIME types;
- bound image/chart dimensions and file size;
- private generated-file storage;
- audit every template version and generated document.

---

## 33. Suggested service/module layout

For the current TypeScript monorepo, a clean split might be:

```text
packages/
  rag-core/
    document-tool-contracts.ts
    document-blueprint-schema.ts

  docx-engine/
    package-reader.ts
    package-writer.ts
    relationship-manager.ts
    blueprint-resolver.ts
    text-renderer.ts
    table-renderer.ts
    block-renderer.ts
    image-renderer.ts
    chart-renderer.ts
    markdown-renderer.ts
    validator.ts
    types.ts

apps/
  worker/
    document-render-job.ts

  web/
    lib/
      document-generation.ts
      generated-files.ts
    app/api/
      document-templates/...
      generated-documents/...
```

The exact layout can differ, but the important rule is to have **one shared document renderer implementation** rather than duplicating it independently in web and worker code as happened with the current generated-file writer.

---

## 34. Renderer implementation guidance

Because arbitrary existing templates must be preserved, prefer a **package mutation engine** over rebuilding the document with a high-level “create a Word document from scratch” library.

Recommended internal strategy:

1. load original ZIP package;
2. retain all unmodified entries byte-for-byte;
3. parse only XML parts that require changes;
4. resolve blueprint targets;
5. clone/mutate the minimum required XML subtrees;
6. write modified XML parts back;
7. add media/relationship/content-type entries when needed;
8. generate a new ZIP/DOCX.

A ZIP library and namespace-aware XML parser/builder are sufficient for the core engine.

Do not serialize every XML part unnecessarily. Preserving untouched package entries minimizes compatibility risk.

---

## 35. Example end-to-end agent flow

### User asks

```text
Generate the August Town Manager report using the approved Town Manager template.
```

### Runtime loads template semantic contract

```text
Template: Town Manager Report v1
Required scalar fields: municipality_name, report_period, manager, ...
Collections: priority_initiatives, changes, decisions, funding_pipeline, ...
```

### Agent uses RAG

```json
{
  "tool": "rag_search",
  "query": "priority initiatives status funding gaps milestones August 2026"
}
```

Additional searches retrieve financial, grants, risks, decisions, and evidence information.

### Agent builds Agent Data

```json
{
  "fields": {
    "municipality_name": "Example Town",
    "report_period": "August 1–31, 2026",
    "town_manager_summary": "..."
  },
  "collections": {
    "priority_initiatives": [
      {
        "initiative": "Main Street Drainage",
        "owner": "Public Works",
        "execution_status": "WATCH",
        "target_milestone": "Design completion — September 12",
        "funding_gap": "$210,000",
        "leadership_note": "Grant match confirmation required."
      },
      {
        "initiative": "Water Meter Replacement",
        "owner": "Utilities",
        "execution_status": "ON TRACK",
        "target_milestone": "Phase 2 deployment — October 1",
        "funding_gap": "$0",
        "leadership_note": "No leadership intervention required."
      }
    ]
  }
}
```

### Agent calls renderer

```json
{
  "tool": "write_document",
  "command": "render",
  "templateVersionId": "...",
  "blueprintId": "...",
  "fileName": "Example_Town_Manager_Report_August_2026.docx",
  "agentData": {
    "fields": {},
    "collections": {}
  }
}
```

### Renderer

- copies the original Word template;
- fills scalar fields;
- turns the five/six displayed initiative sample rows into exactly two rows because Agent Data contains two initiatives;
- preserves colors, widths, headers, footers, section orientation, and layout;
- packages the DOCX;
- stores it;
- returns the generated file ID.

---

## 36. Fincentiv-specific reference behavior without hard-coding Fincentiv

The provided Town Manager template includes implementation guidance that maps naturally to this architecture:

- scalar report metadata;
- exception-focused narrative;
- priority initiatives;
- changes and decisions;
- financial/operating metrics;
- department roll-ups;
- risks/dependencies;
- forward milestones;
- evidence/source records;
- repeating initiative detail blocks;
- null/source-traceability rules.

The renderer must not hard-code these names. They are simply the blueprint created for this template version.

A completely different Word template should result in a different semantic schema while using the same `write_document` engine.

---

## 37. Migration plan from current Markdown output

### Phase 1 — keep current research logic

Do not change RAG/search behavior.

### Phase 2 — add template context

Inject semantic blueprint instructions into the agent run.

### Phase 3 — dual output during development

Have the agent produce:

- existing Markdown output for comparison/debugging;
- structured Agent Data for DOCX rendering.

### Phase 4 — introduce `write_document`

Render DOCX from Agent Data and store it.

### Phase 5 — make real tool execution mandatory

For document-output requests, successful `write_document` persistence becomes the completion criterion.

### Phase 6 — optional deprecate duplicate Markdown

Once DOCX output is trusted, retain Markdown only when useful as preview/source artifact.

---

## 38. Required changes to model task configuration

Add `write_document` and `get_template_contract` to the built-in model tool
catalog. Resolve dynamically named Template Group search tools per run.

Per task/configuration:

- `tools_enabled = true`;
- `allowed_tools` contains `write_document`;
- application resolves allowed Template Groups from silo/project/task bindings;
- the selected template ID/version/blueprint was returned by one of those group
  tools or was explicitly preselected and authorized by the application;
- model context includes the selected template semantic contract;
- request explicitly indicates document output when appropriate.

A document request should fail early if:

- no template selected;
- selected template did not come from an authorized Template Group;
- blueprint unavailable/unapproved;
- task does not allow `write_document`;
- active scope missing.

---

## 39. Events/telemetry

Recommended events:

```text
generated_document.preparing
generated_document.agent_data_validated
generated_document.render_started
generated_document.render_completed
generated_document.validation_completed
generated_document.uploaded
generated_document.persisted
generated_document.pdf_started
generated_document.pdf_completed
generated_document.failed
```

Capture durations for:

- agent/RAG phase;
- data validation;
- DOCX render;
- package validation;
- upload/database;
- optional PDF/QA.

This makes it straightforward to distinguish model latency from document-engine latency.

---

## 40. Acceptance test matrix

### Tool execution

- document request cannot complete with text-only answer;
- successful render returns actual generated file ID;
- failed upload returns tool failure;
- retry is idempotent.

### Template binding

- correct template version required;
- blueprint mismatch rejected;
- required fields enforced;
- unknown field IDs rejected.

### Text

- scalar field replacement;
- split-run placeholder replacement;
- styled paragraph preserved;
- multiline rich text;
- supported Markdown block.

### Tables

- 0 records;
- 1 record;
- fewer records than sample rows;
- more records than sample rows;
- 50+ records with Word repagination;
- merged cells preserved;
- repeat-header behavior preserved;
- multi-row record prototype.

### Blocks

- repeating detail page/block;
- optional block removed;
- conditional message when collection empty.

### Images

- static image unchanged;
- image slot replaced;
- placement preserved;
- image in header preserved/replaced when explicitly bound;
- invalid MIME rejected.

### Charts

- chart image generated and inserted;
- chart absent follows null/optional policy.

### Package

- output opens as DOCX;
- all relationships resolve;
- untouched template parts retained;
- no unresolved required placeholders;
- file stored with correct MIME type.

### Provenance

- generated-file row references template version/blueprint;
- Agent Data snapshot/hash retained;
- source run IDs retained where applicable.

---

## 41. Definition of done

The Agent Document Write & Render Tool v1 is complete when:

1. an approved Template Blueprint can be selected for an agent run;
2. the agent receives only the semantic content contract it needs;
3. the agent can use the existing RAG tools normally;
4. the agent can transform RAG/Markdown-derived knowledge into structured Agent Data;
5. the agent calls a real `write_document` tool;
6. the tool loads the exact original template version;
7. scalar content is inserted without destroying formatting;
8. table rows can expand/shrink dynamically;
9. repeating blocks can be cloned;
10. static template images/layout are preserved;
11. replaceable images can retain template positioning;
12. chart images can be inserted;
13. the renderer produces DOCX bytes with no LibreOffice dependency;
14. the DOCX is validated and persisted in generated-file storage;
15. the tool returns the persistent generated-file ID;
16. document-required agent runs cannot succeed without that tool result;
17. optional LibreOffice/PDF/vision QA can be added without changing the core renderer contract;
18. the generated document retains enough template, blueprint, Agent Data, and run provenance to be reproduced later.

---

## 42. Final architectural boundary

The implementation should preserve this division permanently:

```text
Template Analyzer
    DOCX → Blueprint

Agent
    RAG/source data → Agent Data

Document Renderer
    Original DOCX + Blueprint + Agent Data → final DOCX

Optional Render/QA Service
    final DOCX → PDF/page images/visual checks
```

This separation allows arbitrary Word templates to evolve independently of the research agent and allows the RAG system to continue doing what it already does well while adding reliable, high-fidelity Word output.
