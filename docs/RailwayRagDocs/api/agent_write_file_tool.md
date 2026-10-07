# The `write_file` Agent Tool

How the Ask and Extraction models (and the Vision worker) write files into the
`generated_files` table and the private `generated-files` storage bucket.

Audience: anyone changing model task configuration, the agent loops, or the
generated-file API. Source of truth is the code referenced in each section.

## Read this first

Two behaviours contradict what the tool prompt implies. Both are current as of
this document; neither is a bug report, just how the code runs today.

**1. `get_new_id` is advertised in the prompt but not implemented.**
`WRITE_FILE_TOOL_CONTEXT` tells every agent it can request a stable file ID
before writing. The only handler that recognises the string is
`toWriteFileToolCall()` in `apps/worker/src/index.ts` (line 8464), which returns
`null` and drops the call. Nothing in the web app answers it either. No ID comes
back and no file is written. Detail in §4.2.

**2. Only the Vision worker actually persists during the tool call.** On Ask
and Extraction, `write_file` is a **loop terminator**: the runtime accepts the
call's `content` as the artifact body and the app persists it immediately after
the model loop — ignoring the model's `fileName`, `mode`, `metadata`, and every
other argument. For requested Ask files, that body is kept separate from the
short API answer and is stored without an application-generated Question/Answer
wrapper. `cache_file` publication is the incremental alternative. Extraction's
own instructions still tell the model _"Do not call write_file."_ Detail in §6.

---

## 1. What the tool is

`write_file` is one of the model tool names declared in
`packages/rag-core/src/index.ts` (`MODEL_TOOL_NAMES`):

```
write_file · list_files · rag_search · rag_documents · get_document_markdown · render_pdf_page · get_document_image · create_document · inspect_document · edit_document · copy_template_image · finalize_document · sequential_plan · cache_file · model_status
```

It is the only tool that produces persistent output. A successful write does two
things:

1. Uploads the UTF-8 file body to the private Supabase Storage bucket
   `generated-files`.
2. Inserts (or updates) a row in the `generated_files` table — the "special
   table" — scoped to the active tenant / project / silo, with
   `tool_name = 'write_file'`.

The bucket is created by `supabase/migrations/20260714000500_model_access_and_generated_files.sql`:
private, 10 MB per object, MIME types limited to
`text/plain`, `text/csv`, `text/markdown`, `application/json`. Only `service_role`
can touch it.

---

## 2. Enabling the tool

Per model task (`vision`, `ask`, `extraction`, `pdf_assembly`), per tenant and
optional project scope, in `model_task_configs`:

| Column          | Requirement                          |
| --------------- | ------------------------------------ |
| `tools_enabled` | `true`                               |
| `allowed_tools` | JSON array containing `"write_file"` |

Set from the web portal at **Configuration → model task → tools → "Write file"**
(`apps/web/src/app/configuration/page.tsx`), or via
`POST /api/model-tasks`.

When a task is saved with tools enabled, `apps/web/src/app/api/model-tasks/route.ts`
snapshots the generated prompt text into `metadata`:

- `metadata.modelToolContext` — the full tool catalogue for that task
- `metadata.writeFileToolContext` — `buildModelToolContext(["write_file"])` on its own

Ask additionally requires the caller to opt in per request
(`outputFile.enabled`); see §6.2.

---

## 3. The contract the agent actually sees

`WRITE_FILE_TOOL_CONTEXT` in `packages/rag-core/src/index.ts` (lines 415-427) is
injected verbatim into the system prompt whenever `write_file` is allowed:

> Tool available: write_file.
> Use this tool only when the user asks for a generated artifact or when the task instructions require an output file.
> The active silo and project scope are already bound by the system; do not ask for, invent, or include siloId or projectId.
> The tool writes directly into the private generated-files store and records a generated_files row in the active silo/project scope.
> Commands: use `{"tool":"write_file","command":"get_new_id","temporary":true}` to request a stable generated file ID before creating a file. Use `{"tool":"write_file","command":"write",...}` to create or update file content.
> Write arguments: optional fileId …, fileName, outputFormat (txt, csv, md, or json), content, optional mode (create, overwrite, append, or insert), optional appendLines, insertLines, insertAfter, insertBefore, insertOccurrence, matchMode (contains or exact), and optional metadata.
> For insert mode, provide insertAfter, insertBefore, or both. If both are supplied, the insertion happens between the matching lines.
> For CSV output, include a header row. For JSON output, return valid JSON content. Do not return secrets or credentials in generated files.

