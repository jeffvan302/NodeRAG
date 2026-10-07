# Context window management

This document describes the implementation in this repository as reviewed on
2026-09-15. It covers the settings under **Configuration > Runtime > Context
window management**, the per-task switch, and the runtime limitations.

See also [OpenAI OAuth](openai-oauth.md) and [Ollama settings](ollama-settings.md)
for provider connections and model-limit discovery.

## What the context window means here

A model's context window is the token capacity available to a request. The
conversation, instructions, tool definitions/results, and generated output all
need room. Three separate mechanisms appear in this application:

| Mechanism                | Purpose                                                                                            | Where it is configured                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Model capacity/profile   | Records reported, configured, or inferred model limits.                                            | Task `metadata.modelContext`; provider discovery.                               |
| Request budgeting        | Describes input/output allowances and may set provider request options on paths that support them. | Task `metadata.contextWindowPolicy` and provider-specific runtime code.         |
| Conversation compression | Replaces older conversation messages with summaries, state, and selected exact text.               | Tenant context-management config plus task `metadata.contextManagementEnabled`. |

Setting a larger number in the context-management table changes the compression
threshold. It does **not** increase the provider's capacity, configure Ollama's
`num_ctx`, or enforce an output limit. The compression calculation does not
subtract an output reserve from the window before applying its percentage.

## Enable it

1. Open **Configuration**, then **Runtime > Context window management**.
2. Enable **Enable context window management for tasks that opt in**.
3. Set the Layer 2 summary model and Layer 3 state model, including their
   providers and reasoning effort. Both model names default to empty; an
   enabled layer with an empty model makes no model call.
4. Set the percentage trigger and confirm the resolved model context size.
   For Ollama, use **Get context size** on the task first, or enter a researched
   value with a source note in the context-window table.
5. Save. Edit the relevant Ask or Extraction task, enable **Use context window
   management**, and save that task too.

Both switches must be on. Settings are loaded when a manager is created, so
start a new run to pick up changes. Existing conversations are not resized when
the settings are edited.

The UI also exposes the task switch for Template Ingestion, but the manager is
currently created only by the Ask run path and the interactive Extraction route.
This is not a platform-wide compressor for every worker, template, dataset, or
chat request. Native tool execution has additional limitations described below.

Sources: [configuration UI](../apps/web/src/app/configuration/page.tsx),
[Ask startup](../apps/web/src/lib/ask-runs.ts),
[Extraction startup](../apps/web/src/app/api/extraction-tool/route.ts),
[manager creation](../apps/web/src/lib/context-compression.ts).

## Global settings

These are the JSON field names accepted by `/api/context-management`.

| Field                         | Default                   | Allowed value and behavior                                                                                                       |
| ----------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                     | `false`                   | Master switch; the task must also opt in.                                                                                        |
| `strategy`                    | `hierarchical_structured` | The only implemented strategy.                                                                                                   |
| `frequencyEveryNPrompts`      | `0`                       | Integer 0–200. Zero disables this trigger. The current loops do not increment prompt-boundary counters; see runtime limitations. |
| `contextWindowTriggerPercent` | `70`                      | Integer 0–100. Zero disables the percentage trigger. Requires a known positive context size.                                     |
| `modelContextWindows`         | `[]`                      | Exact provider/model overrides; takes precedence over a profile or family fallback.                                              |
| `compressBetweenToolCalls`    | `true`                    | Allows evaluation at tool boundaries. This does not mean compress after every tool call; a trigger must still be due.            |
| `runLayersConcurrently`       | `true`                    | Requests parallel L2/L3 calls, subject to the Ollama capacity check.                                                             |
| `layers`                      | Defaults below            | Layer-specific settings.                                                                                                         |

Each `modelContextWindows` entry has:

| Field           | Constraint                                                                 |
| --------------- | -------------------------------------------------------------------------- |
| `provider`      | `ollama` or `openai`; `openai_oauth` is not an accepted override provider. |
| `model`         | Exact model name, trimmed, 1–180 characters. Lookup is case-insensitive.   |
| `contextTokens` | Integer 1–10,000,000. Zero is not a valid saved override.                  |
| `note`          | Optional source/explanation, up to 300 characters; defaults to empty.      |

The tenant-wide override applies to all uses of that exact provider/model in
this resolver. Model-family matching is used only for the built-in fallback,
not for entered values.

Source: [schemas and resolver](../packages/rag-core/src/index.ts).

## How the context size is resolved

`resolveContextWindowTokens()` uses this order:

1. **Entered**: a matching entry in `modelContextWindows`.
2. **Measured**: positive `metadata.modelContext.context.totalMaxTokens` passed
   from the task.
