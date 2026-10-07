# DOCX Template Authoring Language

This is the author-facing contract for a reusable DOCX template. It is designed
to remain readable in Microsoft Word while giving ingestion, the model, and the
deterministic renderer unambiguous responsibilities.

## Data bindings: `{{...}}`

Double curly brackets declare a visible location where generated content can be
inserted.

```text
{{Town Name}}
{{Reporting Period}}
{{Executive Summary}}
{{Town Logo}}
```

The text inside the brackets is a human-readable semantic label. Ingestion
converts it to a stable editing ID, such as `town_name`, but neither ingestion
nor the model treats that label as an exact source-data key. For example,
`{{Town Name}}` can be satisfied by reliable evidence labeled town, township,
municipality, municipal name, or another equivalent term. The model may use
information already present in the request or the available retrieval tools to
find the value described by the binding.

Use descriptive names. Avoid generic bindings such as `{{#}}`, `{{$}}`,
`{{Value}}`, or `{{Text}}`. Reuse the same binding name only when every
occurrence should receive the same value under the same active comment state.
When a later Word comment changes the purpose of a reused placeholder name, the
contract gives that occurrence a distinct editing field ID.

Placeholders are optional by default in comment-authored templates. If the
comments, surrounding text, and available evidence do not establish a confident
meaning and value, leave the placeholder blank rather than guessing. Add
`required: true` to a Word comment when the document must not be finalized
without that value. Phrases such as “Not available from source” are not a good
substitute for missing evidence.

## Author instructions: Word comments

Every Word comment in a template is an author instruction. Anchor the comment to
the placeholder, table, heading, or visible text where the instruction becomes
active. Ingestion records its text, anchor, source part, and document order.
Generated documents contain no comment ranges, comment-reference marks,
comment relationships, author metadata, or comment package parts.

Quoting a `rag_search` value is optional. Straight quotes, curly quotes, a
mismatched pair from Word autocorrect, and no quotes at all all read the same,
as long as the query ends at a line break or a semicolon.

```text
Visible template text: {{Executive Summary}}

Word comment anchored to that placeholder:
Compile a concise overview of the reporting period. Prefer adopted or approved
information and distinguish completed work from planned work.
type: rich_text
rag_search: "town manager monthly accomplishments reporting period"
rag_search: "council decisions and operational updates reporting period"
```

### How far a comment reaches

Each comment gets a scope, and the scope decides which bindings it governs.

| Scope      | Reaches                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `binding`  | Only what the comment anchor covers: that placeholder, row, or table.                                            |
| `section`  | To the next heading of the same or higher level — or, in a document with no heading styles, to the next comment. |
| `document` | From the anchor to the end of the document.                                                                      |

The default is chosen for you:

- A comment that carries a **directive** (`required`, `type`, `empty`,
  `collection`, `evidence_register`) defaults to `binding`. It is describing the
  thing it is attached to, so it governs only that thing.
- A **prose-only** comment defaults to `document`. It is authoring policy, so it
  stays active in document order the way a style rule would.
- A `binding` comment anchored to a heading or to ordinary prose — anywhere that
  covers no placeholder, row, or table — widens to `section`, because it clearly
  meant something broader than the words it is attached to.

Add `scope:` to any comment to override the default.

A word about `section` in a document with no headings, which is most real
templates: Word lets you make a heading by making text bold and large, and that
leaves nothing in the file for `section` to stop at. Rather than quietly
behaving as `document`, section scope in that case runs to the **next comment**.
That is also where the next region of the report begins, so the two mean the
same thing. Applying real Heading styles is still worth doing — it makes the
document navigable and gives you finer control — but you are not required to.

This is why prose still accumulates the way you would expect:

```text
Comment 1: Do not include forecast values.
Comment 2: Use adopted totals in financial tables.
Comment 3: Include forecast values in this appendix.
```

All three are prose-only, so all three stay active in document order. At Comment
2, “do not include forecasts” is still in force because Comment 2 only changes
the rule for totals. At Comment 3 the forecast rule changes while the
adopted-total rule remains. The contract gives every field and collection the
ordered instruction IDs active at its location so the generation model can apply
this state without discarding unrelated rules.

Directives do not work that way, and should not. A comment on `{{Executive
Summary}}` that says `type: rich_text; required: true` describes the executive
summary — not `{{Total Budget}}` twelve pages later. Reach for `scope: document`
when you genuinely want a directive to apply from that point onward.

Because a directive comment governs only its own anchor, two occurrences of the
same placeholder stay one field unless a comment is aimed at one of them. An
unrelated comment in between no longer splits `{{Town Name}}` into two separate
values to fill.