There is no function-calling schema — the model emits a **JSON object in its text
output** and the runtime parses it back out.

---

## 4. Commands available to the agent

### 4.1 `write` (the working command)

```json
{
  "tool": "write_file",
  "command": "write",
  "fileName": "result.csv",
  "outputFormat": "csv",
  "content": "header\nvalue",
  "metadata": { "purpose": "extraction" }
}
```

`command` may be omitted; anything that is not `get_new_id` is treated as a
write. Emit it as a bare top-level JSON object or inside a fenced ` ```json `
block, with no prose around it.

Append to an existing file:

```json
{
  "tool": "write_file",
  "fileName": "notes.md",
  "outputFormat": "md",
  "mode": "append",
  "appendLines": ["new line 1", "new line 2"]
}
```

Insert between anchors:

```json
{
  "tool": "write_file",
  "fileName": "notes.md",
  "outputFormat": "md",
  "mode": "insert",
  "insertAfter": "## Findings",
  "insertBefore": "## Sources",
  "insertLines": ["- New finding"],
  "matchMode": "contains"
}
```

### 4.2 `get_new_id` — advertised but not implemented

The prompt tells the model it can request a stable ID first. **Nothing in the
codebase answers that request.** The only handler that recognises the string is
`toWriteFileToolCall()` in `apps/worker/src/index.ts` (line 8464), which returns
`null` — the call is silently dropped, no ID comes back, and no file is written.

Practical guidance until this is implemented:

- Don't rely on `get_new_id`. Either pass a `fileId` you already hold, or let
  the runtime resolve the target by `fileName` within the silo (§5.3).
- If you implement it, the natural shape is a tool result returning a UUID that
  the model then passes as `fileId`, and a matching branch in the Ask and
  Extraction tool runners.

---

## 5. Argument reference

Validated by `GeneratedFileCreateRequestSchema` (`packages/rag-core/src/index.ts`
~line 1952) and normalised by `toWriteFileToolCall()` in the worker.

| Argument           | Type     | Default    | Notes                                                                 |
| ------------------ | -------- | ---------- | --------------------------------------------------------------------- |
| `fileName`         | string   | —          | Required. 1-180 chars. Normalised; the format extension is forced on. |
| `outputFormat`     | enum     | —          | Required. `txt` \| `csv` \| `md` \| `json`. Alias: `format`.          |
| `content`          | string   | `""`       | Complete UTF-8 body. Max 2,000,000 chars.                             |
| `mode`             | enum     | `create`   | `create` \| `overwrite` \| `append` \| `insert`. Alias: `writeMode`.  |
| `fileId`           | UUID     | —          | Stable ID to create under, or to target for update.                   |
| `targetFileId`     | UUID     | —          | Explicit update target. Takes precedence over `fileId`.               |
| `appendLines`      | string[] | —          | Max 1000 entries, 20,000 chars each. Alias: `lines`.                  |
| `insertLines`      | string[] | —          | Same limits.                                                          |
| `insertAfter`      | string   | —          | Anchor line. Max 20,000 chars.                                        |
| `insertBefore`     | string   | —          | Anchor line. Max 20,000 chars.                                        |
| `insertOccurrence` | integer  | `1`        | 1-100. Which anchor match to use.                                     |
| `matchMode`        | enum     | `contains` | `contains` (substring) \| `exact` (trimmed equality).                 |
| `temporary`        | boolean  | `false`    | Marks the row `is_temporary` for cleanup sweeps.                      |
| `metadata`         | object   | `{}`       | Merged into the row's `metadata` JSONB.                               |

`snake_case` aliases (`file_name`, `target_file_id`, `insert_after`,
`match_mode`, …) are accepted by the worker parser.

**Never sent by the model:** `tenantId`, `projectId`, `siloId`, `documentId`,
`questionLogId`, `extractionRunId`, `taskKey`, `generatedByProvider`,
`generatedByModel`. The runtime binds all of these from the active run.

### 5.1 Validation rules

- At least one of `content`, `appendLines`, `insertLines` must be non-empty —
  otherwise: _"Generated files require content, appendLines, or insertLines."_
- `mode: "insert"` requires `insertAfter`, `insertBefore`, or both.
- `mode: "create"` with an existing `fileId` → _"Generated file ID already
  exists. Use overwrite, append, or insert mode to update it."_
- Any non-`create` mode with an unknown `fileId` → _"The requested generated
  file ID was not found."_
- Insert anchors that match nothing → _"Insert anchors were not found in the
  generated file."_

### 5.2 Mode semantics

Implemented twice — `writeGeneratedFile()` in
`apps/web/src/lib/generated-files.ts` and a mirrored copy in
`apps/worker/src/index.ts` (~line 8513). Keep both in sync when changing behaviour.

| Mode        | Resulting content                                                       |
| ----------- | ----------------------------------------------------------------------- |
| `create`    | `content` + any extra lines.                                            |
| `overwrite` | Same as create, but replaces the resolved existing file.                |
| `append`    | Existing body, trailing whitespace trimmed, `\n`, then the new content. |
| `insert`    | Existing body with the new lines spliced at the resolved anchor index.  |

### 5.3 Row update vs. new row (easy to get wrong)

The row is **updated in place only when an explicit `fileId`/`targetFileId` was
supplied and the mode is not `create`**. In that case the old storage object is
deleted after the new one is written.

Without an explicit ID, a non-`create` mode resolves the **most recent file with
the same name in the silo**, reads its content, and writes a **new row** — the
link back is kept in `metadata` as `appended_from_file_id`,
`overwritten_file_id`, or `inserted_from_file_id`. The old row and object stay.

Other metadata written on every call: `write_mode`, `temporary`,
`stable_file_id`, and for insert mode `insert_after`, `insert_before`,
`insert_occurrence`, `match_mode`.

### 5.4 Storage layout

```
bucket: generated-files
path:   generated/{tenantId}/silos/{siloId}/{ISO-timestamp}-{fileName}
```

Uploaded with `upsert: false`; `unique (bucket, storage_path)` on the table. If
the database write fails, the just-uploaded object is deleted — no orphans.

---

## 6. How each runtime handles the call

Same tool name, three materially different behaviours.

### 6.1 Vision (worker) — real tool execution

`apps/worker/src/index.ts` → `writeVisionGeneratedFilesFromToolCalls()`.

The worker scans the vision model's raw output with
`parseWriteFileToolCalls()`: every ` ```json ` fence plus a bare leading `{`/`[`.
Each parsed object whose `tool` / `toolName` / `tool_name` / `name` equals
`write_file` becomes a write. **Multiple writes per response are supported**, and
an array of calls is accepted. Objects missing `fileName`, `outputFormat`, or any
content field are skipped silently.

