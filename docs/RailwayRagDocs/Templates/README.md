# Templates And Document Engine

This folder is the source of truth for first-class document templates, Template
Group discovery tools, template analysis, and deterministic DOCX generation.

## Current Direction

- Templates are not part of Reference Libraries.
- Every template belongs to exactly one Template Group.
- Each Template Group defines one dynamic model tool.
- That tool searches template titles and detailed-description vectors inside its
  own group only.
- Every template has a stable private storage namespace containing its versioned
  configuration, immutable DOCX versions, extracted images, manifests, and
  structural data.
- A dedicated typed template-ingestion contract splits DOCX packages; templates
  never enter ordinary document chunking or RAG ingestion.
- Template Ingestion can use any model source exposed by the model-task
  settings: Ollama, OpenAI API, OpenAI OAuth, Modular, Together AI,
  OpenRouter, or Mistral. The package/tool contract is provider-neutral.
- A separate configured embedding model creates the template-description
  vectors after ingestion has generated the description from the DOCX source.
- Approved blueprints and original immutable DOCX versions drive deterministic
  rendering.

## Reading Order

1. [Document Engine overview](document_engine_overview.md)
2. [Template catalog and Template Group tools](template_catalog_and_group_tool_spec.md)
3. [Template DOCX ingestion and storage](template_docx_ingestion_and_storage_spec.md)
4. [Template Analyzer and Blueprint Compiler](document_template_analyzer_blueprint_spec.md)
5. [Agent Document Write and DOCX Render Tool](agent_document_write_render_tool_spec.md)
6. [Phase implementation plan](document_engine_implementation_plan.md)
7. [DOCX template authoring language](template_authoring_language.md)
8. [Template authoring, analysis, versioning, and execution plan](template_execution_plan_spec.md)

The implemented [Task Dataset Phase 6](../TaskDatasets/phase_6_implementation.md)
defines how template ingestion adds validated persistent-data suggestions to
the execution plan. Those suggestions remain inert for standalone Ask and
Extraction and become durable only when a verified saved Task executes the
template against its exact silo/project-or-no-project scope.

Template authors may optionally use a trusted instruction such as
`task-dataset: store grant item data ...`. Ingestion converts it into a
validated suggestion; templates without the hint can still receive suggestions
from retrieval-plan analysis. Saved Task execution—not ingestion or standalone
generation—creates and commits the actual dataset.

Start template authors at [Writing a template](writing_a_template.md) instead.
It covers the same ground as item 7 in plain language, for the person writing
the Word document rather than the person implementing the compiler.

## Reference Fixtures

- `Fincentiv_Town_Manager_Report_Template_v1.docx` — primary placeholder-driven
  analyzer and renderer fixture.
- `sample.docx` — image/header/layout preservation fixture.
- `Fincentiv_Town_Manager_Report_Template_v1_left-border-single-image.docx` —
  negative fixture for dangling image relationships.

The Markdown specifications are authoritative. The DOCX files are test and
design fixtures.

## Runnable ingestion checkpoint

The repository now contains the first testable DOCX ingestion slice:

- durable worker claims, heartbeats, retries, and an ingestion event journal;
- a live Templates-page activity panel that follows the active job stage,
  refreshes every three seconds, shows elapsed time and worker-heartbeat age,
  and distinguishes a healthy run from delayed updates or a likely stalled
  worker;
- ZIP/package safety checks, manifest and relationship inventory, readable
  OOXML parts, content controls, deterministic physical structure, and original
  image extraction with usage mapping;
- the fixed Template Ingestion read/write tool contract for every configured
  provider, including image return from `get_template_asset`;
- task-scoped `sequential_plan` and multi-file `cache_file` tools for planning
  complex ingestion and assembling large JSON artifacts incrementally; a
  completed JSON cache can be passed by name to any `write_template_*` tool;
- six durable ingestion passes covering inventory, deterministic compilation,
  deterministic authoring checks, model structure analysis, model semantic
  review, and plan/correction validation; the Templates page shows each pass,
  timing, review cycle, and convergence state;
