# Document Template Analyzer & Blueprint Compiler

**Status:** Proposed implementation specification
**Purpose:** Define a standalone service/tool that accepts an arbitrary Microsoft Word `.docx` template, inspects its physical structure and visual intent, extracts reusable assets, and compiles the document into a versioned **Template Blueprint** that can later drive deterministic document generation.

Template ownership, Template Group tools, detailed descriptions, and catalog
search are defined separately in
[Template Catalog And Template Group Tools](template_catalog_and_group_tool_spec.md).
The analyzer operates on a template that already belongs to exactly one group.
The typed worker instructions, private storage namespace, configuration
snapshots, and extracted-image persistence are defined in
[Template DOCX Ingestion And Storage](template_docx_ingestion_and_storage_spec.md).

---

## 1. Executive summary

The Template Analyzer is a **pre-processing/compilation step**, not part of every report-generation run.

A user supplies a Word document that may contain any combination of:

- normal text;
- `{{placeholder}}` variables;
- natural-language instructions such as “Provide a 2–4 sentence summary here”;
- blank or partially populated tables;
- sample rows that imply a repeating collection;
- images and logos;
- page decorations and branding;
- text boxes, shapes, shaded tables, borders, and visual cards;
- headers and footers;
- portrait and landscape sections;
- page/section breaks;
- areas that are clearly intended for charts or images even when they do not contain explicit variables;
- optional or repeating document blocks.

The analyzer must **not** attempt to turn the template into a completely new document representation that is later used to rebuild the Word file from scratch. The original DOCX remains the **physical source of truth for layout and formatting**.

The analyzer instead creates a semantic blueprint describing:

1. what elements exist;
2. where those elements are located in the DOCX package;
3. which elements are static and must be preserved;
4. which elements are intended to receive generated content;
5. which elements are repeating, optional, replaceable, or dynamically sized;
6. the instructions that an agent must follow to populate each dynamic element;
7. how images, charts, tables, and repeated blocks should be handled;
8. confidence and review state for model-inferred bindings.

The core design principle is:

> **Code understands the Word package and exact element locations. The model understands document intent. The original DOCX preserves presentation.**

---

## 2. Scope

### 2.1 In scope

The analyzer is responsible for:

- validating a DOCX package;
- extracting its package parts and relationships;
- building a deterministic structural representation of the document;
- identifying sections, paragraphs, runs, tables, rows, cells, headers, footers, drawings, images, hyperlinks, fields, bookmarks, and content controls where present;
- preserving the relationship between document elements and their Open XML locations;
- extracting embedded image assets;
- recording layout metadata needed for understanding and safe modification;
- recognizing explicit placeholders;
- recognizing natural-language instructions;
- inferring likely data-entry regions from blank/sample content and visual context;
- identifying repeating tables and repeating blocks;
- identifying likely replaceable image/chart slots;
- preparing a compact structural package for a multimodal model;
- optionally producing rendered page images for vision analysis;
- combining deterministic structure with model semantic interpretation;
- assigning confidence levels and review flags;
- creating and versioning a reusable Template Blueprint;
- producing validation reports and a reviewable “template map.”

### 2.2 Out of scope

The analyzer does **not**:

- gather municipal/report data from RAG;
- write the final report;
- render a completed report into DOCX;
- decide the factual content of the report;
- permanently flatten the DOCX to images;
- require LibreOffice for final DOCX creation;
- require all templates to use one specific placeholder syntax;
- require the template author to understand Open XML.

Those responsibilities belong to the later Agent Document Write / Render Tool.

---

## 3. Core architectural decision

### 3.1 Preserve the original DOCX

The dedicated template-ingestion stage stores the original bytes unchanged and
produces the structure/assets consumed by the analyzer. The blueprint references
locations inside that immutable package.

Generation later starts from a copy of the original template and changes only the locations authorized by the blueprint.

This is preferable to rebuilding the document because the original template already contains:

- styles;
- typography;
- table formatting;
- colors;
- section settings;
- page margins;
- header/footer definitions;
- positioned graphics;
- cell borders;
- paragraph spacing;
- line spacing;
- page breaks;
- column widths;
- theme information;
- numbering definitions;
- drawing anchors;
- relationship information.

The blueprint therefore acts as a **semantic map and mutation plan**, not a replacement Word document format.

### 3.2 Template lifecycle

```text
Upload DOCX
    │
    ▼
Snapshot active Template Configuration
    │
    ▼
Dispatch typed TemplateIngestionInstructions
    │
    ▼
Validate and split DOCX package
    │
    ├── package/relationship manifests
    ├── structure graph
    ├── extracted assets + usage graph
    └── layout metadata
    │
    ▼
Optional page rendering
    │
    ▼
Vision / reasoning model analysis
    │
    ▼
Merge deterministic + semantic results
    │
    ▼
Template Blueprint Draft
    │
    ▼
Validation / optional human review
    │
    ▼
Approved Template Blueprint vN
```

A template is analyzed once per version. Hundreds or thousands of later documents can reuse that blueprint without re-running the expensive semantic analysis.

### 3.3 Dedicated ingestion handoff

Deterministic package decomposition is an explicit ingestion submodule, not a
free-form model task and not the ordinary document/RAG pipeline. The web layer
provides a validated `TemplateIngestionInstructions` envelope containing the
tenant, group, template, version, active configuration snapshot, source object,
hashes, and allowed operations.

