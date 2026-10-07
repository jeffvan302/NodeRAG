# Template Authoring, Analysis, Versioning, and Execution Plan

**Status:** Living implementation specification, reconciled with `main` on
2026-08-24. The ingestion-first six-pass pipeline, normalized review findings,
validated alternatives, **Implement** workflow, immutable derived-version
lineage, convergence controls, and pinned execution plans are implemented.
Rendered before/after visual comparison and the broader comment split/move
operation vocabulary remain future quality gates.

**Audience:** Product owners, template authors, and the engineers implementing
template ingestion, Ask, Extraction, and deterministic DOCX generation.

**North-star outcome:** A person who understands the report but not Open XML,
prompt engineering, retrieval systems, or data binding can prepare a Word
template. Ingestion helps that person remove ambiguity and organize the work.
Once approved, Ask or Extraction should be able to research, populate, and
render the template in one planned run without repeatedly rediscovering what
the template means.

---

## 1. Decisions

1. Word comments are the authoring language for instructions. They never appear
   in a generated document.
2. `{{variable_name}}` remains the visible placeholder language. A variable is
   a semantic hint, not a rigid database-field name.
3. `<<<...>>>` is legacy syntax. New templates must not use it. Older templates
   may retain compatibility long enough to migrate, but ingestion should report
   it and offer to move the guidance into Word comments.
4. Ingestion is a compiler and authoring assistant, not just one model call. It
   may make several deterministic and model-assisted passes over the source.
5. Every finding must be understandable and actionable. When more than one
   correction is reasonable, the author sees more than one recommended change.
6. Selecting **Implement** never mutates an immutable stored source. It creates
   a new DOCX version, records how it was derived, validates it, and ingests
   that version.
7. **Resume incomplete work** uses the current source version and reuses every
   compatible successful model checkpoint. **Redo from start** uses the same
   immutable source but deliberately reruns every model checkpoint. An
   accepted correction is therefore not proposed again merely because either
   kind of analysis was run.
8. Execution order is semantic, not necessarily page order. A detailed section
   on pages 4 and 5 may be populated before a summary on page 2.
9. Search consolidation is optional and conservative. It may reduce duplicate
   retrieval without erasing meaningful differences in entity, date, evidence,
   scope, or intended consumer.
10. A well-authored template should produce a bounded execution plan before the
    final Ask or Extraction model begins. The run may still adapt when evidence
    is missing, but it should not have to reverse-engineer the template.

---

## 2. User Mental Model

The author works with three familiar things:

- normal Word layout, tables, images, headers, footers, and styles;
- visible placeholders such as `{{Town Name}}` or `{{grant_status}}`;
- Word comments that explain what a placeholder or section means and, when
  useful, give directives such as `rag_search:`, `scope:`, `collection:`,
  `max_rows:`, `required:`, `empty:`, or `synthesizes:`.

The system owns the technical layer:

- DOCX package inspection and validation;
- stable identities for instructions, fields, collections, assets, and
  segments;
- comment scope and supersession;
- retrieval planning and dependency ordering;
- correction suggestions and safe DOCX rewriting;
- immutable version history;
- deterministic rendering and removal of the comments layer.

The UI should say what will happen in document language. For example, “Fill
the grant detail table before writing the executive summary” is preferable to
“topological edge from segment 008 to segment 003.”

---

## 3. Source, Version, Contract, and Run

These are different objects and must remain separate.

### 3.1 Template

The catalog item inside one Template Group. Its editable name and searchable
description identify the kind of document a model may select.

### 3.2 Template source version

One immutable DOCX plus its checksum, stored package data, extracted assets,
analysis, configuration snapshot, and ingestion result. A correction creates a
new source version; it does not overwrite this one.

### 3.3 Compiled render contract

The deterministic interpretation of one source version: comments,
placeholders, fields, collections, evidence tables, instructions, layout
anchors, and stable IDs. Its digest pins all later planning and rendering to
the exact source interpretation.

### 3.4 Authoring report

Findings about how the source will behave, plus zero or more implementable
alternatives. Deterministic findings state facts the compiler knows. Model-led
findings may identify semantic ambiguity, missing dependencies, or inefficient
searches, but remain proposals until an author accepts them.

### 3.5 Execution plan

The ordered set of document segments, their dependencies, and the retrieval
queries that serve them. It is derived from the current compiled contract and
therefore cannot silently drift from the template.

### 3.6 Generation run

One Ask or Extraction execution against a pinned template version and contract
digest. The model researches and writes semantic values; the deterministic
renderer applies those values to the preserved DOCX package.

---

## 4. Word Comment Semantics

### 4.1 Comments are instructions, not output