- the compiled render contract supplied to the ingestion model as preload and
  through `get_render_contract`, so the quality audit compares author intent
  against the deterministic compiler's reading of the same DOCX instead of
  re-deriving structure from raw OOXML; contract instructions and the comment
  index share the Word comment id, so a finding can name the page and comment
  the author will recognize;
- persisted model-authored structure, content, layout, asset-map, warnings,
  unresolved items, and normalized quality findings with consequences,
  confidence, source references, and multiple alternatives, plus a detailed
  searchable description derived from the DOCX itself;
- a final quality gate that marks a sound template `completed`, or marks it
  `needs_review` only when the audit found a material author-fixable issue;
  review findings identify the saved Word page number when available, source
  location, problem, importance, and a concrete Word edit and appear below the
  selected template in the UI;
- normalized per-version Ignore decisions; ignored findings disappear from the
  active review, and ignoring the final finding promotes that version from
  `needs_review` to `completed`;
- validated Implement alternatives in the Templates UI and API. An accepted
  comment or placeholder edit creates a new immutable DOCX version with parent
  lineage and provenance, records an idempotent action, and automatically runs
  all six passes again. The original remains downloadable;
- stalled/oscillating finding-signature detection and a five-cycle correction
  limit so repeated review cannot silently loop;
- editable template name/description and editable inspection-package
  name/description;
- per-template deletion from a group in the Templates UI and API; deletion
  removes the template from model discovery, cancels queued work, frees its
  catalog name for replacement, and privately retains immutable version history
  for generated-document reproducibility;
- a downloadable ZIP containing the source, extracted images, package data,
  model outputs, configuration, and job journal;
- a direct Download template action for the checksum-verified immutable source
  DOCX, separate from the inspection ZIP;
- separately queued template-description embeddings for group-scoped search;
- explicit description-search messaging: `awaiting_ingestion` is the expected
  state until ingestion has generated the detailed description, after which
  vectorization is queued automatically;
- retry after failure and an explicit Redo action after success, with each new
  job using the current Template Ingestion model settings and global
  instructions against the preserved immutable DOCX;
- editable Template Group names, tool names, and tool descriptions;
- a dedicated Templates Assigned to Silos page plus API-key REST routes for
  listing group IDs, replacing assignments, and removing one assignment;
- assigned Template Group discovery tools in both Ask and Extraction, with
  descriptive model guidance and title/description-vector search paths;
- model-first Ask and Extraction orchestration: the user's request reaches the
  model before document retrieval, and the model chooses focused RAG searches;
- template-driven Ask orchestration: group selection loads the template
  contract first, and the contract's field and collection instructions become
  the research plan for the RAG searches that populate the document;
- exact effective model instructions and resolved Template Group names stored
  in the Ask run trace so tool availability can be audited;
- real generated DOCX packaging as an Ask and Extraction output option;
- a stateful DOCX workspace exposed through `create_document`,
  `inspect_document`, `edit_document`, `copy_template_image`, and
  `finalize_document`, backed by deterministic blank-document and
  template-preserving renderers;
- contract-aware template inspection: `create_document` loads and digest-checks
  the contract up front, `inspect_document` reports the bindings still missing
  with their labels, resolved guidance, and author-supplied searches plus a
  `readyToFinalize` flag, and every `edit_document` result carries the remaining
  required counts; inspection and `finalize_document` share one requirement
  check, so what a run is told is exactly what the render refuses to skip;
- source-hash and contract-digest binding so a model cannot render against a
  different template version than the one it inspected;
- semantic Agent Data for scalar text, formatted paragraphs and headings,
  generated tables, and variable-length repeating template rows;
- preservation of unchanged DOCX package parts, including headers, footers,
  relationships, layout, and existing images, with the final binary stored in
  the normal generated-file system for download.