Semantic analysis cannot start until this stage reaches `ingested` and the
stored structure/asset-manifest hashes match the objects being read. The model
receives compact structure, asset usage summaries, heuristic hints, configured
analysis instructions, and optional previews. It never receives package-write
authority or storage paths to invent.

---

## 4. DOCX package model the developer must support

A `.docx` file is an Office Open XML package stored as a ZIP container. The analyzer should treat it as a package of parts connected by relationships.

A typical document contains files similar to:

```text
[Content_Types].xml
_rels/.rels
docProps/core.xml
docProps/app.xml
word/document.xml
word/_rels/document.xml.rels
word/styles.xml
word/settings.xml
word/numbering.xml
word/fontTable.xml
word/theme/theme1.xml
word/header1.xml
word/footer1.xml
word/media/image1.png
word/media/image2.jpeg
...
```

Not every template contains every part.

### 4.1 Package inventory

At ingest, create an inventory for every package part:

```ts
interface PackagePartInventory {
  path: string;
  contentType: string | null;
  byteSize: number;
  sha256: string;
  kind: "xml" | "binary" | "relationship" | "unknown";
}
```

Do not assume only `word/document.xml` matters. Dynamic or visually relevant content may also exist in:

- headers;
- footers;
- footnotes;
- endnotes;
- comments;
- text boxes/drawings;
- custom XML parts;
- charts;
- embedded objects;
- media parts.

### 4.2 Relationships

Build a relationship graph before semantic parsing.

For every `.rels` part record:

```ts
interface RelationshipRecord {
  sourcePart: string;
  relationshipId: string; // e.g. rId12
  relationshipType: string;
  target: string;
  targetMode?: "Internal" | "External";
  resolvedTarget?: string;
}
```

This graph is essential for:

- locating image bytes referenced by a drawing;
- resolving hyperlinks;
- associating headers/footers with sections;
- locating chart parts;
- preserving embedded resources;
- safely replacing a media part without breaking document relationships.

### 4.3 Content types

Parse `[Content_Types].xml` and retain:

- default extension mappings;
- part-specific overrides.

This becomes important when the renderer later inserts a new PNG/JPEG/chart and must ensure the package contains the correct content-type declaration.

---

## 5. Deterministic document extraction

The deterministic parser is authoritative for **what physically exists** and **where it exists**.

The semantic model must never invent physical locations.

### 5.1 Main body hierarchy

At minimum parse:

- `w:document`;
- `w:body`;
- `w:p` paragraphs;
- `w:r` runs;
- `w:t` text nodes;
- `w:tbl` tables;
- `w:tr` rows;
- `w:tc` cells;
- `w:sectPr` section properties;
- `w:hyperlink`;
- `w:sdt` structured document tags/content controls;
- bookmark start/end elements;
- field codes/instructions;
- manual page breaks and section breaks;
- drawings and legacy picture objects where present.

### 5.2 Headers and footers

For every section:

1. inspect header/footer references in `w:sectPr`;
2. resolve each relationship ID;
3. parse the referenced part using the same paragraph/table/drawing logic as the main document;
4. include header/footer nodes in the structural graph;
5. distinguish default, first-page, and even-page headers/footers when present.

### 5.3 Sections and page settings

For every section retain:

```ts
interface SectionBlueprintNode {
  id: string;
  sectionIndex: number;
  pageWidthTwips?: number;
  pageHeightTwips?: number;
  orientation?: "portrait" | "landscape";
  margins?: {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
    header?: number;
    footer?: number;
    gutter?: number;
  };
  headerRefs: HeaderFooterRef[];
  footerRefs: HeaderFooterRef[];
  startElementId?: string;
  endElementId?: string;
}
```

The values should be stored in the native Word unit and optionally normalized to points/inches for inspection. Do not rewrite section values during analysis.

### 5.4 Paragraphs and runs

A visible sentence can be split across many Word runs because of formatting, field boundaries, revisions, spell-check artifacts, or editing history.

Therefore create two views:

#### Physical run view

Preserves exact XML/run structure.

#### Logical text view

Concatenates visible text into a semantic string while retaining a character-to-run mapping.

Example:

```ts
interface LogicalParagraphText {
  text: string;
  spans: Array<{
    start: number;
    end: number;
    runElementId: string;
    textElementId: string;
  }>;
}
```

This mapping is critical when a placeholder or instruction crosses run boundaries.

### 5.5 Paragraph formatting

Capture enough formatting to help semantic interpretation and safe rendering:

- paragraph style ID;
- alignment;
- indentation;
- spacing before/after;
- line spacing;
- keep-with-next / keep-lines flags;
- page-break-before;
- list/numbering references;
- borders/shading where present;
- outline level when available.

The blueprint does not need to reproduce this formatting later; the original DOCX already contains it. The metadata helps determine whether an element is a heading, note box, instruction, etc.

### 5.6 Run formatting

Record, when relevant:

- run style;
- font family references;
- font size;
- bold/italic/underline;
- color;
- highlighting;
- vertical alignment;
- hidden text;
- language.

Again, this is primarily for interpretation and safe replacement.

---

## 6. Stable internal addressing

Every element that may be referenced by the blueprint requires a stable analyzer-generated ID.