All Word comments are supplied to ingestion and generation as author guidance.
The output DOCX removes comment text, anchors, reference marks, relationships,
metadata, and comment package parts. Removing comments must not leave empty
paragraphs or line returns that alter layout.

### 4.2 Scope and supersession

Comments are read in document order as topic-specific state.

- A later instruction about the same topic supersedes the earlier instruction.
- An unrelated later instruction does not erase prior state.
- A comment anchored to a placeholder, row, or table governs that binding by
  default.
- Prose-only guidance may continue in document order.
- `scope: binding|section|document` overrides the default.
- `scope: section` ends at the next reliable section boundary. When headings
  are unavailable, the next governing comment is the safe fallback.

Reused placeholder text can therefore have different meanings in different
sections without forcing authors to invent globally unique names.

### 4.3 Placeholders

`{{Town Name}}`, `{{municipality}}`, and `{{township_name}}` are descriptions of
the intended value, not exact keys that must exist in source material. Nearby
comments provide the authoritative local meaning. Numeric suffixes used to
show repeated rows are normalized where the structure demonstrates repetition;
they are not treated as a strict numbering contract.

### 4.4 Author directives

The current authoring language is documented in
[DOCX template authoring language](template_authoring_language.md) and its
plain-language companion [Writing a template](writing_a_template.md). Important
planning directives include:

- `rag_search:` — a useful query or research intent;
- `synthesizes:` — field or collection IDs that must be prepared before this
  section is written;
- `scope: section` — keep the instruction local to a section;
- `max_rows:` — bound a collection when later synthesis reads the result;
- `required:` and `empty:` — say what may be blank and how it disappears;
- `collection:` and `evidence_register:` — declare repeating or source-list
  behavior.

Free-form prose remains valid. Directives add precision; they do not require a
nontechnical author to learn a programming language.

---

## 5. Multi-Pass Ingestion and Authoring Review

The passes below are logical stages. The deployed runtime presents six
top-level passes: `package_inventory`, `deterministic_compilation`,
`deterministic_review`, model analysis, `semantic_review`, and
`plan_validation`. Model analysis is now four bounded, sequential provider
calls persisted as `model_analysis_structure`, `model_analysis_content`,
`model_analysis_layout`, and `model_analysis_asset_map`. The UI groups those
records beneath one Pass 4 row while showing the exact call that is queued,
running, completed, reused, or failed. Human decisions and re-ingestion happen
between six-pass runs rather than pretending to be model passes.

Pass 5 also consists of independently persisted model checkpoints: placeholder
meaning/comment scope, dependency/execution order, RAG retrieval planning,
layout/asset safety, and cross-feature synthesis. The first four may run in
parallel. Synthesis begins after they settle and uses every successful report.
A normal resume reruns only failed or incompatible checkpoints; a full redo
bypasses checkpoint reuse. Each focused review is instructed to keep evidence
reads bounded and finalize a smaller well-supported report rather than consume
its entire tool allowance.

### Pass 0 — Package inventory and integrity

1. Verify the DOCX ZIP, paths, part sizes, relationships, and checksums.
2. Preserve the immutable source.
3. Inventory comments, comment anchors, visible text, placeholders, content
   controls, tables, images, headers, footers, styles, sections, and page map.
4. Extract reusable images and their relationship/usage locations.
5. Fail clearly when the source is malformed; never silently repair the only
   stored copy.

### Pass 1 — Deterministic compilation

1. Parse every Word comment in document order.
2. Resolve directive state and comment scope.
3. Compile fields, collections, evidence registers, and stable identities.
4. Segment the document by the nearest governing comment.
5. Preserve the guidance once by instruction ID rather than repeating prose on
   every field.
6. Produce the contract digest used by later passes and generation.

### Pass 2 — Deterministic authoring checks

Report only things the compiler can prove, including:

- an unanchored or empty comment;
- a directive referring to an unknown field or collection;
- a dependency cycle;
- a section that will run earlier or later because of an authored dependency;
- contradictory values for the same directive topic;
- guidance whose effective scope is broader than its placement suggests;
- an unbounded collection that feeds a later summary;
- identical `rag_search` guidance repeated in multiple comments;
- legacy instruction markers or other authoring syntax that will not behave as
  the author expects.

These checks are deterministic, reproducible, and testable without a model.

### Pass 3 — Focused model-assisted semantic review

Before the semantic authoring review, deployed Pass 4 prepares the reusable
core artifacts in four isolated calls:

1. **Structure** — sections, blocks, tables, repeating regions, controls, and
   dependencies.
2. **Content and bindings** — fixed content, semantic placeholders,
   collections, instruction scope, and evidence requirements.
