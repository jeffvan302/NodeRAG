# Writing a Word Template

This guide is for the person designing the Word document. You do not need to
know Open XML, prompts, databases, or retrieval systems. Build a normal Word
document, mark the places that may change, and use Word comments to explain
what should happen there.

For a shorter visual walkthrough, see the
[Template Authoring Quick Start](template_authoring_quick_start.pdf).
For a working file you can change and upload, download the
[Template Authoring Starter](template_authoring_starter.docx).

---

## The whole idea

A template is a normal `.docx` file with two authoring features:

1. **Placeholders** mark where generated information belongs.
2. **Word comments** explain how to find, select, format, or validate it.

A placeholder is ordinary visible text inside double curly brackets:

```text
Prepared for {{Organization Name}} for the period ending {{Period End}}.
```

Select the placeholder in Word, choose **Review > New Comment**, and write the
instruction you would give a capable colleague:

```text
Use the municipality or organization name established by the source material.
required: true
```

The placeholder name is a clue, not an exact database field. `{{Town Name}}`
can be filled from trustworthy evidence that calls it a town, township,
municipality, or municipal name.

All comments are removed from generated documents, including their anchors and
comment marks. Comments do not occupy layout space in the finished file.
Legacy `<<<instructions>>>` blocks still work for old templates, but do not use
them in new templates.

---

## Build the Word document first

Design the document as you want the finished report to look:

- Set page size, margins, headers, footers, styles, and branding in Word.
- Use real Word Heading styles for section titles when possible.
- Keep fixed wording, labels, borders, colors, and static images in the file.
- Use normal Word tables with deliberate widths and a clear header row.
- Put generated multi-paragraph content in its own paragraph.
- Do not place authoring instructions in visible body text.

The renderer preserves the original DOCX package and its static images. It can
fill scalar fields and rich text, clone or remove repeating table rows, build an
evidence register, strip comments, validate required bindings, and package the
final Word file.

Image placeholders such as `{{Organization Logo}}` can be described with
`type: image`, but replacing a named image slot is not yet deterministic.
Keep logos and other fixed images in the template itself for now.

---

## Name placeholders clearly

Use the words a reader would naturally use:

```text
Good:  {{Organization Name}}   {{Executive Summary}}   {{Reporting Period}}
Poor:  {{fld_22}}              {{cb1_es}}               {{$}}
```

Reuse a placeholder name only when every occurrence should receive the same
value. Reused names can have different local meanings when an anchored comment
clearly changes the purpose at that location, but distinct names are easier to
review.

Numbered placeholders are not a strict numbering system in a repeating table.
Values such as `{{Initiative_1}}`, `{{Initiative2}}`, and `{{Initiative 3}}`
running down rows are normalized into one logical `Initiative` column. If two
numbered values appear beside each other in the same row, such as
`{{Quarter 1}}` and `{{Quarter 2}}`, they remain separate fields.

---

## Write focused Word comments

Anchor each comment to the placeholder, heading, table, row, or visible words
it governs. One focused comment is easier to interpret than one comment that
mixes unrelated rules.

Weak comment:

```text
The summary.
```

Useful comment:

```text
Write two or three paragraphs for the governing body. Name projects that moved
this period, distinguish completed work from planned work, and do not repeat
the financial table.
type: rich_text
required: true
```

Plain sentences remain valid instructions. Directives add precision; they do
not replace normal explanations.

### How far a comment reaches

Comments are read in document order as instruction state. A later instruction
overrides an earlier one only where they conflict. Unrelated earlier guidance
continues.

- A comment with a directive normally applies only to its anchored binding,
  row, or table.
- A prose-only comment normally applies from its anchor to the end of the
  document.
- A binding comment anchored to a heading or normal prose widens to the section.
- Add `scope: binding`, `scope: section`, or `scope: document` when you want to
  state the boundary explicitly.

`scope: section` ends at the next heading of the same or higher level. If the
document has no real Word headings, it ends at the next governing comment.

Example document policy:

```text
Use approved or adopted information. Do not convert proposed values into facts.
Keep the tone concise and suitable for public distribution.
scope: document
```

---

## Directive reference

Put each directive on its own line or separate directives with semicolons. A
line break or semicolon ends the directive value.