Example hierarchy:

```text
document
  section:sec_0001
    paragraph:p_000001
      run:r_000001
      run:r_000002
    table:tbl_000001
      row:tr_000001
        cell:tc_000001
          paragraph:p_000002
```

### 6.1 Required locator fields

Each addressable node should retain:

```ts
interface ElementLocator {
  elementId: string;
  partPath: string; // word/document.xml, word/header1.xml, etc.
  elementType: string;
  xmlPath: string; // analyzer-controlled structural path
  parentElementId?: string;
  siblingIndex?: number;
  fingerprint: string; // hash of local structure/content
  sourceOrder: number;
}
```

### 6.2 Do not rely solely on raw XPath

Raw XPath positions are fragile after mutations. The blueprint should use analyzer element IDs and fingerprints. During rendering, the engine rehydrates the original template version and resolves IDs against the exact template fingerprint.

A blueprint must be bound to a specific template version/hash. Do not apply a blueprint created for Template v1 to modified Template v2 unless it has been recompiled.

---

## 7. Table extraction

Tables are one of the most important template structures.

For every `w:tbl` extract:

```ts
interface TableStructure {
  id: string;
  partPath: string;
  rowIds: string[];
  gridColumns: Array<{ index: number; width?: number }>;
  styleId?: string;
  preferredWidth?: number;
  alignment?: string;
  layout?: "fixed" | "autofit" | string;
  textBefore?: string;
  textAfter?: string;
}
```

For rows:

- cell count;
- header-row flags;
- repeat-header flags;
- row height rules;
- cant-split rules;
- merged-cell behavior;
- grid-before/grid-after if present;
- row text summary.

For cells:

- width;
- grid span;
- vertical merge;
- shading;
- borders;
- vertical alignment;
- cell margins;
- contained paragraphs/tables.

### 7.1 Repeating-table inference

The analyzer should generate deterministic signals such as:

- first row has bold/colored labels while following rows have similar placeholder patterns;
- multiple body rows have the same structure and formatting;
- body rows contain incremented placeholders such as `_1`, `_2`, `_3`;
- body rows are blank but structurally identical;
- nearby heading contains plural wording;
- column headers look like fields;
- template prose says “one row per ...” or gives a default number of entries.

These signals are passed to the semantic model, which decides whether the rows represent:

- fixed rows;
- sample rows;
- a repeating collection;
- a summary matrix;
- KPI cards;
- a decorative layout table.

The deterministic parser must not decide semantic meaning alone.

---

## 8. Images, drawings, shapes, and visual assets

### 8.1 Embedded raster/vector images

The dedicated ingestion module first inventories every physical media part,
including orphaned `word/media/*` entries. For each drawing that references an
image relationship it then:

1. locate the drawing element in the document part;
2. capture whether it is inline or floating/anchored;
3. extract its relationship ID;
4. resolve the relationship through the part’s `.rels` file;
5. locate the media part;
6. copy the binary bytes byte-for-byte to template asset storage once per media part;
7. hash the bytes;
8. record the original part path and relationship;
9. record displayed extent/crop/position metadata where present.

Suggested physical asset and usage models:

```ts
interface TemplateAsset {
  assetId: string;
  assetType: "image" | "chart" | "embedded_object" | "other";
  packagePartPath: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  storageObjectPath: string;
}

interface TemplateAssetUsage {
  usageId: string;
  assetId?: string; // absent for a dangling reference
  sourcePartPath: string;
  relationshipId?: string;
  elementId?: string;
  relationshipStatus: "resolved" | "external" | "dangling" | "orphaned";
  placement: Record<string, unknown>;
}
```

One image used in several headers produces one asset and several usages. Static
images remain in the immutable source DOCX; extraction does not remove or
rewrite them.

### 8.2 Image placement

For a drawing capture, when available:

- inline vs anchored;
- X/Y offset;
- horizontal reference frame (page, margin, column, character, etc.);
- vertical reference frame;
- width/height extent;
- rotation;
- crop/source rectangle;
- text wrapping mode;
- overlap/behind-text behavior;
- z-order-related metadata;
- alternate text/title/description;
- containing paragraph/cell.

This metadata is useful for analysis, but **static images should normally remain untouched in the original template package**.

### 8.3 Static vs replaceable images

The semantic model classifies each image as one of:

- `preserve_static` — logo/background/design element remains unchanged;
- `replaceable_image_slot` — placeholder/example image should be replaced by generated/user-supplied image;
- `content_image` — image is part of template instruction/reference content;
- `unknown` — requires review.

For a replaceable slot, preserve the original drawing geometry and replace only the referenced media/content when possible.

### 8.4 Shapes and text boxes

Not everything that looks like an image is a media file. Word can represent visual objects as DrawingML/VML shapes, text boxes, shaded cells, borders, or groups.

The analyzer should:

- inventory supported drawing/shape elements;
- record their anchor and containing paragraph;
- extract text from text boxes where possible;
- avoid flattening shapes into images;
- mark unsupported/complex drawing types for preservation-only behavior.

The safe default is **preserve unknown visual XML unchanged**.

---

## 9. Explicit, descriptive, and implicit template bindings

The analyzer must support three classes of template intent.

### 9.1 Explicit bindings

Examples:

```text
{{municipality_name}}
{{report_period}}
{{initiative_1}}
```

The deterministic parser finds brace-delimited expressions across run boundaries and reports them to the model.

The model normalizes them into field definitions.

### 9.2 Descriptive/instructional bindings

Examples:

```text
{{2–4 sentence executive narrative: principal accomplishments, emerging issues, material changes, and management focus.}}
```

or plain text without braces:

```text
Provide a concise explanation of the project and the principal issue requiring management attention.
```

The semantic model decides that the text is an instruction rather than final content and creates a field such as:

```json
{
  "fieldId": "town_manager_summary",
  "type": "rich_text",
  "targetElementId": "p_000142",
  "operation": "replace_content",
  "instruction": "Write 2–4 sentences covering principal accomplishments, emerging issues, material changes, and next-period management focus."
}
```

### 9.3 Implicit bindings

Examples:

- heading followed by an empty shaded box;
- a table header followed by several blank rows;
- an empty image frame under “Project Photo”;
- “Notes” heading followed by an empty formatted paragraph.

These are more ambiguous and must receive lower confidence unless visual/structural evidence is strong.

---

## 10. Blueprint semantic concepts

The blueprint should describe dynamic content using a small, controlled vocabulary.

### 10.1 Field types

Recommended initial types:

- `text`
- `rich_text`
- `markdown_block`
- `integer`
- `decimal`
- `currency`
- `percentage`
- `date`
- `datetime`
- `status`
- `boolean`
- `image`
- `chart_image`
- `hyperlink`
- `source_reference`

### 10.2 Structural binding types

- `scalar`
- `repeating_table_rows`
- `repeating_block`
- `optional_block`
- `image_slot`
- `chart_slot`
- `computed_summary`
- `static_preserve`

### 10.3 Render operations

The blueprint should authorize explicit operations rather than freeform document editing:

- `replace_text`
- `replace_content`
- `replace_cell_content`
- `repeat_row`
- `repeat_row_group`
- `repeat_block`
- `remove_prototype_rows`
- `remove_block_if_empty`
- `replace_image`
- `insert_image`
- `insert_chart_image`
- `set_hyperlink`
- `set_status_text`
- `set_status_style_from_map`
- `preserve`

A future version can add advanced operations, but v1 should remain deliberately constrained.

---

## 11. Recommended Blueprint schema

The blueprint should be stored as versioned JSON.

A practical high-level shape:

```json
{
  "blueprintSchemaVersion": "1.0",
  "template": {
    "templateId": "uuid",
    "templateVersionId": "uuid",
    "templateSha256": "...",
    "fileName": "Town_Manager_Template.docx",
    "createdAt": "..."
  },
  "analysis": {
    "analyzerVersion": "1.0.0",
    "modelProvider": "...",
    "modelName": "...",
    "visualAnalysisUsed": true,
    "overallConfidence": 0.94,
    "reviewStatus": "approved"
  },
  "package": {
    "parts": [],
    "relationships": []
  },
  "sections": [],
  "elements": [],
  "assets": [],
  "fields": [],
  "collections": [],
  "blocks": [],
  "styleMaps": [],
  "validationRules": [],
  "generationInstructions": {
    "systemRules": [],
    "fieldInstructions": [],
    "nullPolicy": "Not Available from Source"
  },
  "warnings": []
}
```

### 11.1 Field definition

```ts
interface BlueprintField {
  fieldId: string;
  label?: string;
  dataType: string;
  bindingType: "scalar" | "image_slot" | "chart_slot" | "computed_summary";
  target: BlueprintTarget;
  operation: string;
  instruction?: string;
  required?: boolean;
  nullBehavior?: {
    mode: "blank" | "literal" | "remove_block" | "error";
    literal?: string;
  };
  evidenceRequired?: boolean;
  sourceTraceRequired?: boolean;
  formattingHint?: Record<string, unknown>;
  confidence: number;
  inferredBy: "explicit_placeholder" | "semantic_model" | "heuristic" | "human";
  reviewRequired: boolean;
}
```

### 11.2 Collection definition

```ts
interface BlueprintCollection {
  collectionId: string;
  label?: string;
  targetTableId?: string;
  targetBlockId?: string;
  operation: "repeat_row" | "repeat_row_group" | "repeat_block";
  prototypeElementIds: string[];
  fields: Array<{
    fieldId: string;
    relativeTarget: string;
    dataType: string;
    instruction?: string;
  }>;
  minItems?: number;
  maxItems?: number;
  emptyBehavior: "remove" | "keep_empty" | "message";
  emptyMessage?: string;
  sortInstruction?: string;
  confidence: number;
  reviewRequired: boolean;
}
```

### 11.3 Target definition

```ts
interface BlueprintTarget {
  partPath: string;
  elementId: string;
  subElementId?: string;
  prototypeElementId?: string;
  expectedFingerprint: string;
}
```

The expected fingerprint is a guard against applying the blueprint to the wrong template bytes.

---

## 12. Vision / reasoning model stage

The model stage exists to determine **meaning and intent**, not to locate XML by itself.

### 12.1 Inputs to the model

The model should receive a compact analysis bundle containing:

1. document metadata;
2. section summaries;
3. structural tree with stable element IDs;
4. logical paragraph text;
5. table summaries with rows/cells/format cues;
6. explicit placeholder detections;
7. image/drawing inventory with asset IDs and placement summaries;
8. asset-usage graph covering every relationship/drawing occurrence;
9. nearby headings/captions;
10. deterministic heuristic suggestions;
11. the versioned Template Configuration analysis instructions;
12. rendered page images, if available;
13. page-to-element mapping if available;
14. blueprint JSON schema/output rules.

Do **not** dump the complete unfiltered XML into the prompt unless needed for a difficult localized case.

### 12.2 Visual page rendering

Rendered page images are strongly recommended because they help the model distinguish:

- decorative tables from data tables;
- KPI cards from normal tabular data;
- instructions from final visible copy;
- chart/image placeholders;
- page branding;
- proximity/visual grouping;
- left/right/top/bottom layout relationships.

The core analyzer can function without a page renderer, but confidence on visually implied/implicit bindings will be lower.

A render service may use LibreOffice headless or another compatible DOCX renderer. This rendering dependency is **for analysis/QA only** and is not required by the final DOCX generation engine.

### 12.3 Vision model responsibilities

The model must:

- classify each major element as static, instructional, dynamic, repeating, optional, or unknown;
- normalize explicit placeholders into semantic field names;
- infer fields from descriptive instructions;
- infer repeating collections from sample/blank rows;
- identify prototype rows/blocks;
- identify image and chart slots;
- determine field instructions;
- identify null/empty behavior when specified in the template;
- extract local business rules stated in the template;
- identify sections that should be suppressed from the generated output, such as implementation notes meant only for developers;
- assign confidence;
- request review when uncertain.

The model must **not**:

- fabricate element IDs;
- change physical layout itself;
- invent data that is not in the template;
- assume a fixed report schema across templates;
- convert every blank area into a dynamic field;
- classify decorative design objects as data slots without evidence.

---

## 13. Recommended analyzer-model system instruction

The actual model prompt can be stored/versioned as application configuration. A recommended starting instruction is:

```text
You are the semantic compiler for Microsoft Word document templates.

You will receive:
1. a deterministic structural representation of a DOCX document;
2. stable element IDs created by deterministic template ingestion;
3. text and table summaries;
4. image/drawing metadata and extracted asset identifiers;
5. asset-usage summaries from deterministic ingestion;
6. the versioned Template Configuration analysis instructions;
7. optionally rendered page images showing the visual layout.

Your task is to create a semantic Template Blueprint. The original DOCX is the physical source of truth for appearance and will be preserved during generation. Do not attempt to recreate the document or emit Word XML.

For every potentially dynamic region determine whether it is:
- a scalar field;
- a natural-language content instruction;
- a repeating table row or row group;
- a repeating document block;
- an optional block;
- a replaceable image slot;
- a chart slot;
- static content that must be preserved;
- or uncertain and requiring human review.

Use only element IDs that are present in the supplied structural representation. Never invent a physical target.

When an element contains an instruction such as “write a 2–4 sentence summary,” preserve the instruction in the blueprint and assign a concise semantic field ID.

When multiple sample rows have equivalent formatting/structure and appear to represent records, identify the correct prototype row(s) and define a repeating collection. The number of sample rows must not be interpreted as the required final number of records unless the template explicitly says it is fixed.

Treat layout and branding elements conservatively. Static images, shapes, headers, footers, shading, borders, and page settings should normally be preserved unchanged.

For image placeholders, distinguish between a static image and an image intended to be replaced. Preserve the original placement geometry unless the template explicitly indicates otherwise.

Return only JSON conforming to the supplied blueprint semantic-analysis schema. Include confidence for every inferred binding and set reviewRequired=true for ambiguous cases.
```

### 13.1 Model output should be semantic-only

The model should return something like:

```json
{
  "fields": [
    {
      "fieldId": "town_manager_summary",
      "elementId": "p_000142",
      "dataType": "rich_text",
      "operation": "replace_content",
      "instruction": "Write 2–4 sentences covering accomplishments, emerging issues, material changes, and next-period management focus.",
      "confidence": 0.98,
      "reviewRequired": false
    }
  ],
  "collections": [
    {
      "collectionId": "priority_initiatives",
      "tableElementId": "tbl_000006",
      "prototypeRowElementIds": ["tr_000042"],
      "operation": "repeat_row",
      "confidence": 0.99,
      "reviewRequired": false
    }
  ],
  "assets": [],
  "staticElements": [],
  "warnings": []
}
```

The application then validates every referenced element ID against the deterministic structure before accepting the model result.

---

## 14. Deterministic heuristics supplied to the model

The parser should compute hints, not final decisions.

Recommended hints include:

### Placeholder hints

- brace expressions `{{...}}`;
- angle/square-bracket placeholder patterns if configured;
- Word content controls with tags/titles;
- merge fields;
- repeated placeholder naming patterns.

### Instruction hints

Text that contains phrases such as:

- “provide...”;
- “insert...”;
- “describe...”;
- “summarize...”;
- “1–2 bullets...”;
- “date / milestone”;
- “owner / next step”;
- choice syntax such as `open | decided`;
- type syntax such as `L/M/H`.

These are only hints because final templates may legitimately contain that language as final content.

### Repeater hints