Requires the source document to be assigned to a silo, otherwise:
_"The write_file tool requires the source document to be assigned to a silo."_
Rows land with `task_key = 'vision'`, `metadata.generated_from = 'vision'`, plus
the source bucket/path and worker ID.

### 6.2 Ask — `write_file` is a loop terminator, not a writer

`apps/web/src/lib/ask-runs.ts` + `apps/web/src/lib/ask-model-execution.ts`.

1. `write_file` is filtered out of the run's allowed tools unless the request
   sets `outputFile.enabled`. Requesting an output file when the Ask task
   doesn't allow the tool → `422 write_file_tool_disabled`. A silo must be
   selected.
2. Before the model runs, any existing generated file with the same name and
   format in the silo is deleted (`generated_file.prepared` event reports
   `overwritten`).
3. If the model emits a `write_file` call carrying `content`, the loop takes that
   string as the **final answer and breaks immediately**. The reported tool
   result is: _"The final file body was accepted. Railway will store it after the
   model loop completes."_
4. After the loop, the app itself calls `writeGeneratedFile()` with
   `taskKey: "ask"`, `questionLogId` = the Ask run ID, `toolName: "write_file"`,
   `metadata.generated_from = "api-v1-ask"`. Source rendering
   (`renderAskOutput`) is applied by the app, not the model.

So on the Ask path every argument except `content` is discarded — `fileName`,
`outputFormat`, `mode`, `fileId`, and `metadata` from the model are ignored, and
the file name and format come from the API request instead.

### 6.3 Extraction — same terminator pattern, more forgiving

`apps/web/src/lib/extraction-model-execution.ts` +
`apps/web/src/app/api/extraction-tool/route.ts`.

- `write_file` bypasses the allowed-tools check entirely (explicit exception), so
  a stray call never fails the run for being "not enabled". The route still
  returns `422 write_file_tool_disabled` if the task config lacks the tool.
- A call carrying `content`, `appendLines`, or `insertLines` is treated as the
  final output (`isFinalWriteFileCall`) and ends the loop. As with Ask, only the
  body survives — `fileName`, `mode`, `metadata` and the rest are ignored, and
  the app writes the file itself from the extraction request's own output
  settings.
- A `write_file` call _without_ content gets this tool result back:
  _"The application already owns the generated file. Return the final file body
  directly without another write_file call."_