3. **Layout** — sections, pages, styles, positioning, table geometry, sizing,
   and preservation rules.
4. **Assets and catalog finalization** — image/media roles and anchors, followed
   by the source-derived catalog description and atomic finalization using the
   three previously stored artifacts.

Each call receives only its own artifact writer plus the bounded DOCX read,
planning, and cache tools. A successful call is durable and can be reused when
a later call fails and ingestion is retried against the unchanged source,
contract, model configuration, and instructions. This keeps the core analysis
mandatory while avoiding one long session that can lose all four artifacts at
the finalization boundary.

Each focused artifact call also has one fresh, step-local retry. The retry is
used for an interrupted provider connection, timeout, transient provider
failure, or a model turn that ends without writing its assigned artifact. It
does not repeat earlier successful calls and it does not retry deterministic
configuration failures such as exhausting the configured tool-request limit.
The live status names the call, retry attempt, and reason. If the second attempt
still does not finish, the saved pass and job error include provider tool-call
and continuation telemetry so the failure is actionable rather than merely
reported as incomplete.

Use the configured Template Ingestion provider, model, reasoning effort,
instructions, timeout, and tool allowance directly. This is not the general
Ask/Extraction Swarm and does not depend on Swarm Configuration.

Start four isolated model calls in parallel. Each call receives the compiled
contract, page map, comment index, structural summaries, and the same bounded
DOCX read tools, but it receives exactly one review objective:

1. Placeholder meaning, approximate variable naming, reused variables, and
   stateful Word-comment scope.
2. Dependencies, repeating collections, calculations, summaries, and required
   segment execution order.
3. RAG-search completeness, evidence needs, duplicate searches, safe
   retrieval consolidation, and zero or more bounded saved-Task-only
   persistent-data suggestions for repeated stable retrieval.
4. Layout and asset safety, including tables, repeating rows, comment removal,
   images, logos, and page-local anchors.

After those calls settle, make one fifth, bounded model call. Give it only the
four finalized specialist reports plus the normal read tools. Its job is to
identify cross-feature problems that require evidence from at least two review
areas. It must not reproduce an isolated specialist finding. The application
then merges and deduplicates the specialist and synthesis findings before the
existing deterministic source/page/edit validation.

This five-call review can identify material author-fixable problems such as:

- one placeholder or visible heading contradicting its comment;
- a reused variable whose local meaning cannot be resolved confidently;
- detailed sections that should precede an earlier summary;
- two searches that are semantically redundant or one that is too broad;
- instructions that should be section-scoped;
- a missing instruction for a visually repeated table or calculation;
- a suggested edit that would damage the layout or remove required static
  content.

Every call must use the saved Word page map. It must return no page number
rather than guessing. It should emit no finding when its assigned area is
sound. A model finding is advice, not permission to alter the source.

Each call has its own plan, cache workspace, and finalization requirement. A
specialist failure does not discard successful specialist reports. A synthesis
failure does not discard the four earlier reports. Incomplete task names,
runtimes, tool counts, continuation counts, finding counts, and errors are
stored in semantic-pass telemetry. Any incomplete task produces one visible
technical review item so the template cannot silently appear fully reviewed.

If a model turn ends after doing review work but before calling the required
finalization tool, the runtime gives it one bounded low-reasoning continuation
using the same plan, cache files, and already written artifacts. It directs the
model to resume its assigned task rather than repeat the review. If that
continuation still does not finalize, the task is recorded as incomplete and
ingestion continues to `needs_review`; completed deterministic checks, core
artifacts, and other successful reviews are not discarded. Failure of the
earlier core artifact-analysis pass remains fatal because later reporting
cannot safely use an incomplete contract.

### Pass 4 — Plan construction and validation

1. Build the dependency graph from accepted/authored `synthesizes:` edges.
2. Topologically order segments, using document order as the stable tie-break.
3. Detect cycles and fall back to document order until the author resolves
   them.
4. Gather author-supplied searches before generation.
5. Merge exact duplicates deterministically.
6. Let semantic merge candidates appear as authoring suggestions, not silent
   plan mutations.
7. Associate each search with the segments it serves.
8. Reconcile trusted Word-comment `task-dataset:` intent with retrieval-review
   suggestions.
9. Validate dataset schema, identity, policies, exact served bindings, exact
   planned queries, and semantic digest inputs.
10. Persist valid suggestions under `persistentDataPlan`; emit findings and
    omit any unsafe or unbound suggestion.

### Pass 5 — Human decision

The Templates page presents findings beneath the current version. The author
may:

- choose one recommended change and select **Implement**;
- ignore an irrelevant finding;
- open Word and upload a manually corrected document;
- leave a nonblocking note as written;
- redo ingestion after changing model settings or instructions.

Required unresolved findings keep the version in `needs_review`. A version with
no material findings, or with all remaining findings explicitly ignored, may
become `completed`. Approval/activation remains an explicit product decision
when the environment requires it.

### Pass 6 — Apply, version, and re-ingest

For an Implement action:

1. Re-read the selected source version and verify its checksum and contract
   digest.
2. Verify the finding and change ID still exist and that every edit precondition
   still matches.
3. Apply the deterministic OOXML operation to staged bytes.
4. Reopen the staged DOCX, validate relationships and comments, recompile it,
   and check that the targeted finding is resolved.
5. Optionally render before/after page previews and reject unintended layout
   drift outside the affected anchor.
6. Store the result as version `N+1` with its own checksum and a parent link to
   version `N`.
7. Record the accepted alternative, exact operations, actor, time, and before
   and after digests.
8. Queue ingestion for version `N+1` and make it the current candidate only
   after durable storage succeeds.

If any step fails, no version is promoted. The author sees a plain-language
error and the original source remains available.

### Pass 7 — Convergence and completion

Ingest the derived version again. A resolved finding should disappear because
the correction now lives in the DOCX. New findings may appear as the document
becomes clearer. Repeat only when the author chooses another change. A hard
iteration limit protects against a model proposing oscillating edits.

---

## 6. Actionable Suggestion Contract

A single recommendation string is insufficient. The normalized shape should
support alternatives and deterministic implementation:

```ts
type TemplateAuthoringFinding = {
  findingId: string;
  source: "deterministic" | "model";
  kind: string;
  severity: "required" | "recommended" | "note";
  pageNumber: number | null;
  location: string;
  issue: string;
  consequence: string;
  alternatives: TemplateAuthoringAlternative[];
  disposition: "open" | "ignored" | "implemented" | "superseded";
};

type TemplateAuthoringAlternative = {
  changeId: string;
  label: string;
  explanation: string;
  preview: string;
  operations: TemplateSourceEdit[];
  confidence: "deterministic" | "review_required";
};
```

UI behavior:

- Number or otherwise separate multiple alternatives.
- Put an **Implement** button beside each implementable alternative.
- Do not show an Implement button for advice whose safe edit cannot be known.
- Show exactly what will change before confirmation.
- Disable all alternatives while one is being applied.
- After success, show the new version number and ingestion progress.
- Keep **Ignore** separate from **Implement**; ignoring is not a source edit.

The ingestion validator converts deterministic and semantic results into this
normalized shape. The catalog displays the alternatives, and only alternatives
whose staged DOCX recompiles to a changed, valid contract receive an
**Implement** button.

### 6.1 Initial safe operation vocabulary

Already implemented and tested in the DOCX engine:

- `set_line` — add or replace one directive in a named Word comment;
- `remove_line` — remove one directive from a named comment;
- `hoist_lines` — remove repeated directive lines and create a new comment at
  the top of the document containing them.
- `rename_placeholder` — rename exact `{{placeholder}}` occurrences while
  retaining their Word runs and layout; ingestion recompilation is the safety
  precondition.

Next safe operations:

- create a comment at a stable anchor without hoisting existing text;
- split one comment into document and section-scoped guidance;
- move or copy one directive between comments;
- replace prose only when the model supplies an exact old-text precondition and
  the author sees the complete replacement.

Operations that cannot be located by stable IDs and exact preconditions remain
manual recommendations. Page numbers are for people, not edit addressing.

---

## 7. Immutable Version Lineage

The database stores numbered immutable template versions, a separate
active-version pointer, and explicit lineage/provenance for corrections.

Implemented additions:

- `parent_version_id` — nullable for an original upload;
- `source_kind` — upload, implemented correction, or manual replacement;
- `provenance_json`, `derived_from_finding_id`, and
  `derived_from_alternative_id` — the accepted action and exact operations;
- `document_template_review_actions` — the idempotent correction journal;
- `review_cycle`, `finding_signature`, and `convergence_status` — loop and
  stalled-review protection;
- `execution_plan_json` and `contract_digest` — the ingestion-validated plan
  consumed by generation.

The derived source must use a new storage path and version number. The original
download remains available. Resume and Redo from start both retain the same
source version and create a new analysis job; only Resume may reuse compatible
successful model checkpoints. Implement creates new source bytes and therefore
a new source version.

Activation rules:

1. storage and database writes succeed;
2. checksum and DOCX validation succeed;
3. compilation succeeds;
4. re-ingestion reaches the required quality state;
5. the product's approval rule is satisfied;
6. only then update `document_template_active_versions`.