3. **Known**: the longest matching provider/model-name prefix in
   `KNOWN_MODEL_CONTEXT_WINDOWS`.
4. **Unknown**: `null`; the percentage trigger cannot run.

The built-in table is a fallback, not a live provider lookup. Also, the resolver
label `measured` only means a profile field was supplied: some profiles contain
catalog or configured values rather than a measured server allocation. Inspect
the profile's provenance before treating that number as verified capacity.

An unknown size emits `context.window.unknown` when a reporter is attached. The
message suggests the prompt-frequency trigger as an alternative, but that
trigger is not wired to prompt boundaries in the current loops. Supply a
context size and use an implemented tool-boundary path if automatic compression
is required.

The denominator is stored on the new conversation as `context_window_tokens`,
with `metadata.contextWindowSource`. The UI checks whether a profile matches
the selected task; manager creation directly reads the supplied `totalMaxTokens`.
Avoid carrying a stale profile across model changes. The model-task save route
clears old `modelContext` and `contextWindowPolicy` when the provider/model
changes unless the request explicitly supplies those fields again.

Sources: [resolver](../packages/rag-core/src/index.ts),
[manager](../apps/web/src/lib/context-compression.ts),
[task save route](../apps/web/src/app/api/model-tasks/route.ts).

## When compression runs

The decision function checks the following in order:

1. If globally disabled, do nothing.
2. If `compressionScheduled` is true, return the `forced` reason.
3. At a tool boundary, stop if `compressBetweenToolCalls` is false.
4. If a context size and percentage are positive, compare live tokens with
   `floor(contextWindowTokens × contextWindowTriggerPercent / 100)`.
5. Otherwise, check whether the prompt counter reached `frequencyEveryNPrompts`.

For example, a 32,768-token window at 70% triggers at 22,937 estimated live input
tokens. The remaining space is headroom, not a reserved provider output budget.
When the percentage fires at a tool boundary, its recorded reason is
`tool_call_boundary`; elsewhere the helper would use `context_window_percent`.

### Current integration limits

- The only calls to `compressIfDue()` are after ordinary parsed tool results
  in the Ask and Extraction loops, with `atToolCallBoundary: true`.
- There is no initial-prompt or between-prompts call. These loops increment the
  tool counter, not `promptsSinceCompression`, so **Every N prompts** does not
  currently trigger compression on its own.
- Native provider tool callbacks record results but do not call this compressor.
  This includes the OpenAI OAuth app-server, Ollama, and OpenAI-compatible
  native tool loops. Do not assume their internal tool turns obey these
  compression settings.
- In combined source/report Extraction, the source-preparation pass explicitly
  runs without a context manager; the report pass receives the configured one.
- Turning off `compressBetweenToolCalls` removes the currently integrated
  automatic evaluation point. Setting both triggers to zero also disables
  automatic compression.
- `scheduleCompression()` exists as a storage helper, but there is no exposed
  manual-compression route/button or scheduler caller. A UI summary saying
  “manual only” does not mean a manual operation is available.
- Large first prompts and oversized tool results can still exceed provider
  limits. This feature is not an exact request-size validator.

Sources: [trigger logic](../packages/rag-core/src/index.ts),
[Ask loop](../apps/web/src/lib/ask-model-execution.ts),
[Extraction loop](../apps/web/src/lib/extraction-model-execution.ts),
[scheduling helper](../apps/web/src/lib/conversations.ts).

## What each compression layer keeps

### Layer 0: artifact memory — unavailable

`layers.layer0.enabled` must be `false`. Capture/selection providers, model
names, reasoning efforts, instructions, and `maxInjectedRows` (default 12,
range 0–200) are reserved settings. The runtime does not capture or inject
artifact memory.

### Layer 1: selected exact text

This layer makes no model call. It scans messages whose role is `user` in
conversation order, keeping the first qualifying messages up to `maxPins`.

| Setting under `layers.layer1` | Default | Matching behavior                                                       |
| ----------------------------- | ------- | ----------------------------------------------------------------------- |
| `enabled`                     | `true`  | Enables selection.                                                      |
| `maxPins`                     | `50`    | Integer 0–200.                                                          |
| `pinFirstMessage`             | `true`  | First user-role message.                                                |
| `pinCodeBlocks`               | `true`  | Contains a fenced-code marker.                                          |
| `pinUrls`                     | `true`  | HTTP(S) URL or Windows drive path.                                      |
| `pinNumbers`                  | `true`  | Number-like text beginning with at least four digits.                   |
| `pinExplicitInstructions`     | `true`  | Keywords such as must, should, never, always, do not, required, ensure. |
| `pinUserFlagged`              | `true`  | `[PIN]`, “remember this”, or “important”, case-insensitive.             |