Before searching, the model reviews the complete comment stream and collects
all `rag_search` requests. Duplicate and substantially overlapping requests can
be combined when a broader query covers the narrower ones, but distinct date
ranges, entities, evidence thresholds, and section requirements must remain
traceable to the comments and document locations that need them.

One comment can describe every logical column of a repeating table using normal
prose. Single-brace references remain accepted inside comments when an explicit
mapping is useful, but they are not required:

```text
Word comment anchored to the prototype row:
Following section is a table with repeating sets of grants.
{initiative} is the grant or funded initiative.
{owner} is the source or issuing organization.
{status} states whether it was issued, spent, and fulfilled.
{date} is the most recent update.
{gap} identifies any difference between cost and funding.
collection: grants
rag_search: "active grants award status funding gap last update"
```

Trailing numbers and separators are treated as authoring-time row-instance
notation for repeating data, not as strict names. `{initiative}`,
`{initiative_1}`, `{initiative1}`, `{{initiative_1}}`, and `{{initiative2}}`
all describe the same logical `initiative` column when they occur **down the
rows** of the repeating table. The numbers do not require the model to find or
preserve a particular numbered sequence.

Numbers are only read as row instances when they run down the table. When the
same base name appears more than once **within one row** — `{{Address Line 1}}`
beside `{{Address Line 2}}`, or `{{Quarter 1}}` beside `{{Quarter 2}}` — those
are separate columns and keep their numbers as part of the column name.

## Optional directives

A line break and a semicolon both end a statement, and they are
interchangeable. Write each directive on its own line in the comment, or run
them together separated by semicolons, whichever reads better:

```text
Compile a concise overview of the reporting period.
type: rich_text
required: true
rag_search: "town manager monthly accomplishments"
```

```text
Compile a concise overview of the reporting period. type: rich_text; required: true; rag_search: "town manager monthly accomplishments"
```

Both compile identically. What you must not do is let a directive run into the
text after it with no line break and no semicolon, because the value then
absorbs whatever follows.

| Directive                  | Meaning                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `required: true`           | The governed binding or collection must contain real data. Comment-authored placeholders are otherwise optional by default.                                                                                   |
| `required: false`          | Missing evidence is allowed.                                                                                                                                                                                  |
| `optional: true`           | Equivalent to `required: false`.                                                                                                                                                                              |
| `type: text`               | Plain text value.                                                                                                                                                                                             |
| `type: rich_text`          | Paragraphs, headings, or generated tables. Put this binding in its own paragraph. An empty `blocks` array is a valid explicit blank: `empty: clear` retains the blank paragraph and `empty: omit` removes it. |
| `type: number`             | Numeric value.                                                                                                                                                                                                |
| `type: currency`           | Currency value; the template should provide the visible currency style.                                                                                                                                       |
| `type: percent`            | Percentage value.                                                                                                                                                                                             |
| `type: date`               | Date value. State the desired date format in the prose instruction.                                                                                                                                           |
| `type: image`              | Semantic image binding. Image-slot replacement is not yet supported by the deterministic renderer; existing template images are preserved.                                                                    |
| `empty: omit`              | The governed item is optional. For a repeating table, an empty collection removes its prototype rows.                                                                                                         |
| `empty: clear`             | Clear an optional unresolved placeholder but retain its surrounding layout.                                                                                                                                   |
| `empty: fail`              | Treat an unresolved value as an error.                                                                                                                                                                        |
| `collection: initiatives`  | Give the following repeating table a stable collection ID. This also allows a single prototype row to define the collection.                                                                                  |
| `evidence_register: true`  | Populate the following repeating table from the RAG sources actually used by the run.                                                                                                                         |
| `evidence_register: false` | Keep a table that merely looks like a source list — document, page, or reference columns — as ordinary content the model fills itself.                                                                        |
| `scope: binding`           | Default for a comment carrying directives. Governs only the anchored placeholder, row, or table.                                                                                                              |
| `scope: section`           | Governs from the anchor to the next heading of the same or higher level, or to the next comment when the document has no headings.                                                                            |
| `scope: document`          | Governs from the anchor to the end of the document. Default for a prose-only comment.                                                                                                                         |
| `max_rows: 20`             | The most rows the following repeating table may be filled to. Rows beyond it are left out.                                                                                                                    |
| `synthesizes: a, b`        | This part of the report is written from the named placeholders or tables, wherever they are in the document. Ingestion orders those first, whatever page they are on.                                         |