| Directive | What it means |
| --- | --- |
| `required: true` | Real data must be supplied before finalization. |
| `required: false` or `optional: true` | Missing evidence is allowed. This is the default. |
| `type: text` | A short plain-text value. |
| `type: rich_text` | Paragraphs, headings, lists, or generated tables. Give it its own paragraph. |
| `type: number` | A numeric value. |
| `type: currency` | A currency value; keep the desired visible style in the Word layout. |
| `type: percent` | A percentage value. |
| `type: date` | A date. State the desired display format in the comment. |
| `type: image` | A semantic image field; deterministic replacement is not yet supported. |
| `empty: clear` | Remove the placeholder text but retain the surrounding layout. Default. |
| `empty: omit` | Remove an optional placeholder or repeating prototype row when empty. |
| `empty: fail` | Treat an unresolved value as an error. |
| `collection: initiatives` | Name a repeating table or row collection. |
| `max_rows: 20` | Limit how many rows a collection may create. |
| `evidence_register: true` | Fill a repeating table from RAG sources actually used. |
| `evidence_register: false` | Prevent a source-looking business table from becoming an evidence register. |
| `rag_search: "..."` | Describe evidence to retrieve before writing. Repeatable. |
| `synthesizes: a, b` | Fill the named fields or collections before writing this binding. |
| `scope: binding` | Apply only to the anchored binding, row, or table. |
| `scope: section` | Apply through the current section. |
| `scope: document` | Apply from this point to the end. |

Do not let a directive run into the next sentence:

```text
Bad:  rag_search: capital projects and keep the tone formal

Good: rag_search: "capital projects"
      Keep the tone formal.
```

Straight quotes, curly quotes, mismatched Word quotes, and no quotes are all
accepted. The line break or semicolon is what ends the search.

---

## Fixed fields

Use fixed fields for values that appear once or a known number of times:

```text
Organization: {{Organization Name}}
Reporting period: {{Reporting Period}}
Prepared by: {{Prepared By}}
Open projects: {{Open Project Count}}
Budget used: {{Budget Used Percent}}
```

Comment on each field when its name and surrounding label are not enough. Mark
only genuinely essential values as required. Too many required fields can stop
a document from finalizing because one optional fact was unavailable.

For unsupported optional values, choose one outcome:

- `empty: clear` keeps the document structure and leaves the location blank.
- `empty: omit` removes the optional placeholder or row.
- `empty: fail` blocks completion.

The renderer rejects `Not Available from Source` as a placeholder value. It is
better to clear or omit an unsupported field than to print a fake answer.

---

## Repeating tables

Use a repeating table when the number of records is unknown. Create:

1. One static header row.
2. One prototype data row containing placeholders.
3. One Word comment anchored anywhere in that prototype row.

Example:

| Initiative | Owner | Status | Latest update | Next step |
| --- | --- | --- | --- | --- |
| `{{Initiative}}` | `{{Owner}}` | `{{Status}}` | `{{Latest Update}}` | `{{Next Step}}` |

Comment on the prototype row:

```text
One row per active initiative with activity in the reporting period.
{Initiative} is the official initiative or project name.
{Owner} is the responsible person or department.
{Status} is On Track, Watch, or Action Required when the evidence supports it.
{Latest Update} is a concise evidence-backed progress statement.
{Next Step} is the next committed action and date, when stated.
collection: initiatives
max_rows: 20
required: false
empty: omit
rag_search: "active initiatives project status owner next milestone"
```

The renderer clones the prototype row once per collection item. If no supported
items exist and the collection is optional, the prototype row is removed.
Do not build five or ten empty example rows; build one.

---

## Evidence registers

An evidence register is a repeating table populated from the RAG sources
actually used during the run. It is more reliable than asking the model to
recreate citations from memory.

| Source ID | Document | Date | Page or location | Evidence used |
| --- | --- | --- | --- | --- |
| `{{Source ID}}` | `{{Document Title}}` | `{{Source Date}}` | `{{Page or Location}}` | `{{Evidence}}` |

Comment on the prototype row:

```text
List only sources actually used to prepare this report.
collection: source_evidence
evidence_register: true
required: false
empty: omit
max_rows: 25
```

Tables with document, page, source, or reference columns may be recognized from
their headings. If yours is an ordinary records table rather than a citation
register, add `evidence_register: false`.

---

## Search planning and writing order

Add focused `rag_search:` lines where the system should look for evidence.
One comment may contain several searches:

```text
Summarize operational activity for the reporting period.
rag_search: "department accomplishments reporting period"
rag_search: "council decisions follow-up actions"
```

Ingestion gathers searches from the whole document. Exact duplicates are
removed, and semantic review can suggest safe consolidation of overlapping
queries. Distinct dates, entities, evidence standards, and intended sections
remain separate.