---

## 8. Dependency-Aware Execution

Document order and work order are not always the same.

Example:

```text
Page 2: Executive summary
  synthesizes: grant_portfolio, initiative_updates

Pages 4-5: Grant portfolio details
Pages 6-8: Initiative updates
```

The plan fills pages 4-8 first, then page 2. The DOCX layout stays unchanged;
only the semantic write order changes. The summary step inspects the already
written structured values instead of repeating retrieval or asking the model to
remember a large tool response.

Rules:

- Only accepted or authored dependencies control execution.
- Model-inferred dependencies first appear as suggestions with alternatives,
  such as “Add this dependency” or “Keep document order.”
- Independent segments keep document order.
- Unknown references are findings, not ignored edges.
- Cycles are findings. The run falls back safely rather than inventing an order.
- A plan is pinned to `contractDigest` and cannot be used with another version.
- Large intermediate values stay in the document workspace; later steps inspect
  selected value IDs rather than replaying full content into model context.

---

## 9. Retrieval Planning and Optional Hoisting

The compiler gathers all `rag_search:` directives before generation. This lets
the final run retrieve evidence efficiently and makes it clear which searches
serve which sections.

### 9.1 Safe automatic behavior

- Normalize whitespace and case.
- Merge only identical queries.
- Retain every originating instruction ID and served segment ID.
- Run the combined query once and reuse the result references.

### 9.2 Suggested semantic consolidation

A model may suggest that “progress reports on funds” and “progress reports on
all funds and grants” overlap. It must explain whether the broader query fully
covers the narrower one and whether date/entity constraints differ. The author
chooses whether to consolidate.

### 9.3 Persistent-data suggestions for saved Tasks

The retrieval specialist may propose a bounded `persistentDataPlan` when a
stable record shape repeatedly serves compiled fields or collections. A
trusted Word comment beginning `task-dataset:` is reconciled with that analysis.
The semantic digest covers the data definition and served meaning, not pages,
positions, or segment/instruction sequence IDs.

Every newly ingested suggestion also declares `timeVariance`:

- `static` facts remain covered until an explicit clear/rebuild;
- `period_scoped` facts store normalized period keys for assembly-time
  filtering; and
- `run_supplied` facts come only from bounded Task input text and never enter
  source extraction or a Task Dataset cache.

The server computes a narrower `requirementDigest` over the extraction meaning,
time variance, source queries, and served bindings. It then publishes an
immutable manifest revision under the template version. Requirements are stored
as individual queryable rows, and the complete revision becomes active in the
same database transaction; a failed publication cannot expose a partial
manifest. Existing template versions compiled before this contract remain
readable, but re-ingestion is required to publish their manifest rows.

`get_template_contract` exposes only key/name/description/digest/binding
summaries. Standalone Ask and Extraction receive `runtimeStatus: inert`. A
verified saved Task receives a server-verifiable reference and may ask
`task_dataset` to reuse, create, or recreate it in that Task's exact dataset
group. The server loads the complete definition from the immutable execution
plan; the model cannot substitute a schema behind a valid digest.

See [Task Dataset Phase 6](../TaskDatasets/phase_6_implementation.md) for the
full validation, trust, transaction, and runtime binding contract.

### 9.4 Saved-Task template pins

A saved Task step explicitly chooses `stepType: template` and stores the exact
Template Group, template, and immutable version IDs. The server validates that
the version belongs to that template and has an active requirement manifest,
then stores a summary containing the version number, manifest revision and
digest, requirement count, segment count, source file name, and contract digest.
Creating a Task run copies those values into the run item so later template
ingestion cannot change an in-flight run.

The Task editor obtains choices from the ordinary Template Group read routes
with a `siloId` filter. Only groups assigned to that silo and templates with a
renderable active version plus active requirement manifest are selectable. A
saved Task is still portable between silos, but run creation verifies the
selected silo has every referenced group.

Template deletion marks saved references `template_deleted` without removing
or reordering steps. New runs are blocked until the operator replaces or removes
the invalid step. A run snapshot that already exists stays pinned and may finish
after a catalog soft deletion. The stored summary remains readable even if an
explicit physical purge later clears foreign-key IDs.

Template selection is itself the staged-execution switch. There is no saved
legacy-mode flag. `STAGED_TEMPLATE_EXECUTION_LEGACY_FALLBACK` is an
installation-only emergency rollback setting; the normal route is always the
Stage 6 staged executor.

### 9.5 Moving searches to page 1

It can be helpful to place document-wide research guidance in a new Word
comment attached near the top of page 1. It is not a fundamental requirement.
Hoisting is offered only when:

- every moved directive is semantically equivalent;
- the new comment's scope is intentionally document-wide;
- removing the local copies does not change when or where the guidance applies;
- the author sees which comments will change.

Only the search directive is hoisted by default. Moving unrelated prose or
directives could silently widen their scope.

---

## 10. Final Ask and Extraction Run

For a pinned and approved template, the desired path is:

1. The model selects a Template Group only when the user's desired outcome and
   the group tool description make it appropriate.
2. It selects a template by title or semantic description.
3. `get_template_contract` returns the compact execution outline, search plan,
   and persistent-data summary, not the full expanded contract.
4. In a verified saved Task, the model compares suggestion digests with the
   exact-group Task Dataset catalog and applies only useful compatible
   suggestions. Standalone generation leaves every suggestion inert.
5. The run performs the planned retrievals and retains compact evidence
   references.
6. It creates the document workspace.
7. It loads one dependency-compatible segment batch at a time with
   `get_template_section`, using a budget derived from the selected model's
   actual context window.
8. It applies each batch atomically, populating independent/detail segments
   before dependent/synthesis segments.
9. It inspects targeted workspace values when a summary depends on earlier
   output.
10. It repairs correctable missing bindings within the configured tool budget.
11. It finalizes only when deterministic requirement checks pass.
12. The renderer preserves the source layout and produces the downloadable
    DOCX. The model's text response reports the result; it is not wrapped into a
    file as a substitute for using the document tools.

“One shot” means one planned generation run, not one provider call. A complex
report may use several searches and document writes, but it should not need a
second ingestion or a human to explain the template during that run.

---

## 11. Current Implementation Status

This section is the codebase status as of 2026-08-26, not a future design.

### 11.1 Implemented

- Immutable numbered DOCX versions, checksums, storage paths, ingestion jobs,
  active-version pointers, original download, inspection ZIP, Redo, and Ignore.
- Six durable ingestion passes with visible status, timings, summaries, failure
  records, and safe model-pass reuse on a retried job.
- Sequential planning and cached-file tools in both model-assisted Template
  Ingestion passes, with a configurable tool-call budget and timeout.
- Word comments as non-rendered instructions, anchor-aware scope, directive
  parsing, placeholder compilation, stable field/collection/instruction IDs,
  page attribution when available, and complete comment-layer removal.
- Segment derivation from governing comments.
- `synthesizes:` dependency parsing, topological segment ordering, document
  order tie-breaking, cycle detection, and safe cycle fallback.
- Exact duplicate `rag_search` merging with originating instructions and served
  segments retained.
- Saved-Task-only persistent-data planning, trusted Word-comment
  `task-dataset:` hints, semantic digests stable across layout-only revisions,
  compact inert/actionable contract summaries, and server-verified Task
  Dataset binding.
- Compact `get_template_contract`, paged/budgeted `get_template_section`, and
  model-context-derived section budgets.
- Stateful document workspaces, targeted inspection, incremental semantic
  writes, deterministic requirement checking, finalization, and preserved DOCX
  package parts.
- Deterministic authoring notes for unknown references, cycles, reordered
  sections, directive conflicts, broad scope, uncapped dependent collections,
  duplicate searches, and unanchored comments.
- Multiple correction alternatives in the DOCX engine's authoring-note model.
- Tested low-level edits for setting/removing comment directives, hoisting
  duplicate directives, and renaming exact placeholders.
- One normalized finding contract for deterministic, semantic-model, and
  technical findings, including consequence, sources, confidence,
  alternatives, disposition, and saved Word page number.
- Validation of every suggested edit against staged bytes and a recompiled
  contract before **Implement** is enabled.
- Admin and API v1 Ignore/Implement actions. Implement uses checksum, contract
  digest, latest-version, review-cycle, and idempotency preconditions.
- Transactional correction lineage: a new private DOCX object and version,
  action journal, parent link, provenance, and automatically queued six-pass
  re-ingestion. The parent is never overwritten.
- Finding signatures and clear/changed/stalled/oscillating/limit-reached
  convergence states with a five-cycle limit.
- Ingestion-pinned execution plans. Ask and Extraction use the stored plan when
  its contract digest matches and derive it only as a compatibility fallback
  for older versions.
- Templates UI pass timeline, review-cycle/convergence status, alternatives,
  Implement buttons, and legacy stored-output compatibility.

### 11.2 Partially implemented