- structurally identical consecutive table rows;
- numbered placeholders;
- plural section heading;
- repeated field pattern;
- same cell shading/borders across rows;
- blank body rows after one example row;
- implementation text indicating “one row per...”;
- prototype blocks separated by headings/page breaks.

### Static design hints

- header/footer objects;
- repeated branding elements;
- small text in page margins;
- decorative shapes with no editable instruction;
- table rows whose only purpose is spacing/color.

---

## 15. Merge and validation stage

After the model responds:

1. validate JSON syntax/schema;
2. verify every element ID exists;
3. verify every prototype row belongs to the stated table;
4. verify target operations are legal for the target element type;
5. reject overlapping destructive bindings unless explicitly allowed;
6. ensure static and dynamic classifications do not conflict;
7. recompute overall confidence;
8. create review warnings;
9. produce a normalized Blueprint Draft.

### 15.1 Confidence policy

Suggested defaults:

- `>= 0.90`: auto-acceptable if no structural conflict;
- `0.70–0.899`: approve only if policy allows; otherwise review;
- `< 0.70`: review required;
- any destructive ambiguous operation: review required regardless of score.

Confidence policy must be configurable.

---

## 16. Human review interface

A practical review screen should show:

- rendered page preview;
- highlighted dynamic regions;
- field/collection name;
- generated instruction;
- proposed operation;
- prototype row/block;
- confidence;
- extracted image assets;
- warnings;
- ability to mark static/dynamic;
- ability to rename fields;
- ability to change collection boundaries;
- ability to approve the blueprint.

The reviewer is editing blueprint metadata, not the DOCX XML.

Approved manual corrections must take precedence over future model suggestions for that exact template version.

---

## 17. Storage model

The Template Analyzer should use storage separate from generated report output.

Recommended objects/tables:

### `document_template_groups`

First-class container and dynamic model tool. One group contains many
templates. See the catalog/group-tool specification for the tool, search,
access, and binding fields.

### `document_templates`

Logical template identity.

Suggested columns:

- `id` UUID;
- `tenant_id`;
- required `template_group_id`;
- `title`;
- detailed `description`;
- generated `title_normalized`;
- generated `title_search`;
- `description_sha256`;
- `description_embedding_status`;
- the `document_template_active_versions` mapping;
- `enabled`;
- `deleted_at`;
- `created_at`;
- `created_by`;
- `metadata` JSONB.

The template identity and catalog metadata are created before analysis. The
analyzer may propose improvements to the title or description, but a model
cannot silently move the template to another group.

### `document_template_description_embeddings`

One active catalog vector per template, produced from the versioned canonical
title/description text. It stores provider, model, dimensions, source-format
version, source SHA, vector, and timestamps. It is separate from document RAG
embeddings and is used only by the containing Template Group's search tool.

### `document_template_versions`

Immutable uploaded template version.

Suggested columns:

- `id` UUID;
- `template_id`;
- `version_number`;
- `file_name`;
- `mime_type`;
- `bucket`;
- `storage_path`;
- `byte_size`;
- `sha256`;
- `configuration_id`;
- `configuration_sha256`;
- `ingestion_status`;
- `ingestion_manifest_json`;
- `ingestion_manifest_sha256`;
- `package_manifest_sha256`;
- `asset_manifest_sha256`;
- `structure_sha256`;
- `analysis_status`;
- `created_at`;
- `metadata`.

### `document_template_configurations`

Versioned, reviewable instructions for deterministic ingestion, semantic
analysis, and renderer defaults. One revision is active per template, and every
version snapshots the exact configuration ID and SHA used to ingest it.

### `document_template_blueprints`

- `id` UUID;
- `template_version_id`;
- `blueprint_schema_version`;
- `blueprint_json` JSONB;
- `analyzer_version`;
- `model_provider`;
- `model_name`;
- `overall_confidence`;
- `review_status` (`draft`, `needs_review`, `approved`, `rejected`);
- `approved_by`;
- `approved_at`;
- `created_at`.

### `document_template_assets`

- `id` UUID;
- `template_version_id`;
- `package_part_path`;
- `safe_file_name`;
- `asset_type`;
- `mime_type`;
- `bucket`;
- `storage_path`;
- `byte_size`;
- `sha256`;
- image dimensions and safe metadata JSONB.

### `document_template_asset_usages`

One row per drawing/relationship occurrence, separate from the stored physical
asset. Suggested fields include source part path, relationship ID, stable
element ID, usage kind, relationship status, nullable asset ID for dangling
references, and placement JSON.

### Storage bucket

Recommended private bucket:

```text
document-templates
```

Example paths:

```text
templates/{tenantId}/{templateId}/configuration/revisions/{configurationId}.json
templates/{tenantId}/{templateId}/versions/{versionId}/source/template.docx
templates/{tenantId}/{templateId}/versions/{versionId}/manifests/package-manifest.json
templates/{tenantId}/{templateId}/versions/{versionId}/manifests/asset-manifest.json
templates/{tenantId}/{templateId}/versions/{versionId}/structure/document-structure.json
templates/{tenantId}/{templateId}/versions/{versionId}/assets/{assetId}/{safeFileName}
templates/{tenantId}/{templateId}/versions/{versionId}/previews/pages/page-0001.png
```

Blueprint JSON can remain in the database and optionally also be archived as a storage object.

---

## 18. Standalone analyzer tool contract

