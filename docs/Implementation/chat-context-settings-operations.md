# NodeRag Chat Context and Settings Operations

**Applies to:** Chat stage C03 in the WSL/Linux Docker testbed
**Migration head:** `000021_chat_configuration`
**Feature flags:** `NODERAG_CHAT_PROVIDERS_ENABLED=true` and
`NODERAG_CHAT_CONTEXT_ENABLED=true`
**Chat execution:** disabled until C04

## Provider boundary

Every Ollama setting described here is for **Ollama Cloud**, never a local Ollama process. The Chat
provider service root is fixed at `https://ollama.com` and cannot be changed in Administration.
Ollama Cloud supplies Chat generation when an Ollama Cloud model is selected and is the only service
NodeRag will use for Chat internet search and web-page fetches. If OpenAI OAuth generates a response,
its bounded internet tools still call Ollama Cloud. A healthy OpenAI connection does not satisfy the
internet-readiness check.

## Opening the C03 screens

1. Start the testbed with both feature flags listed above. Keep `NODERAG_CHAT_UI_ENABLED` disabled.
2. Sign in as a server administrator.
3. Open **Administration**.
4. Open **Context window** to configure model capacity, rolling turns, reserves, and managed L1–L4
   context.
5. Open **Chat settings** to configure the default response model, quotas, retention, new-chat tool
   defaults, and Chat storage.

Search-only API keys receive a non-enumerating `404` for these routes. Ordinary signed-in users
receive `403`. Every save, preview, capacity update, and storage probe requires the browser CSRF token
and an idempotency key.

## Establishing model capacity

The Context window screen lists every current provider model. NodeRag resolves a model's context
capacity using this order:

1. provider-reported runtime value;
2. provider-configured value;
3. provider-advertised value;
4. administrator-entered verified fallback;
5. versioned known-model table;
6. Unknown.

Unknown remains Unknown. Provider authentication and model-list success are not capacity
measurements. Enter a fallback only when the value was verified for that exact provider/model
deployment, and record the source in **Fallback evidence note**. The administrator fallback survives model-
catalog refreshes. A catalog entry no longer returned by the provider is marked stale and cannot be
selected until it returns in a fresh catalog.

Output capacity uses provider metadata, then the administrator fallback, then the known-model table.
NodeRag describes output and input reserves as planning values; it does not claim they are limits
enforced by the provider.

For OpenAI OAuth, **Refresh models** reads each model's reasoning-effort choices from the connected
account's live Codex app-server `model/list` response. It also refreshes the raw Codex model catalog
and records `context_window` as the effective provider allocation and `max_context_window` as the
model maximum. If a future catalog reports a maximum-output field, NodeRag records it; otherwise the
output ceiling remains **not reported**. These values are model-specific, and NodeRag does not scrape
OpenAI documentation or substitute one universal list.

For Ollama Cloud, **Refresh Cloud models** performs three documented provider queries:

1. `/api/tags` lists the account's models.
2. `/api/show` returns capabilities, architecture context, and serialized model parameters for each
   model. `num_ctx` is stored as configured context. A positive `num_predict` or explicit output
   limit is stored as the provider output ceiling.
3. `/api/ps` returns the active context allocation when that exact model is currently listed. No
   running entry is normal and leaves the runtime value empty.

The Administration capacity card displays active, configured, advertised, and output values
separately. Total context is never reused as an output limit. A missing value remains **Unknown**.
For reasoning, GPT-OSS thinking models expose Default/Low/Medium/High; other models advertising the
`thinking` capability expose Default/None/High, where High enables thinking. Models without that
capability keep Default only.

## Rolling context

Rolling mode retains a bounded number of complete turns. A turn begins with one user message and
includes the resulting assistant and tool sequence. An unfinished assistant response is not admitted
as a complete turn. Configure these reserves:

- input headroom;
- assistant output;
- pinned instructions;
- tool results.