| Capability          | What exists                                                         | Remaining connection                                                               |
| ------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Dependency planning | Semantic review can propose `set_line` changes for `synthesizes:`   | Evaluation fixtures should measure whether common missing edges are found reliably |
| Search optimization | Exact merges and model-proposed alternatives; hoisting is validated | Broader constraint-aware semantic merge evaluations remain                         |
| Version comparison  | Structural recompilation, checksums, relationship/source retention  | No rendered before/after page diff or automatic visual-regression gate             |
| Edit vocabulary     | Comment directive operations, hoisting, and placeholder rename      | Comment creation/splitting/moving and exact-precondition prose edits remain manual |

### 11.3 Not implemented

- Rendered before/after page comparison and unintended-layout-drift detection.
- Automatic activation of a corrected version; quality completion and the
  environment's existing approval policy intentionally remain separate.
- Unrestricted Word editing. Recommendations outside the safe operation
  vocabulary intentionally require a person to edit Word.

---

## 12. Code Map

| Area                                                            | Current source of truth                                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Placeholder/comment compilation and DOCX rendering              | `packages/docx-engine/src/index.ts`                                                |
| Directive parsing                                               | `packages/docx-engine/src/directives.ts`                                           |
| Segments, execution/search plans, deterministic authoring notes | `packages/docx-engine/src/planning.ts`                                             |
| Deterministic Word-comment rewrites                             | `packages/docx-engine/src/comment-edits.ts`                                        |
| Engine behavior tests                                           | `packages/docx-engine/src/index.test.ts`, `planning.test.ts`                       |
| Template ingestion orchestration/persistence                    | `apps/worker/src/index.ts`                                                         |
| Durable pass runner and normalized review validation            | `apps/worker/src/template-ingestion-passes.ts`, `template-review-normalization.ts` |
| Analysis and semantic-review model loops                        | `apps/worker/src/template-ingestion-model.ts`                                      |
| Template catalog records and version storage helpers            | `apps/web/src/lib/document-templates.ts`                                           |
| Transactional correction service                                | `apps/web/src/lib/template-review-actions.ts`                                      |
| Templates authoring/review UI                                   | `apps/web/src/app/templates/page.tsx`                                              |
| Existing template routes                                        | `apps/web/src/app/api/templates/`                                                  |
| Runtime Template Group and document tools                       | `packages/rag-core/src/index.ts`, `apps/web/src/lib/model-runner.ts`               |
| Initial catalog/version schema                                  | `supabase/migrations/20260816000200_document_template_catalog.sql`                 |
| Multi-pass, findings, actions, lineage, and plan schema         | `supabase/migrations/20260822000100_template_ingestion_multi_pass.sql`             |

---

## 13. Required API and Persistence Work

### 13.1 Read contract

The template catalog response includes normalized findings and safe alternative
metadata. Raw operations remain server-side. Admin/API callers send only the
stored finding and alternative IDs plus immutable preconditions.

### 13.2 Implement endpoint

Implemented admin shape:

```text
POST /api/templates/{templateId}/versions/{versionId}/review-findings/{findingId}/implement
{
  "alternativeId": "...",
  "expectedSourceSha256": "...",
  "expectedContractDigest": "...",
  "idempotencyKey": "..."
}
```

The server resolves the stored operation by finding and change ID. It must not
trust a browser-supplied OOXML edit. Return the new version ID, version number,
job ID, and status URL.

API-key users use the equivalent route beneath
`/api/v1/template-groups/{groupId}/templates/{templateId}/versions/...` with a
`templates:write` key and `Idempotency-Key` header. List responses advertise
the Ignore and implement URLs.

### 13.3 Idempotency and concurrency

- One `(version_id, finding_id, change_id)` acceptance may create at most one
  derived version.
- A repeated request returns the existing result.
- A stale checksum/digest returns a conflict and asks the client to refresh.
- Two changes chosen from the same parent must not silently overwrite each
  other. The second is either applied to the first derived version after fresh
  analysis or rejected as stale.

### 13.4 Dispositions

Ignore decisions should belong to the analyzed version and finding ID. An
implemented finding is resolved by the derived source, not merely hidden in UI
state. Re-analysis may supersede old finding IDs while preserving their audit
history.

---

## 14. Safety and Quality Gates

1. Never edit a stored source object in place.
2. Never address an OOXML edit by page number alone.
3. Never apply model-supplied raw XML.
4. Require exact comment/placeholder preconditions before a staged edit.
5. Validate ZIP paths, package relationships, comments, and compilation after
   every edit.
6. Verify the target finding is resolved.
7. Reject unrelated binding loss, missing images, broken headers/footers, or
   relationship damage.
8. Treat visual page drift as a warning or failure according to the operation;
   comment-only changes should not materially alter rendered layout.
9. Keep the original and every derived source downloadable to authorized users.
10. Record every accepted, ignored, failed, or superseded decision.

---

## 15. Implementation Roadmap