- `extractionFinalResponseInstruction()` tells the model up front: _"Do not call
  write_file or request a generated-file ID."_
- Defence in depth: `normalizeExtractionOutput()` unwraps a stray `write_file`
  envelope and keeps only `content`, recording
  `normalization: "write_file_content"`. A `write_file` envelope with no content
  raises _"The model returned a write_file request without final file content."_

### 6.4 `pdf_assembly`

Rows with `task_key = 'pdf_assembly'` are written by the worker directly during
document ingest (assembled Markdown, `temporary: true`) — not through a model
tool call.

---

## 7. The `generated_files` table

Key columns (full definition in `20260714000500_model_access_and_generated_files.sql`):

| Column                                                | Notes                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`                                                  | UUID PK; accepts a supplied `fileId`.                                                       |
| `tenant_id`, `project_id`, `silo_id`                  | Scope. Bound by the runtime.                                                                |
| `document_id`, `question_log_id`, `extraction_run_id` | Provenance links.                                                                           |
| `task_key`                                            | `vision` \| `ask` \| `extraction` \| `pdf_assembly`                                         |
| `file_name`, `output_format`, `mime_type`             | `md` → `text/markdown`, `csv` → `text/csv`, `json` → `application/json`, else `text/plain`. |
| `bucket`, `storage_path`, `byte_size`                 | `unique (bucket, storage_path)`.                                                            |
| `is_temporary`                                        | Set from `temporary`; drives cleanup sweeps.                                                |
| `generated_by_provider`, `generated_by_model`         | Which model produced it.                                                                    |
| `tool_name`                                           | Defaults to `write_file`.                                                                   |
| `content_preview`                                     | First 600 characters.                                                                       |
| `metadata`                                            | Merged write metadata (§5.3).                                                               |

RLS: `service_role` only.

---

## 8. Reading files back out

| Method   | Path                                               | Scope                    |
| -------- | -------------------------------------------------- | ------------------------ |
| `GET`    | `/api/v1/silos/{siloId}/generated-files`           | `generated-files:read`   |
| `GET`    | `/api/v1/generated-files/{fileId}/json`            | `generated-files:read`   |
| `GET`    | `/api/v1/generated-files/{fileId}/download`        | `generated-files:read`   |
| `POST`   | `/api/v1/generated-files/{fileId}/download-ticket` | `generated-files:read`   |
| `DELETE` | `/api/v1/generated-files/{fileId}`                 | `generated-files:delete` |

Ask and Extraction responses also return a `generatedFile` object with `id` and
`fileName`. Files flagged `is_temporary` are swept by
`/api/generated-files/temporary`. Full request/response detail lives in
[rest-api-command-reference.md](./rest-api-command-reference.md).

---

## 9. Gotchas

- **The model cannot write mid-loop on Ask or Extraction.** Only the Vision
  worker performs a real write from a tool call. Everywhere else `write_file` is
  a signal that the final body is ready — the app writes the file, and the
  model's `fileName`/`mode`/`metadata` are thrown away (§6.2, §6.3).
- **`get_new_id` does nothing today** (§4.2), despite being in the prompt: the
  worker parser drops it and the web app has no handler at all.
- **Two copies of `writeGeneratedFile()`** — `apps/web/src/lib/generated-files.ts`
  and `apps/worker/src/index.ts`. Change both.
- **Name-based resolution creates new rows**, it does not update the old one
  (§5.3). A repeated `append` without a `fileId` grows a chain of rows.
- **CSV needs a header row and JSON must parse** — enforced by prompt, not code.
- **Secrets must never appear in generated files**; the bucket is private but the
  rows are readable by any key holding `generated-files:read`.

---

## 10. Source files

| Concern                              | File                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Tool prompt text, schema, names      | `packages/rag-core/src/index.ts`                                                       |
| Web write implementation             | `apps/web/src/lib/generated-files.ts`                                                  |
| Worker write implementation + parser | `apps/worker/src/index.ts` (~8340-8700)                                                |
| Ask loop handling                    | `apps/web/src/lib/ask-model-execution.ts`, `ask-runs.ts`                               |
| Extraction loop handling             | `apps/web/src/lib/extraction-model-execution.ts`, `extraction-output.ts`               |
| Enable/disable + prompt snapshot     | `apps/web/src/app/api/model-tasks/route.ts`, `apps/web/src/app/configuration/page.tsx` |
| Table + bucket                       | `supabase/migrations/20260714000500_model_access_and_generated_files.sql`              |
