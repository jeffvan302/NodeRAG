# Task Dataset Phase 6 Implementation

## Outcome

Phase 6 connects template ingestion to the Task Dataset runtime without making
templates globally stateful. The retrieval-planning review may now propose
zero or more reusable semantic datasets, and a trusted Word comment may add a
high-priority `task-dataset:` intent. The worker deterministically validates,
digests, and persists those suggestions inside the immutable template
execution plan.

The suggestion remains inert during template ingestion, standalone Ask, and
standalone Extraction. When—and only when—the same template is opened inside a
verified saved Task run, `get_template_contract` returns a compact actionable
reference. The model can compare it with the Task Dataset catalog and ask the
server to reuse, create, or deliberately recreate the definition. The server
re-reads the tenant-owned immutable template version and verifies the
suggestion key and semantic digest before staging any change.

No Phase 6 database migration is required. Phase 1 already added
`origin_template_id`, `origin_template_version_id`, and
`template_persistent_data_digest` to Task Dataset definitions, and template
execution plans are stored as JSON. Phase 6 activates those reserved fields.

## Product Boundary

The execution matrix is now enforced in code:

| Execution                             | Persistent-data behavior                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Template ingestion                    | Compiles suggestions; creates no Task Dataset group, definition, coverage, or record      |
| Standalone Ask with a template        | Returns an inert summary; has no apply operation or Task Dataset authority                |
| Standalone Extraction with a template | Returns an inert summary; has no apply operation or Task Dataset authority                |
| Saved Task item with a template       | May reuse, create, or recreate a suggestion in that Task+silo+project-or-no-project group |
| Saved Task item without a template    | Continues to design focused datasets directly through the existing model tool             |

The Task Dataset group remains owned by the saved Task scope, not by the
template. Consequently:

- two different saved Tasks never share records or document coverage;
- the same Task in two projects receives two different groups;
- the same Task with no project receives its own no-project group;
- every step in one Task run shares the same group and staged transaction; and
- applying the same template suggestion in another group creates or reuses a
  definition only in that other group.

## Persisted Plan Contract

The validated `execution_plan_json.plan` may now contain:

```json
{
  "persistentDataPlan": {
    "version": 1,
    "eligibleRuntime": "saved_task_only",
    "suggestions": [
      {
        "key": "grant_items",
        "name": "Grant items",
        "description": "One evidenced record per grant award ...",
        "recordSchema": {
          "type": "object",
          "properties": {
            "grant_id": { "type": "string" },
            "recipient": { "type": "string" },
            "amount": { "type": "number" }
          },
          "additionalProperties": false
        },
        "identityPolicy": {
          "mode": "all_paths",
          "paths": ["/grant_id"]
        },
        "sourcePolicy": { "mode": "relevance_gate" },
        "extractionInstructions": "Extract one source-supported record per grant ...",
        "searchPolicy": {
          "searchablePaths": ["/recipient"],
          "filterablePaths": ["/grant_id"],
          "sortablePaths": ["/amount"],
          "summaryPaths": ["/grant_id", "/recipient", "/amount"]
        },
        "semanticSearchPolicy": {
          "enabled": false,
          "embeddingPaths": []
        },
        "mergePolicy": { "mode": "preserve_conflicts" },
        "hintOrigin": "analyzer",
        "sourceQueries": [
          {
            "query": "grant awards recipients amounts status",
            "instructionIds": ["instruction_012"],
            "servedSegmentIds": ["segment_012"]
          }
        ],
        "servedFieldIds": [],
        "servedCollectionIds": ["grants"],
        "semanticDigest": "<sha256>"
      }
    ]
  }
}
```

The plan deliberately carries a complete bounded Task Dataset definition. It
is still a suggestion: ingestion cannot apply it, and a saved Task model may
decline it when persistence would not improve the run.

At the Phase 6 release boundary, `semanticSearchPolicy.enabled` remained
`false`; the policy was carried for a forward-compatible definition shape.
Phase 7 now permits the retrieval specialist to enable it only for a deliberate
bounded set of declared schema paths when later saved-Task steps benefit from
relevance retrieval. Exact identities, totals, and deterministic lookups still
use text and exact-filter reads.

## Ingestion Pipeline

Phase 6 extends the existing retrieval-planning specialist rather than adding
another unbounded model call.