### Phase A — Normalize review data

**Status: implemented.**

- Add alternatives, consequences, source, confidence, and disposition to one
  finding contract.
- Adapt current deterministic notes and model suggestions into it.
- Preserve compatibility with existing stored ingestion output.
- Expose `changes[]` in the catalog only for authorized users.

**Acceptance:** The UI can render one finding with zero, one, or several
alternatives without losing existing Ignore behavior.

### Phase B — Derived source versions and Implement

**Status: implemented.**

- Add lineage/provenance migration and source-edit job/event storage.
- Build a service that resolves and applies stored changes.
- Add checksum/digest/idempotency checks.
- Validate and store version `N+1`, then queue ingestion.
- Add one Implement button per alternative and show progress/new version.

**Acceptance:** Choosing either alternative in a test finding produces the
expected new DOCX, leaves the parent untouched, re-ingests automatically, and
does not propose the resolved issue again.

### Phase C — Expand safe edit operations

**Status: partially implemented.** Exact placeholder rename is available;
comment creation/splitting/moving remains bounded future work.

- Add stable placeholder occurrence addressing and renaming.
- Add comment creation/splitting/moving with exact preconditions.
- Add preview text and before/after comment detail.
- Keep uncertain prose edits manual.

**Acceptance:** Comment and placeholder corrections requested by the quality
review can be applied without opening Word, with no layout change.

### Phase D — Model-led multi-pass planning

**Status: implemented for ingestion and execution-plan pinning.** Continued
evaluation and prompt tuning are expected as real templates reveal new cases.

- Split semantic review from final description/layout extraction.
- Ask for dependency, scope, ambiguity, and retrieval-efficiency findings.
- Require multiple alternatives when distinct safe choices exist.
- Validate every proposed operation deterministically before displaying it.
- Add convergence/oscillation limits.

**Acceptance:** A fixture whose page-2 summary depends on page-4/5 details gets
an accurate dependency suggestion; acceptance changes the next execution plan.

### Phase E — Search consolidation and page-1 guidance

**Status: implemented for exact merge, semantic suggestions, and validated
hoist alternatives.** Broader constraint-aware evaluation remains.

- Propose constraint-preserving semantic merges.
- Offer optional `rag_search` hoisting through a new top comment.
- Show which local comments and segments are affected.
- Never hoist unrelated prose automatically.

**Acceptance:** Exact duplicates still merge automatically, similar searches
merge only after approval, and rejecting hoisting leaves runtime behavior
correct.

### Phase F — Visual verification and evaluation

**Status: not implemented.** This is the next major quality layer, not a
requirement for the ingestion-first correction workflow delivered above.

- Render before/after previews for derived versions.
- Compare page count, layout anchors, relationships, image inventory, and
  placeholder/comment deltas.
- Add fixtures for scope, conflicting comments, repeated variables, dependency
  cycles, summaries-before-details, duplicate searches, and edit concurrency.
- Measure ingestion calls, generation calls, searches, tool turns, elapsed
  time, unresolved fields, continuation attempts, degraded reviews, and
  finalization repairs. Continuation and degraded-review telemetry are
  implemented; aggregate evaluation remains future work.

**Acceptance:** Template corrections have explainable diffs, and a prepared
template demonstrates fewer retrieval/tool turns than the same unplanned
template without losing answer or layout quality.

---

## 16. Definition of Done

The feature reaches the intended goal when all of the following are true:

- a nontechnical author can understand every finding and choose among safe
  alternatives;
- Implement creates an auditable derived DOCX version and never mutates its
  parent;
- Redo uses the corrected version without repeating accepted choices;
- comments and placeholders compile consistently and never leak into output;
- section scope and topic supersession behave predictably;
- detailed sections may execute before earlier summaries through an accepted
  dependency plan;
- retrieval is gathered and consolidated conservatively before writing;
- Ask and Extraction use the same pinned plan and deterministic renderer;
- a prepared template completes in one planned generation run under realistic
  context, search, tool-call, and timeout budgets;
- visual and structural verification shows that authoring corrections did not
  damage the preserved Word layout.

---

## 17. Deliberate Boundaries

This plan does not make the model an unrestricted Word editor. It does not
silently rewrite author prose, infer dependencies directly into a live plan,
or merge searches merely because they sound similar. Those judgments are
presented as choices. The deterministic editor implements only changes with a
stable target, a visible preview, and validation strong enough to preserve the
author's document.

Advanced conditional regions, arbitrary non-table repeating layouts,
calculated styling, and general-purpose image-slot replacement remain renderer
capabilities tracked by the broader document-engine specifications. They do
not block the authoring/version workflow described here.