Page order is not always writing order. If a summary on page 2 depends on a
detailed table on page 5, say so:

```text
Write two or three paragraphs. Call out every initiative marked Action Required.
type: rich_text
synthesizes: initiatives
```

Ingestion creates an execution plan that fills `initiatives` first and writes
the summary afterward without moving either section in the Word layout.

---

## What ingestion now does

Uploading a template starts a visible, resumable preparation process:

1. **Package inventory** checks the DOCX ZIP, relationships, comments, images,
   tables, styles, sections, and page map.
2. **Template compilation** resolves placeholders, comment scopes, fields,
   repeating collections, and stable editing IDs.
3. **Deterministic review** checks references, dependencies, duplicate
   guidance, scope, row limits, and legacy authoring patterns.
4. **Model structure analysis** uses four bounded calls for structure, content
   and bindings, layout, then assets and catalog description.
5. **Semantic quality review** separately checks placeholder meaning and scope,
   execution dependencies, RAG planning, and layout/assets, then performs a
   combined assessment.
6. **Plan validation** validates possible corrections and pins the execution
   plan used by Ask and Extraction.

The Templates page shows the current step, exact model call, elapsed time,
heartbeat, retry state, and description-vector status. A transient interruption
can retry only the affected call. **Resume incomplete work** reuses compatible
successful checkpoints. **Redo from start** reruns every model checkpoint with
the current Template Ingestion configuration.

The original uploaded Word file is retained as an immutable version and can be
downloaded. An inspection ZIP contains the compiled artifacts, images, plans,
and review data for diagnosis.

---

## Review, correct, and version

If no material authoring problems are found, ingestion can finish as
`completed`. If changes could make generation more reliable, it finishes as
`needs_review` and shows **Suggested improvements** with a page, location,
severity, reason, and one or more recommended alternatives.

For each finding you can:

- **Implement** a safe alternative. The system creates a new immutable DOCX
  version, applies the validated comment or placeholder edit, and ingests it.
- **Ignore** an irrelevant finding. When no unresolved material findings
  remain, the version can advance to completed.
- Download the source, make a manual Word change, and upload a new version.
- Change Template Ingestion model settings or instructions and redo analysis.

An implemented change never overwrites the original file. The new version has
its own checksum, source lineage, comments, analysis, and review history.

**Authoring notes** are deterministic explanations of what your comments will
do. They do not block the template. Read them when scope, a dependency name, or
a repeating-table interpretation is not what you expected.

After review, approve the version when your environment requires explicit
approval. Approved/completed templates can be discovered by assigned Template
Group tools and used by Ask or Extraction for DOCX output.

---

## A practical test cycle

1. Start with the example DOCX linked at the top of this guide.
2. Create or select a Template Group and upload the file.
3. Watch all six preparation passes and read the authoring notes.
4. Inspect every suggested improvement; Implement, Ignore, or edit manually.
5. Download the newest template version and verify the intended comments.
6. Approve or complete it and assign its Template Group to a test silo.
7. Run one Ask with sparse source evidence and one with complete evidence.
8. Download the generated DOCX and check fields, optional blanks, repeated
   rows, evidence register, images, and preserved layout.
9. Modify a comment or field in Word, upload the new version, and repeat.

Test sparse data deliberately. A good template remains clean when optional
sections have no evidence and refuses completion only when a truly required
value is missing.

---

## Final checklist

- [ ] The document already looks like the desired finished report.
- [ ] Every generated location uses a clear `{{placeholder}}`.
- [ ] Rich-text placeholders have their own paragraphs.
- [ ] Every instruction is in a real Word comment.
- [ ] Comments are anchored to the content they govern.
- [ ] Required fields are genuinely required.
- [ ] Optional fields specify whether to clear or omit.
- [ ] Each repeating table has one prototype row and a collection name.
- [ ] Collections that feed summaries have a sensible `max_rows`.
- [ ] Summaries name the fields or collections they synthesize.
- [ ] RAG searches state focused evidence needs and relevant boundaries.
- [ ] Source tables are explicitly evidence registers or ordinary content.
- [ ] Static logos/images are already positioned in the DOCX.
- [ ] Heading styles, table widths, and page layout are intentional.
- [ ] The template has been tested with sparse and full evidence.

For the complete technical contract and current renderer boundaries, see
[DOCX Template Authoring Language](template_authoring_language.md).