`task-dataset:` is a special saved-Task optimization hint rather than a render
directive. Put it at the start of a line in a Word comment and describe the
stable records worth retaining, for example:

```text
task-dataset: Store grant item data as one record per grant. Include grant ID,
recipient, amount, award date, status, and source evidence.
```

Ingestion binds the intent to the comment's compiled fields, collections, and
RAG queries, validates a persistent-data suggestion, and stores only the
suggestion in the template execution plan. It does not create data during
ingestion or standalone generation. A verified saved Task may later apply the
suggestion in its own Task+silo+project-or-no-project dataset group. The text is
descriptive intent, not JSON or an executable schema. Only Word-comment
instructions recognize this prefix; visible source text and retrieved
documents never do.

Unknown text remains ordinary model guidance. This makes instructions such as
color rules useful even when they are not yet a first-class renderer directive.
Variable-specific guidance such as “if this information was not provided, keep
it blank” is also honored during final validation. This more specific guidance
allows that one binding to be blank even when the template's general default is
required; guidance that says to omit or remove an unavailable value removes the
rich-text slot instead.

## Repeating tables

Use one prototype data row and anchor a collection comment to that row or its
table. Anchoring to a single cell inside the row works too — the comment is
matched against the row and table it sits in, not against where it starts.
Keep table headings as normal static Word content.

```text
Word comment anchored to the prototype row:
collection: strategic_initiatives
required: false
empty: omit
Include only initiatives supported by retrieved evidence. Sort urgent items
first. In the Status column, use the wording defined by the source material.
rag_search: "active strategic initiatives status owner next milestone"

| Initiative | Owner | Status | Next milestone |
| {{Initiative}} | {{Owner}} | {{Status}} | {{Next Milestone}} |
```

The renderer clones the prototype row once for every collection item. If the
collection is optional and there are no supported items, the model sets it to
an empty array and the prototype row is removed.

Do not create seven manually numbered prototype rows. Older numbered bindings
are normalized, with or without an underscore, hyphen, or space before the row
number. Numeric-only source IDs are also normalized for an evidence register,
but one explicit prototype row is easier to inspect and much less ambiguous.

## Evidence registers

An evidence register should be a repeating table with stable column bindings.

```text
Word comment anchored to the evidence prototype row:
collection: source_evidence
evidence_register: true
required: false
empty: omit
List only sources actually used to produce this report.

| Source ID | Document | Type | Page or location | Evidence |
| {{Source ID}} | {{Document Title}} | {{Source Type}} | {{Page}} | {{Evidence}} |
```

At finalization the application groups the run's retrieved chunks by document
and page and fills a recognized evidence-register collection. This keeps the
register tied to actual tool results instead of relying on the model to recreate
citations from memory.

A table is also recognized as an evidence register from its column names alone.
If you have a content table that happens to list documents and pages — a permit
schedule, a records index — add `evidence_register: false` to its comment so the
model fills it normally.

## Recommended template design

1. Keep all fixed wording, branding, headers, footers, page setup, table widths,
   and static images in the DOCX itself.
2. Give every dynamic value a specific binding name and put every rich-text
   binding in its own paragraph.
3. Anchor Word comments to the placeholder, section, or repeating row they
   govern. Use multiple focused RAG searches when the section needs distinct
   evidence sets.
4. State the evidence threshold: adopted only, approved and draft, date range,
   department, project status, or other constraints.
5. Mark genuinely optional content with `required: false; empty: omit`. Do not
   leave visible fallback labels or dollar signs in the template.
6. Use a dedicated evidence register rather than a manually maintained source
   appendix.
7. Put every authoring/developer instruction in a Word comment. Do not place
   instructions in visible paragraphs or table rows.
8. Test with a sparse evidence set and a full evidence set before approving a
   template.

## Current renderer boundary

The implemented renderer fills scalar and rich-text bindings, clones or removes
repeating table rows, preserves the original DOCX package and images, strips the
complete Word comments layer, validates explicitly required data, and builds an
evidence register. Its contract exposes ordered comment instructions and stable
IDs used by document-editing tools. Legacy `<<<...>>>` blocks remain supported
for existing templates, but new templates should use Word comments exclusively.

The following remain explicit later renderer capabilities: deleting an
arbitrary multi-paragraph or multi-page region, cloning an arbitrary non-table
block, replacing an image at a named image binding, and calculating Word cell
shading from a color rule. Instructions for those outcomes are retained in the
contract today, but a template should not depend on those operations until the
corresponding deterministic operations are added.