“Verbatim” has a size limit: each selected message is truncated to a 4,000-character
head/tail excerpt plus a truncation notice. These are role/text heuristics, not
a dedicated persisted pin-selection UI. Some agent tool continuations also use
the `user` role, so role-based selection is not proof of human authorship.

### Layers 2 and 3: summary and structured state

| Setting                 | Layer 2 default          | Layer 3 default     | Behavior                                                                                         |
| ----------------------- | ------------------------ | ------------------- | ------------------------------------------------------------------------------------------------ |
| `enabled`               | `true`                   | `true`              | A nonempty model is also required to call the provider.                                          |
| `provider`              | `ollama`                 | `ollama`            | `ollama` or `openai` (API-key provider); OAuth is not a layer option.                            |
| `model`                 | Empty                    | Empty               | Trimmed, up to 180 characters.                                                                   |
| `reasoningEffort`       | `default`                | `default`           | Uses the shared model-call adapter's provider-specific mapping.                                  |
| `maxTokens`             | `600`                    | `800`               | Integer 0–20,000; substitutes `{{max_tokens}}` in instructions. **Not a hard generation limit.** |
| `instructions`          | Narrative-summary prompt | State-update prompt | Trimmed, up to 12,000 characters; editable/resettable in the UI.                                 |
| `triggerThresholdTurns` | `8`                      | Not present         | Integer 0–200; stored for L2 but currently not read by the runtime.                              |

The shared reasoning enum accepts `default`, `none`, `minimal`, `low`, `medium`,
`high`, `xhigh`, and `max`. Supported choices and the value sent to the provider
depend on the model/adapter; see [Ollama reasoning](ollama-settings.md) for its
mapping. Layer providers use their configured access points and credentials.

L2 receives older messages, the prior summary, and prior structured state. L3
receives older messages and the prior state, and substitutes `{{schema}}` with
fields for the goal, constraints, preferences, decisions, failed approaches,
open questions, entities, current phase, and flagged notes.

The default L2 instructions contain `{{max_tokens}}`. The default L3 instructions
contain `{{schema}}` but no `{{max_tokens}}`; its token target therefore has no
prompt effect unless that placeholder is added. Neither call sends these
`maxTokens` values as a provider output cap. L3 extracts a JSON object from the
response; it does not validate every field against a strict JSON schema.

Each layer call has a fixed 120,000 ms timeout. A reported model-call failure
retains that layer's prior value and records an error. Malformed L3 JSON falls
back to the previous state. Compression can still fold messages after a layer
failure, or when a layer is disabled/unconfigured; configure the models before
relying on summaries to carry older information.

If concurrent execution is requested and neither layer selects Ollama, both
run in parallel. If either selects Ollama, the runtime sums
`max_parallel_calls` across enabled Ollama keys and requires at least three
configured slots. Otherwise, or if capacity cannot be read, it runs sequentially.
This is a configured-capacity check, not a measurement of currently idle slots.

### Layer 4: recent conversation

`layers.layer4.enabled` defaults to `true`; `minRecentTurns` defaults to 8 and
accepts integers 0–200. Despite the label “turns”, the code keeps that many
**message-array entries**, not complete user/assistant exchanges. Disabling L4
keeps zero recent entries.

If there are no entries outside this recent slice, compression is skipped with
`nothing_outside_recency_window`. A completed pass builds a block containing
L3 state, L2 summary, L1 selections, and L4 recent excerpts. It then replaces
the live array with one `user` message containing that block, followed by the
original recent entries. Recent content is therefore present in both places.
Within the block, assistant excerpts are limited to 12,000 characters and
other-role excerpts to 6,000, plus notices; appended recent entries remain intact.

Sources for all layers: [schemas/default prompts](../packages/rag-core/src/index.ts),
[compression implementation](../apps/web/src/lib/context-compression.ts).

## Storage, accounting, and diagnostics

Configuration lives in the Settings service's `context-management` collection,
keyed by tenant ID. Its API uses camelCase fields; the stored record uses
snake_case, such as `frequency_every_n_prompts`. Historical context-management
SQL migrations are not the current settings write path.

Runtime history lives in the relational data plane:

| Table                                | Contents                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `conversations`                      | Scope, provider/model, resolved window, live token estimate, and usage-total fields. |
| `conversation_messages`              | Ordered messages with token estimates and `in_context`/`pinned` flags.               |
| `conversation_runs`                  | Run status, tool-call count, and input/output usage fields.                          |
| `conversation_compression_state`     | Current compressed block, L2/L3 state, counters, compression count.                  |
| `conversation_compression_snapshots` | Compression reason, before/after estimates, timing, layer errors.                    |