Recommended model/tool-facing name:

```text
analyze_document_template
```

This tool is separate from `write_file` and from report generation.

### 18.1 Analyze command

The command references a stored immutable version. The runtime verifies that
the version belongs to the template, that the template has a group in the same
tenant, and that the caller can write that group before reading any bytes.

```json
{
  "tool": "analyze_document_template",
  "command": "analyze",
  "templateId": "uuid",
  "templateVersionId": "uuid",
  "options": {
    "useVision": true,
    "requireReviewBelowConfidence": 0.9
  }
}
```

### 18.2 Tool result

```json
{
  "success": true,
  "templateGroupId": "uuid",
  "templateId": "uuid",
  "templateVersionId": "uuid",
  "blueprintId": "uuid",
  "status": "needs_review",
  "overallConfidence": 0.94,
  "counts": {
    "sections": 4,
    "tables": 51,
    "fields": 38,
    "collections": 11,
    "assets": 0,
    "warnings": 3
  }
}
```

### 18.3 Optional supporting commands

Useful administrative/API commands may include:

- `get_blueprint`;
- `validate_blueprint`;
- `approve_blueprint`;
- `reanalyze`;
- `create_new_version`.

Approval should normally be an application/admin action rather than left solely to an LLM.

---

## 19. Ingestion And Analyzer State Machines

Recommended statuses:

```text
uploaded
  ↓
validating_package
  ↓
inventorying_parts
  ↓
resolving_relationships
  ↓
extracting_assets
  ↓
extracting_structure
  ↓
persisting_manifest
  ↓
ingested | failed

ingested
  ↓
rendering_preview       (optional)
  ↓
semantic_analysis
  ↓
merging
  ↓
validating_blueprint
  ↓
needs_review | approved | failed
```

Deterministic ingestion and semantic analysis use separate jobs and durable
event journals so either side can be retried without repeating or hiding the
other.

---

## 20. Package safety and security

Treat uploaded Office packages as untrusted input.

Minimum controls:

- maximum upload size;
- maximum decompressed size;
- maximum ZIP entry count;
- reject path traversal/ZIP-slip paths;
- bounded XML sizes;
- disallow external entity processing in XML parsers;
- detect encrypted/password-protected files and return an unsupported error;
- inventory external relationships;
- do not automatically fetch external linked resources;
- preserve but do not execute macros/embedded executable content;
- optionally reject macro-enabled formats for v1;
- malware scanning if required by deployment policy;
- tenant isolation for templates/assets;
- private storage only;
- hash every immutable template version.

For v1, support `.docx` only. Treat `.docm`, legacy `.doc`, password-protected documents, and malformed packages as unsupported unless explicitly implemented later.

---

## 21. XML parser implementation guidance

For the existing TypeScript/Node/Railway stack, the implementation can use:

- a ZIP package library to read/write package entries;
- an XML parser/builder that preserves namespaces, attributes, mixed text, and child order;
- custom WordprocessingML traversal logic;
- schema/type guards for the normalized internal representation.

A critical requirement is **round-trip preservation**. Avoid a parser configuration that discards unknown elements, namespace prefixes, element order, or attributes that the renderer may later need.

One safe architecture is:

1. retain original XML bytes for every package part;
2. create a normalized read-only analysis tree separately;
3. never serialize the normalized analysis tree back into the DOCX;
4. during rendering, mutate a fresh copy of the original XML DOM/package only at explicitly targeted elements.

This prevents the analyzer from accidentally normalizing or deleting Word XML that it does not understand.

---

## 22. Preview rendering and LibreOffice

LibreOffice is **optional**.

### Analyzer

Template ingestion does not depend on a renderer. The worker opens the DOCX ZIP
package and provides the model with readable OOXML, relationships, structure,
and original image assets through the fixed Template Ingestion tool contract.

A renderer may be added later as a separate preview or visual-QA tool. It is not
part of the Template Ingestion model settings and does not change the package
extraction contract.

### Final document generation

LibreOffice is **not required to create DOCX**. The later renderer starts from the DOCX package, performs controlled Open XML mutations, and produces valid DOCX bytes directly.

LibreOffice can optionally be used later for:

- DOCX → PDF;
- visual QA;
- pagination inspection;
- detecting obvious rendering failures.

---

## 23. Validation requirements for the compiled blueprint

Before a blueprint is approved:

- original template hash matches the stored template version;
- all target parts exist;
- all element IDs exist;
- all prototype rows/blocks exist;
- no destructive target overlaps unless explicitly supported;
- all field IDs are unique;
- all collection IDs are unique;
- all relative collection bindings resolve inside their prototypes;
- image slots reference valid drawing/media structures;
- static assets are recorded/preserved;
- required instructions are non-empty;
- confidence/review flags are resolved per policy;
- blueprint JSON passes schema validation.

---

## 24. Acceptance tests

### 24.1 Package parsing

- opens a normal DOCX;
- rejects corrupt ZIP;
- rejects encrypted DOCX;
- detects all package parts;
- resolves internal relationships;
- does not fetch external relationships.

### 24.2 Text

- placeholder in one run;
- placeholder split over multiple runs;
- instruction split over multiple runs;
- styled mixed text;
- hidden text does not contaminate visible logical text unless configured.

### 24.3 Tables