The template-preserving renderer implements semantic `{{...}}` placeholders,
ordered Word-comment author instructions, author-supplied `rag_search` hints,
optional type/required/empty/collection directives, repeated placeholder rows,
automatic evidence-register population, and final-revision inspection.
Comment instructions are anchor-scoped: a comment carrying a directive governs
only the placeholder, row, or table it is attached to, while a prose-only
comment stays active in document order, so later contradictory guidance wins
for that topic without clearing unrelated earlier rules. An explicit
`scope: binding|section|document` overrides the default. Reused placeholder
names receive distinct field IDs only when a comment is aimed at one of the
occurrences, so an unrelated comment between two uses no longer splits them.
Generated files remove the complete comments layer, including anchors,
reference marks, relationships, metadata, and comments package parts.
The deterministic authoring contract and digest-pinned execution plan are
persisted during ingestion and checked against the immutable source before
rendering. Arbitrary conditional regions,
non-table repeating blocks, calculated cell shading, and controlled image-slot
replacement remain later renderer operations. Existing template images are
preserved today.

For a DOCX request whose desired outcome calls for a template, Ask or Extraction
can now follow this runtime order:

1. resolve the Template Groups assigned to the selected silo;
2. give the original request and the resolved group-tool instructions to the
   model without searching the raw request first;
3. call the selected group tool and then `get_template_contract`;
4. open a template workspace with `create_document`;
5. follow useful author-supplied `ragSearchQueries` (or more focused
   equivalents), then use additional focused `rag_search` calls for information
   the model determines is missing, up to the separately configured RAG-search
   limit;
6. populate fields and collections incrementally with `edit_document`, inspect
   the final workspace revision, and call `finalize_document` only after all
   required bindings are populated;
7. let the deterministic renderer preserve the DOCX package and store the
   downloadable result.

An empty rich-text `blocks` array is treated as an explicit blank instead of a
malformed value. Variable-specific guidance such as “keep it blank when not
provided” can make that binding blankable even when the general default is
required. `empty: clear` preserves the blank paragraph and its layout, while
`empty: omit` removes the rich-text slot. A correctable DOCX editor or
finalization error is returned to the model for up to two repair attempts
instead of immediately failing the whole Ask or Extraction run.

Raw-question retrieval is retained only as a fallback when no Ask model is
configured or a non-template model call fails. An explicit template request
never silently falls back to a generic text answer. If no renderable assigned
group exists, the run fails with `template_group_tool_unavailable` and records
the resolved-group diagnostic in its event journal.

Template selection is model-directed rather than questionnaire-gated. Assigned
group names, tool descriptions, and template search behavior are supplied as
capability context. Explicitly asking for a template or naming one is a strong
selection signal; the model may also select a group when the requested outcome
clearly calls for that kind of document. It is instructed not to use templates
merely because they are available for an unrelated task.

DOCX output is never created by wrapping the final answer text. The model must
open and edit a workspace and `finalize_document` must return a persistent file
ID. Blank workspaces support numbered paragraph, heading, table, image, and page
break blocks. Template workspaces support incremental field and collection
updates. `copy_template_image` copies original media bytes into a blank package
and creates the required OOXML relationship. File-edit requests are compacted
before the next model call, so the context retains revision/count/preview state
without repeating the large content the model just wrote.

Long Ask and Extraction jobs use a configurable **Model call timeout** in each
Model Task configuration. The value applies separately to every provider call,
including calls made after a RAG or document-editing tool result; it is not a
deadline for the entire multi-call run. The default is 15 minutes per call and
the supported range is 1-60 minutes. This keeps short tasks bounded while
allowing lengthy template reports to continue through many model/tool turns.

Ask questions and Extraction requests also use the per-task **Max request
characters** setting. Both tasks default to 100,000 characters and allow an
administrator to select 4,000 through 1,000,000. The absolute ceiling is shared
by the portal and public API; the saved Ask and Extraction values are enforced
after the applicable Model Task is loaded.

Vector RAG now defaults to a Top K of 20 across the task configuration, portal
test forms, public silo/library search routes, and model `rag_search` tool
requests. An explicit request or saved task value still takes precedence.
OpenAI OAuth streaming deltas retain their original whitespace so live Thinking
and Response draft bubbles remain readable while those longer runs progress.