Compression marks folded unpinned rows `in_context = false`; it does not delete
their original text. It saves the new state, resets counters, and adds a
snapshot. Each manager creation starts a new conversation/run; this alone does
not implement resumable memory across separate requests.

Token accounting uses `ceil(text.length / 4)` per text field, plus eight tokens
per message. The estimator includes role, content, name, tool-call ID, reasoning,
and serialized tool calls when supplied. Live totals sum retained/pinned stored
message estimates plus the compressed-block estimate. The storage helpers accept
provider usage separately, but the current Ask and Extraction manager `finish()`
calls pass only status and tool-call count. These conversation usage fields
therefore stay at their default zero values; they are not a source of actual
provider usage. The manager also does not replace stored message estimates with
exact provider token counts. Stored tool messages and actual
prompt wrappers differ, and instructions/tool definitions are not fully covered
by this live-history estimate.

With a reporter attached, useful events are `context.window.unknown`,
`context.compression.started`, `context.compression.skipped`, and
`context.compression.completed`. Completion includes the trigger, concurrency
decision, folded/kept counts, compressed size, and layer errors. Ask additionally
emits `context.management.unavailable` if manager initialization fails and then
continues without it; interactive Extraction also continues without a manager
on initialization failure. That startup fallback is not a blanket guarantee
that later persistence errors cannot interrupt execution.

Sources: [settings adapter](../apps/web/src/lib/context-management.ts),
[conversation storage](../apps/web/src/lib/conversations.ts),
[token-total SQL](../supabase/migrations/20260803000200_conversation_store.sql).

## Read and update settings through the application API

These are internal application routes protected by the signed-in portal session
when administrator authentication is enabled, not public `/api/v1` endpoints
authenticated with a Bubble API key. A configured,
ready relational data plane is also required by the context-settings route.

| Operation          | Request                                                                                       | Response                                                              |
| ------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Read tenant config | `GET /api/context-management?tenantId=<tenant-uuid>`                                          | `{ "config": { ... } }`, including `id`, `tenantId`, and `updatedAt`. |
| Save tenant config | `PUT /api/context-management` with config fields and optional `tenantId`                      | `{ "config": { ... } }`.                                              |
| Read task config   | `GET /api/model-tasks`                                                                        | Saved model tasks, including context metadata.                        |
| Enable a task      | `PUT /api/model-tasks` with the task definition and `metadata.contextManagementEnabled: true` | Updated task configuration.                                           |

Omitting `tenantId` uses `DEFAULT_TENANT_ID`. Context config PUT is parsed as a
whole configuration with schema defaults; it is **not** a partial patch. Read
first and preserve the settings you want to keep. For example, in a signed-in
same-origin browser session:

```javascript
const response = await fetch("/api/context-management");
if (!response.ok) throw new Error(await response.text());
const { config } = await response.json();
const { id, updatedAt, ...settings } = config;

const saved = await fetch("/api/context-management", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    ...settings,
    contextWindowTriggerPercent: 60,
    compressBetweenToolCalls: true,
  }),
});
if (!saved.ok) throw new Error(await saved.text());
```

This example changes the trigger while preserving the existing enablement and
layer settings. For task opt-in, use the UI or read the task and preserve its
provider, model, instructions, tools, scope, and metadata when saving.

Sources: [context API](../apps/web/src/app/api/context-management/route.ts),
[model-task API](../apps/web/src/app/api/model-tasks/route.ts),
[session gate](../apps/web/src/proxy.ts).

## Troubleshooting

| Symptom                                 | Check                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing compresses                      | Both enablement switches, positive known window/percentage, `compressBetweenToolCalls`, and whether execution uses a supported parsed-tool boundary. |
| Every N prompts has no effect           | Current loops have no prompt-boundary evaluation.                                                                                                    |
| Context size is unavailable             | Refresh the task's provider metadata, or enter an exact supported provider/model override with a source note.                                        |
| Compression keeps skipping              | The message array has no entries older than `minRecentTurns`.                                                                                        |
| Summary/state stays empty               | L2/L3 model names, provider access, enabled flags, and layer errors.                                                                                 |
| Provider still reports context overflow | Check actual provider capacity, request output budget, first-prompt/tool sizes, estimate error, and native-path coverage.                            |
| L2/L3 run sequentially                  | Concurrent toggle, enabled Ollama key capacity, or failure to read the pool.                                                                         |
| Changing Max tokens has little effect   | It is prompt substitution, not an output cap; the default L3 prompt lacks that placeholder.                                                          |