1. Deterministic compilation produces fields, collections, trusted
   instructions, segments, dependencies, and the merged RAG search plan.
2. The retrieval-planning specialist reviews stable repeated record shapes and
   returns a version-1 `persistentDataPlan`, including an empty suggestions
   array when no useful cache exists.
3. The other semantic specialists are explicitly prohibited from returning a
   persistent-data plan. Cross-feature synthesis receives findings and
   summaries, not executable dataset definitions.
4. The worker independently compiles trusted `task-dataset:` Word-comment
   intents and reconciles overlapping analyzer/directive suggestions.
5. The deterministic validator checks the complete suggestion against the
   compiled contract and the existing Task Dataset definition constraints.
6. Invalid suggestions are omitted and become visible template review
   findings. A low-quality cache cannot silently enter the execution plan.
7. Valid suggestions and their semantic digests are persisted in the same
   contract-digest-pinned execution-plan envelope used by generation.

The semantic-review checkpoint version changed in Phase 6. Existing successful
core structure/content/layout/asset analysis remains reusable, while retrieval
review and plan validation rerun under the new contract.

## When a Dataset Is Appropriate

The specialist is instructed to prefer no suggestion unless all of these can
be stated:

- retrieval or formatting is expensive enough to matter on later runs;
- facts are stable until source membership changes;
- one new source can contribute incrementally;
- records have a bounded schema and defensible deterministic identity;
- exact compiled fields or collections consume the data;
- source queries already exist in the compiled retrieval plan; and
- the stored facts remain useful without preserving DOCX presentation state.

It must not persist page layout, font/color/style choices, static template
text, images/logos, transient “today” prose, arbitrary external-system values,
or a one-off synthesis whose meaning changes with the question.

## Trusted `task-dataset:` Directive

Template authors may put descriptive intent in a Word comment:

```text
task-dataset: Store grant item data as one record per grant. Include grant ID,
recipient, amount, award date, program, status, and source evidence.
```

The text after the prefix is not executable JSON, a schema, or a promise to
persist. The compiler derives a bounded initial definition from the exact
fields/collections and RAG queries governed by that comment. The retrieval
specialist may produce a richer compatible definition; overlapping results are
reconciled and marked `analyzer_and_task_dataset_directive`.

Only `source = word_comment` is accepted as the template-author channel.
Visible document text, legacy visible markers, retrieved source documents,
model-produced source content, dataset records, and catalog descriptions
cannot activate the prefix. This distinction is what prevents a source PDF or
DOCX paragraph containing `task-dataset:` from becoming tool behavior.

A directive whose compiled scope serves no field or collection is omitted and
reported as a review finding. The author can then anchor it to the intended
placeholder, table, or section.

## Deterministic Validation

Every analyzer or directive suggestion is checked for:

- the Phase 1 Task Dataset key/name/description and size limits;
- a bounded local JSON object schema with no remote references, recursive
  behavior, executable keys, excessive depth, or undeclared policy paths;
- a supported identity policy whose JSON pointers exist in the schema;
- safe source, search, semantic-search, and preserve-conflicts policies;
- exact field and collection IDs in the compiled template contract;
- exact instruction, segment, and query references in the compiled retrieval
  plan;
- at least one served field or collection;
- a unique suggestion key; and
- absence of presentation-only schema properties such as layout, font, page,
  margin, logo, or style.

The local review tool validates the model response immediately, but the worker
repeats validation during plan finalization. This second boundary is required
because OAuth responses and reusable persisted checkpoints may not have passed
through the current process's in-memory tool session.

## Semantic Digest

Each suggestion receives a SHA-256 digest over its data meaning:

- key and normalized purpose;
- record schema and identity policy;
- source, extraction, search, semantic-search, and merge policies;
- normalized source-query text; and
- sorted served field and collection IDs.

It excludes DOCX positions, page numbers, segment IDs, instruction sequence
IDs, and other presentation/order identifiers. Therefore a layout-only
template revision can retain the same suggestion digest, while a record schema,
identity, extraction meaning, binding, or source-query change produces a new
digest.

Persisted plans are self-verifying. The runtime recomputes each semantic digest
before exposing or applying the suggestion and rejects a tampered or stale
value.

## Model-Facing Template Contract