- normal table;
- merged cells;
- nested table;
- repeating header row;
- fixed-width vs autofit;
- blank prototype rows;
- sample rows with `_1`, `_2`, `_3` placeholders;
- multi-row prototype group.

### 24.4 Sections

- portrait;
- landscape;
- mixed orientation;
- different headers/footers per section;
- section breaks.

### 24.5 Images

- inline PNG;
- floating JPEG;
- image in table cell;
- image in header;
- same image referenced more than once;
- replaceable image slot;
- static branding image;
- missing relationship handled as validation error.

### 24.6 Semantic analysis

- explicit placeholder becomes field;
- natural-language instruction becomes field;
- repeated sample rows become collection;
- static decorative table is not incorrectly classified as data;
- ambiguous blank region becomes review-required rather than forced binding.

### 24.7 Version safety

- blueprint for Template v1 refuses to render against changed Template v2 bytes;
- new template upload creates a new immutable version and triggers analysis.

---

## 25. Fincentiv template as the initial reference case

The provided `Fincentiv_Town_Manager_Report_Template_v1.docx` is an excellent acceptance fixture because it contains both explicit placeholders and semantic instructions.

A direct package inspection of this file shows:

- 51 Word tables;
- 4 Word sections;
- a mixture of portrait and landscape sections;
- four header parts and four footer parts;
- 519 `{{...}}` placeholder occurrences;
- 147 distinct placeholder strings;
- no embedded `word/media/*` assets in this particular version;
- no Word content controls (`w:sdt`) in this particular version.

Examples the analyzer should identify include:

- scalar metadata such as municipality/report dates;
- natural-language instruction fields such as the Town Manager Summary;
- priority initiative tables whose displayed sample row count is not the true data limit;
- the “Priority Initiative Detail — Repeating Block” section;
- funding/grant collection tables;
- risk/dependency/decision tables;
- forward-calendar repeating rows;
- evidence/source register rows;
- developer/implementation sections that may need to be excluded from a Council-facing generated document depending on blueprint policy.

This template should be used as one integration test, not as a hard-coded schema.

---

## 26. Suggested implementation phases

### Phase 1 — deterministic package compiler

Implement:

- Template Configuration and typed ingestion-instruction schemas;
- DOCX validation;
- package inventory;
- relationship graph;
- byte-preserving media extraction and storage outputs;
- asset-usage graph including headers, footers, orphaned media, and dangling references;
- main-document/header/footer parsing;
- sections;
- paragraphs/runs/logical text;
- tables;
- placeholders;
- stable element IDs;
- ingestion manifest and heuristic skeleton.

### Phase 2 — semantic model

Add:

- compact structure serialization;
- multimodal prompt contract;
- field/collection inference;
- confidence;
- blueprint merge/validation.

### Phase 3 — richer layout and vision

Add:

- image-slot inference;
- chart/drawing inventory;
- preview page rendering.

### Phase 4 — review UI

Add:

- page overlays;
- binding editor;
- approve/reject;
- versioning.

### Phase 5 — advanced Word features

As needed:

- content controls;
- charts;
- legacy VML;
- text boxes;
- footnotes/endnotes;
- tracked changes policies;
- custom XML;
- advanced fields.

---

## 27. Reference pseudocode

```ts
async function analyzeTemplate(input: AnalyzeTemplateRequest) {
  const ingestion = await loadCompletedTemplateIngestion({
    templateId: input.templateId,
    templateVersionId: input.templateVersionId,
  });
  assertIngestionHashes(ingestion);

  const {
    templateHash,
    structure,
    assets,
    assetUsages,
    heuristics,
    configuration,
  } = ingestion;

  let previews = [];
  if (input.options.useVision) {
    previews = await optionalRenderTemplatePages(ingestion.sourceBytes);
  }

  const semanticResult = await runTemplateSemanticModel({
    structure: compactForModel(structure),
    assets: compactAssetsForModel(assets),
    assetUsages: compactAssetUsagesForModel(assetUsages),
    heuristics,
    previews,
    instructions: configuration.analysis.instructions,
  });

  const blueprint = mergeAndValidateBlueprint({
    templateHash,
    structure,
    assets,
    assetUsages,
    semanticResult,
  });

  return await persistBlueprint(blueprint);
}
```

---

## 28. Definition of done

The Template Analyzer v1 is complete when a developer can:

1. upload an arbitrary valid DOCX;
2. snapshot the active Template Configuration and validate a typed ingestion envelope;
3. preserve the source document unchanged in its private template namespace;
4. deterministically enumerate its package, Word structure, and relationships;
5. extract embedded images/assets byte-for-byte and map every usage;
6. identify sections/layout metadata;
7. identify explicit placeholders across run boundaries;
8. gate semantic analysis on completed, hash-verified ingestion artifacts;
9. provide a multimodal model with compact structure, asset usages, instructions, and page visuals;
10. receive field, table, repeater, image-slot, and instruction interpretations;
11. validate every model target against real document elements;
12. create a version-bound schematic Template Blueprint;
13. flag uncertain mappings for review;
14. approve/store the blueprint independently of any report-generation run;
15. reuse that blueprint later without re-analyzing the template.

The output of this service is not the finished report. It is a reliable, versioned contract between an arbitrary Word template and the Agent Document Write / Render Tool.