When model capacity is known, NodeRag rejects a combination whose reserves consume the whole context
window. With unknown capacity, rolling mode remains available as the conservative fallback.

## Managed L1–L4 context

Managed context adds:

- **L1:** exact administrator/user pins;
- **L2:** narrative summary;
- **L3:** JSON-schema-validated structured state;
- **L4:** complete recent turns.

Both Ollama Cloud and OpenAI OAuth are valid L2/L3 providers. Each layer must select a current model,
one of that model's live reasoning-effort choices, bounded instructions, and an output target. L3
also requires an object-shaped JSON schema. Managed mode requires verified context capacity for both
layer models. Layer output targets cannot exceed verified model output limits.

Saving creates a new immutable context revision and a paired settings revision that falls back to
rolling mode. Run **Synthetic preview** afterward. The preview constructs fake text locally; it does
not submit private document or chat content. It confirms that the selected L2/L3 models still have
healthy generation tests, reports estimated before/after tokens and projected provider calls, and
records independent L2/L3 readiness. Only then can managed mode be selected as the Chat default.

## Chat defaults and internet readiness

Select a response model only after its generation capability is healthy. Reasoning-effort choices
come from that model's current catalog. The three new-chat switches remain independent:

- attached Research;
- broader authorized RAG search;
- Ollama Cloud internet search.

The internet switch is disabled until both `web_search` and `web_fetch` are healthy on the fixed
Ollama Cloud connection. This condition applies when the selected response model is OpenAI OAuth as
well as when it is Ollama Cloud. Defaults do not grant a knowledge-space permission, and the future
Chat runtime must resolve current permissions on every tool call.

Configure the run timeout, maximum tool calls, parallel runs per user, optional daily run/input/output
quotas, archive age, and retention age. Archive age must not exceed retention age. C03 fixes output
artifacts to Markdown; later stages add files and deterministic DOCX/PDF exports.

Every save appends a new settings revision and moves the singleton current pointer in one database
transaction. Older revisions cannot be updated or deleted by normal application operations, so C04
can snapshot the exact revision used by a conversation.

## Chat storage

Enter an absolute server-side folder, not a folder on the administrator's browser. On the Docker
testbed this may be a mounted Linux path. On DSM it must resolve under `/volume1`, `/volume2`, or
another DSM volume and the NodeRag package user must have Read/Write permission at the shared-folder
level.

**Verify and initialize** performs a durable write/read-back test, checks capacity and policy, and
creates a private `.noderag-chat` child with a versioned `manifest.json`. A valid existing manifest is
reused. A file, symlink, malformed manifest, path escape, read-only location, unsupported DSM
filesystem, or insufficient reserve fails closed. The saved settings store both the requested root
and resolved contained Chat root.

The C03 database configuration participates in encrypted full backup and restore. Portable corpus
exports omit installation-specific Chat configuration. The configured external Chat file tree is
added to the recovery product in C10, after the file and archive formats exist.

## Troubleshooting

- **Model is Unknown:** enter a verified exact capacity and evidence note; do not infer it from login.
- **Only Default reasoning is shown:** refresh the relevant provider model catalog. If Ollama still
  reports only Default, that model's `/api/show` result did not advertise the `thinking` capability.
- **Model catalog stale:** refresh the provider's models and select a current entry.
- **Generation provider not ready:** run the provider generation test in **Chat providers**.
- **Managed context not ready:** save both managed layers, then run the synthetic preview again.
- **Internet not ready:** test both Ollama Cloud internet search and web-page fetch. OpenAI status does
  not affect this check.
- **Storage permission denied on DSM:** assign the NodeRag package user Read/Write permission on the
  shared folder, allow inheritance, and probe the shared-folder path again.
- **Storage capacity insufficient:** select a volume with enough free space for the configured Chat
  reserve.

No Synology SPK is built at C03. The Docker-tested changes remain additive until C11 produces and
verifies one immutable package containing all Chat milestones.