`get_template_contract` returns a bounded `persistentData` summary rather than
replaying the complete schemas into model context. Each summary contains:

- key, name, and shortened description;
- semantic digest and hint origin;
- source-query count; and
- served field and collection IDs.

Standalone calls receive `runtimeStatus: inert` and no apply operation. A
verified saved Task call receives `runtimeStatus: available` plus a compact
server-issued call shape:

```json
{
  "tool": "task_dataset",
  "op": "apply_template_suggestion",
  "action": "reuse_or_create",
  "reference": {
    "templateId": "...",
    "templateVersionId": "...",
    "suggestionKey": "grant_items",
    "semanticDigest": "..."
  }
}
```

The compact contract keeps large schemas out of the normal template outline.
The Task Dataset service loads the complete definition from the immutable
execution plan after verifying the reference.

## Saved Task Binding

The coordinator follows this runtime decision:

1. Call `task_dataset.catalog` and `get_template_contract`.
2. Compare the suggestion key/digest with the current exact-group catalog.
3. Call `apply_template_suggestion` with `reuse_or_create`:
   - no existing key: stage the suggested definition;
   - exact template ID and digest: return the existing definition without a
     write; or
   - incompatible existing key: return a recoverable conflict and require an
     explicit decision.
4. If the existing definition is insufficient or the template meaning
   changed, call `apply_template_suggestion` with `action: recreate` and a
   bounded reason. Recreation retains the key, increments the definition
   revision, starts a full rebuild, and remains staged in the Task transaction.
5. Inventory, claim, retrieve only uncovered documents, write/seal records,
   and use the active-plus-current-run overlay for later Task steps.
6. Publish the definition and records only when the complete Task transaction
   commits.

Definitions created through the operation record:

- `origin = template_suggestion`;
- the source template ID;
- the template version that supplied the complete definition; and
- the template persistent-data semantic digest.

Catalog and describe responses expose that binding. A layout-only later
version of the same template may reuse an older definition when the semantic
digest is unchanged. A different template ID cannot impersonate that binding,
even if it submits the same key.

The direct `create` and `recreate` operations remain available for model-owned
Task datasets that are not derived from a template suggestion.

## Security And Failure Behavior

- The `task_dataset` tool remains available only after the server verifies a
  running saved Task, its group, and its shared transaction.
- Template IDs, version IDs, keys, and digests supplied by the model are treated
  as untrusted references and revalidated against tenant-owned database rows.
- The template must still be enabled and its Template Group must still be
  assigned to the saved Task's signed active silo.
- A missing, non-renderable, cross-tenant, changed, or tampered version fails
  recoverably and stages nothing.
- An incompatible existing key is never silently overwritten.
- Definition creation/recreation remains staged and is discarded if the Task
  fails or is cancelled.
- Existing generation, definition-revision, worker, claim, and publication
  fencing continue to apply after binding.
- Dataset records remain untrusted source-derived data and never become
  instructions merely because a template suggested their schema.

## Tests And Release Gate

Phase 6 tests prove:

- a trusted Word-comment directive compiles to a validated suggestion;
- a visible/legacy lookalike cannot compile;
- retrieval review accepts a bounded plan and other specialists are instructed
  not to author one;
- failed semantic specialists cannot replace the retrieval specialist plan;
- schema, identity, binding, query, and presentation checks omit unsafe plans;
- suggestion digests survive layout-only instruction/segment ID changes;
- semantic identity changes alter the digest;
- tampered persisted digests are rejected;
- standalone contracts are inert;
- saved Task contracts receive only a compact apply reference;
- the Task Dataset request schema rejects forged ownership fields and malformed
  digests; and
- runtime resolution accepts only a key/digest present in the immutable plan.

At the Phase 6 release boundary, the full application build, repository tests,
TypeScript checks, documentation checks, platform-contract verification, and
existing Phase 1–5 database smoke suite were the deployment gate. Phase 6
added no migration, so its expected database head remained Phase 5. The current
head and deployment gate are documented in Phase 7.

## Deferred Work

Vector/hybrid record search, staged record embeddings, and the expanded
top-level explorer were deferred from Phase 6 and are implemented in Phase 7.
Task Datasets remain non-global, cannot cross-talk between Tasks, and remain
unavailable to standalone template generation.
