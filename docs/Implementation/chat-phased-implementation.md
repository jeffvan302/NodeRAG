# NodeRag Chat Capability — Phased Implementation Plan

**Status:** Active planning authority; C00–C10 testbed complete and C11 in progress
**Created:** 2026-09-15
**Baseline:** NodeRag 1.0.0 package revision 26; Chat migration head `000028_chat_managed_context`
**Primary environment:** WSL/Linux Docker testbed
**Final environment:** Synology DSM 7.2+, x86_64, through a later immutable SPK candidate
**Delivery stream:** C00–C11, additive to the existing NodeRag M00–M14 plan
**Source notes:** `docs/ollama-settings.md`, `docs/openai-oauth.md`, and `docs/context-window.md`

**Ollama constraint for Chat:** Every Ollama capability in this plan means **Ollama Cloud**, not a
local, self-hosted, forwarded, or custom Ollama server. NodeRag uses the fixed
`https://ollama.com` service root for Cloud model generation and for Chat's hosted internet-search
tools. Chat never calls a local Ollama process. Existing non-Chat vision-provider configuration is
outside this constraint and remains a separate capability.

**Chat internet-provider constraint:** Ollama Cloud is the sole internet-search and web-fetch
provider for Chat. `web.search.v1` and `web.fetch.v1` call Ollama Cloud's hosted APIs even when an
OpenAI OAuth model generates the final response. NodeRag must not substitute OpenAI web search,
direct model networking, a browser automation service, or a local Ollama process.

---

## 1. Purpose and completion contract

This document is the step-by-step delivery plan for adding a durable, provider-backed Chat workspace
to NodeRag. It is written so an implementation system can execute one bounded work package at a time
without silently widening user access, exposing provider credentials, bypassing NodeRag's knowledge-
space permissions, or treating a browser session as the durable owner of a long model run.

The visible outcome is a **Chat** navigation item immediately below **Research**. The Chat page has a
conversation list on the left and the selected conversation on the right. A user can create a named
chat, attach one or more personal Research collections, independently allow or deny broader RAG
searches and internet access, converse with a configured model, review source citations and tool
activity, and work with files owned by that chat.

Administration gains three sections before the Chat page is enabled:

1. **Providers** — configure, test, save, disable, and inspect Ollama Cloud and OpenAI OAuth
   connections.
2. **Context Window** — configure model-capacity records, rolling context, and managed compression.
3. **Chat Settings** — choose the default chat model, reasoning effort, context mode, run limits, chat
   storage root, and feature defaults.

A capability milestone is complete only when its schema, migrations, authorization inventory,
runtime validation, API contract, deterministic automated tests, operator documentation, and proof
artifact pass. Live provider tests are additional evidence; they never replace deterministic fakes.
No Synology package revision is built for the intermediate C00–C10 milestones. C11 produces a new
SPK only after the complete Docker testbed suite passes.

---

## 2. Existing NodeRag foundation to reuse

The implementation must extend, rather than duplicate, these existing facilities:

- authenticated browser sessions, CSRF enforcement, idempotency keys, principals, and server-admin
  checks;
- independent `read`, `upload`, and `delete` grants for each knowledge space;
- personal Research collections and page/passage references spanning knowledge spaces;
- current-access filtering that hides Research references after a user loses a knowledge-space grant;
- canonical Markdown, document/page/chunk locators, original downloads, PDF and Markdown viewers;
- encrypted provider-secret storage backed by NodeRag's package root key;
- the durable PostgreSQL job queue, retries, leases, progress events, and Administration logs;
- managed-storage probing, Synology ACL handling, path containment, free-space checks, and atomic file
  promotion;
- generated OpenAPI, route-authorization inventory, RFC 9457 errors, audit events, and request IDs;
- the existing Docker testbed, package simulator, release freeze, SBOM, and security gates.

The current database head is `000018_research_page_references`. If that is still the head when work
begins, the first chat migration is `000019_chat_provider_foundation`. If another migration lands
first, renumber the proposed chat migrations without reusing an identifier or editing an applied
migration.

---

## 3. Decisions locked for this plan

### 3.1 Ownership and administration

1. Provider connections and default Chat/Context settings are system-wide because they are managed
   in Administration. Only a server administrator may create, test, change, or disconnect them.
2. ChatGPT/OpenAI OAuth is initially one server-wide service connection. The Administration screen
   must state that authorized NodeRag users consume the connected account's capacity. Per-user OAuth
   is a later extension, not an implicit part of this plan.
3. Each chat is owned by one signed-in user. Ordinary users can list and read only their own chats.
   Server administrators can inspect operational metadata but do not get a normal UI for reading
   another user's messages or files.
4. Add a principal-level **Chat enabled** entitlement. It defaults to enabled for server
   administrators and disabled for existing non-admin users during migration. Enabling Chat does not
   grant access to any knowledge space.
5. Search-only API keys cannot access Chat, Research attachments, chat files, provider metadata, or
   chat runs.

### 3.2 Independent data/tool permissions

Every chat records three independent switches:

| Capability              | Meaning                                                                                                                | Authorization at every execution                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Attached Research       | Read the selected Research reference snapshots and the canonical Markdown of documents represented by those references | Chat owner plus a current `read` grant for the document's knowledge space                                 |
| Allow RAG search access | Search any knowledge space the current user can read                                                                   | Resolve the user's current `SiloScope`; never reuse the scope from chat creation                          |
| Allow internet access   | Use NodeRag's bounded Ollama Cloud web-search/web-fetch tools                                                          | A tested Ollama Cloud web-search capability plus the chat switch; no direct unrestricted model networking |

These switches must not imply one another. A Research-only chat can analyze its attached material
without internet access or a broad RAG search. A RAG-enabled chat does not automatically gain
internet access. Revoking a knowledge-space grant takes effect on the next tool call, even in an old
chat.

### 3.3 Provider and model boundaries

1. Define one internal `ChatProvider` contract and implement `ollama_cloud` and OpenAI OAuth
   adapters behind it. UI code never calls providers directly.
2. The `ollama_cloud` adapter has no administrator-editable base URL. It uses the fixed HTTPS
   service root `https://ollama.com`, with generation at `POST /api/chat`, internet search at
   `POST /api/web_search`, and result retrieval at `POST /api/web_fetch`.
3. Local, self-hosted, forwarded, and custom-address Ollama servers are explicitly out of scope for
   Chat. The server rejects a non-Cloud base URL if an older client attempts to submit one.
4. One encrypted Ollama Cloud API key authorizes generation, web search, and web fetch. Each
   capability nevertheless has its own test status, latency, failure details, and last-tested time,
   so generation success never falsely certifies internet access.
5. “Ollama Cloud generation configured” is not sufficient to enable the internet checkbox. The UI
   enables it only when both the web-search and web-fetch capability tests are healthy.
6. Ollama Cloud is Chat's only internet-search provider. This remains true when OpenAI OAuth is
   selected to generate the assistant response: NodeRag exposes its bounded Ollama Cloud search and
   fetch tools to that model. OpenAI OAuth browsing and direct model networking are out of scope.
7. OpenAI OAuth uses the bundled Codex app-server's managed ChatGPT device-code flow. NodeRag does
   not create its own OAuth client secret or accept pasted browser tokens.
8. OpenAI model names and reasoning-effort choices come from the connected account's live model
   catalog. Unknown context sizes remain **Unknown** until a documented or manually entered profile
   is saved; authentication success must not be described as a context measurement.
9. Populate Ollama Cloud model choices from authenticated `/api/tags`, then query each returned model
   through `/api/show`. Read the model's `capabilities`, architecture `*.context_length`, configured
   `num_ctx`, and a positive `num_predict` or explicit output-limit field when supplied. Query
   `/api/ps` for a matching active model allocation; an empty running-model list is valid. Preserve
   advertised, configured, and active values separately and resolve them in the precedence defined
   in §3.4. Never derive an output limit from total context or from a model's prose response.

| Chat capability                            | Required backend                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| Generate with an Ollama model              | Ollama Cloud `POST https://ollama.com/api/chat`                                 |
| Generate with the connected OpenAI account | OpenAI OAuth through the bundled Codex app-server                               |
| Search the public internet                 | Ollama Cloud `POST https://ollama.com/api/web_search`, regardless of chat model |
| Fetch a selected search result             | Ollama Cloud `POST https://ollama.com/api/web_fetch`, regardless of chat model  |

### 3.4 Conversation and context boundaries

1. PostgreSQL is the authority for chat identity, ownership, messages, tool calls, citations, run
   state, context state, and artifact metadata.
2. The configured chat folder contains recoverable, checksummed chat-log segments and chat-owned
   files. It is not an uncoordinated second database. Import/reconciliation is an explicit operation.
3. Original messages are never deleted by context compression. Older live-context rows are marked
   out of context and remain available through **View older logs**.
4. Managed context evaluates capacity before every provider request, after every tool result, and
   before admitting an oversized tool result. This closes the prompt-boundary and native-tool gaps
   documented in the reference implementation.
5. Rolling context is a simple bounded recent-turn policy with explicit input/output reserves. It
   does not create summaries.
6. Managed context uses four active layers:
   - L1 selected exact text and user pins;
   - L2 narrative summary;
   - L3 schema-validated structured state;
   - L4 complete recent user/assistant turns.
7. “Turn” means one user message plus its resulting assistant/tool sequence. It never means an
   arbitrary count of message-array entries.

### 3.5 Reasoning display

The UI may show provider-supplied, user-displayable reasoning summaries and NodeRag's own tool
activity such as “Searching attached research” or “Creating report.md.” It must not fabricate,
request, persist, or expose private hidden chain-of-thought. Ollama's explicit public `thinking`
field and OpenAI app-server reasoning-summary events must be stored separately from the final answer,
clearly labelled, bounded, and omitted when the provider does not return an appropriate summary.

### 3.6 Files and document generation

1. Markdown is the default output artifact.
2. Models do not receive a shell, raw filesystem path, direct database connection, or arbitrary
   network client. They receive narrow NodeRag tool calls validated by the server.
3. Chat file paths are relative, normalized, and contained below that chat's `docs/` directory.
   Symlink, junction, traversal, device-file, alternate-stream, and case-collision escapes are denied.
4. Line editing uses optimistic concurrency: every patch names the expected file SHA-256. A stale
   patch fails with a conflict and must be regenerated from the current file.
5. Markdown preview reuses NodeRag's sanitized reader. Mermaid and LaTeX are rendered through the
   existing safe paths. Arbitrary scripts and executable embedded HTML remain blocked. Embedded web
   content, if later enabled, uses an administrator allow-list and a sandboxed, no-same-origin frame.
6. DOCX and PDF are generated by deterministic server-side converters from a normalized document
   model or Markdown. The model never emits or patches binary Office/PDF bytes directly. Generated
   DOCX files contain no macros or external relationships.
7. “Upload to RAG database” copies an immutable artifact snapshot into the existing upload/ingestion
   pipeline. Later chat edits do not silently mutate the indexed document.

### 3.7 Data egress and privacy amendment

The original NodeRag architecture said that only vision images leave the NAS. Cloud chat changes
that boundary: prompts, selected Research excerpts, tool results, and possibly generated artifacts
may be sent to Ollama Cloud or OpenAI. Before Chat is activated, add an ADR and UI disclosure that
states exactly what each provider receives. Every new chat shows its provider and egress status.
Provider tests use synthetic text only. No private document content is sent during setup tests.

---

## 4. Target architecture

```text
Browser Chat UI
  │ create chat / send message / page older logs / manage files
  ▼
Fastify Chat API ── owner + CSRF + Chat-entitlement gate
  │
  ├── PostgreSQL: chats, messages, runs, tool calls, citations, context snapshots
  ├── Chat file store: append-only log segments + docs + generated exports
  └── Durable chat worker
        │
        ├── Context budget/compression coordinator
        ├── Tool policy and execution loop
        │     ├── attached Research/page/document tools
        │     ├── current-scope RAG search tool
        │     ├── Ollama Cloud web search/fetch tools
        │     └── sandboxed chat file/artifact tools
        └── Provider adapter
              ├── Ollama Cloud chat API
              └── Codex app-server / ChatGPT OAuth
```

The browser submits a message and receives a durable run ID. The worker owns provider streaming and
tool execution. The API exposes resumable server-sent events and database-backed history, so closing
the page or losing the reverse-proxy connection does not cancel the run.

---

## 5. Proposed persistence model

Use forward-only migrations and apply the existing restricted runtime role/RLS conventions. Exact
names may change during schema review, but the responsibilities must remain separate.

| Table                         | Required responsibility                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_provider_connection`    | Provider kind, label, fixed service identifier, enabled state, per-capability test status, non-secret account summary, timestamps                        |
| `encrypted_secret`            | Reuse for the Ollama Cloud API key and encrypted OpenAI OAuth credential cache; never return ciphertext through an API                                   |
| `chat_model_profile`          | Provider/model identity, catalog metadata, supported reasoning efforts, advertised/configured/runtime context, output limit, provenance and checked time |
| `chat_context_settings`       | Global enablement, rolling/managed defaults, trigger thresholds, L1–L4 configuration, L2/L3 provider/model selections                                    |
| `chat_settings`               | Default generation provider/model/effort, context mode, timeouts, tool/run limits, feature defaults, storage location ID                                 |
| `chat_entitlement`            | Principal allowed to use Chat, who changed it, and when                                                                                                  |
| `chat_conversation`           | UUID, owner, name, provider/model/effort snapshot, context-mode snapshot, tool switches, state, timestamps                                               |
| `chat_research_attachment`    | Attached Research collection, source revision/time, refresh state                                                                                        |
| `chat_research_snapshot_item` | Immutable reference identity, document/page/chunk locator, source hashes, citation label, and source Research item ID                                    |
| `chat_message`                | Ordered user/assistant/tool/system messages, visible kind, final flag, token estimate, in-context flag, archived-segment ID                              |
| `chat_run`                    | One response attempt, durable state, lease, provider request identity, usage, finish reason, error, cancellation                                         |
| `chat_tool_call`              | Tool name, validated arguments digest, bounded result, status, timing, error, and policy decision                                                        |
| `chat_citation`               | Message/tool call to knowledge-space document/page/chunk or web URL, title, locator, confidence, retrieval time, content hash                            |
| `chat_context_state`          | Current L1 pins, L2 summary, validated L3 state, L4 boundary, token estimates, compression counter                                                       |
| `chat_context_snapshot`       | Immutable before/after compression receipt, trigger, models, usage, errors, and log segment                                                              |
| `chat_artifact`               | Relative path, MIME/type, SHA-256, bytes, revision, creator/tool, state, source provenance                                                               |
| `chat_artifact_ingest`        | Artifact revision to knowledge space/document/job mapping and ingestion outcome                                                                          |

Recommended conversation states are `active`, `archived`, and `purging`. Recommended run states are
`queued`, `preparing_context`, `calling_model`, `executing_tool`, `compressing`, `succeeded`,
`failed`, and `cancelled`. Permit only one active run per conversation; a second send returns a
conflict or queues behind the active run according to an explicit later policy.

### 5.1 Chat folder layout

```text
<configured-chat-root>/.noderag-chat/
  manifest.json
  users/<principal-id>/
    chats/<chat-uuid>/
      manifest.json
      logs/
        active.ndjson
        archive/000001.ndjson.gz
        archive/000001.sha256
      docs/
        report.md
        supporting/
      exports/
        report.docx
        report.pdf
      downloads/
        web/
      tmp/
```

Create directories as the NodeRag package user with owner-only permissions where DSM ACLs permit.
Use write-to-new-file, fsync, atomic rename, and directory fsync. Never follow a symbolic link while
opening or promoting a chat file. Each log event has a schema version, event ID, chat/run/message ID,
timestamp, content hash, and previous-event hash. The per-chat manifest records segment ranges and
checksums so an interrupted archive can be reconciled.

The import path accepts only this versioned format. It first performs a read-only inventory and
checksum validation, shows what will be imported, then writes database rows idempotently. Unknown,
corrupt, or conflicting chat folders are quarantined and never partially imported.

---

## 6. Provider and tool contracts

### 6.1 Internal provider interface

Every adapter implements equivalent semantics:

```ts
interface ChatProvider {
  testConnection(input: ProviderTestInput): Promise<ProviderTestResult>;
  listModels(): Promise<readonly ChatModelDescriptor[]>;
  inspectModel(model: string): Promise<ModelContextProfile>;
  streamTurn(input: ChatTurnInput, sink: ChatEventSink): Promise<ChatTurnResult>;
  cancel(providerRequestId: string): Promise<void>;
}
```

The shared descriptor records model ID, display name, text/tool capability, returned reasoning-
effort options, context/output values with provenance, and whether each value is live, configured,
documented, manually entered, estimated, or unknown.

Normalize provider events into `response.started`, `reasoning.summary.delta`, `text.delta`,
`tool.requested`, `usage.updated`, `response.completed`, and `response.failed`. Persist event sequence
numbers before broadcasting them so SSE reconnection can resume with `Last-Event-ID`.

### 6.2 Tool contract

Each tool definition includes:

- stable name and version;
- JSON Schema for arguments and result;
- authorization function evaluated immediately before execution;
- timeout, maximum result bytes/tokens, and maximum calls per run;
- audit category and citation behavior;
- whether its result may be written to the chat log;
- a prompt-injection classification and content wrapper.

Initial tools:

| Tool                              | Availability                                        | Result                                                                            |
| --------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `research.list_sources.v1`        | Attached Research                                   | Citation-safe list of attached references/documents                               |
| `research.read_page.v1`           | Attached Research plus current read grant           | Canonical Markdown for one referenced page with locator/provenance                |
| `research.read_document.v1`       | Attached Research plus current read grant           | Bounded Markdown ranges with paging; never an unbounded entire corpus dump        |
| `rag.search.v1`                   | `allowRagSearch=true`                               | Existing search response narrowed to the current user's readable knowledge spaces |
| `document.read_markdown.v1`       | Result from Research or RAG plus current read grant | Bounded canonical Markdown range                                                  |
| `web.search.v1`                   | `allowInternet=true` plus tested Cloud capability   | Ollama Cloud web-search results with URLs and retrieved time                      |
| `web.fetch.v1`                    | Same as web search                                  | Sanitized fetched content for one result URL                                      |
| `files.list/read/create/patch.v1` | Chat owner                                          | Sandboxed chat-doc operations with hashes and limits                              |
| `artifact.export.v1`              | Chat owner and enabled format                       | Deterministic Markdown-to-DOCX/PDF export job                                     |

Tool output is untrusted source material, not an instruction. Wrap it with immutable provenance and
explicitly instruct the model not to follow commands embedded in retrieved documents or webpages.

---

## 7. Administration user experience

### 7.1 Providers

The Providers section contains one card per connection.

**Ollama Cloud card**

- label and enabled switch;
- read-only service root `https://ollama.com` and the generation, search, and fetch endpoint names;
- masked Ollama Cloud API-key field with Replace/Clear actions and configured fingerprint/status;
- optional application capacity limits: parallel calls, requests/minute, tokens/minute;
- generation model used only for the synthetic connection test;
- **Test generation**, **Test web search**, **Test web fetch**, and **Save** as separate actions;
- returned latency, generation health, web-search health, web-fetch health, and last test time for
  each capability;
- clear notice that model prompts, selected document excerpts, search queries, and fetched URLs are
  sent to Ollama Cloud when the corresponding capability is used.

All three tests use the same stored Cloud key and synthetic, non-private input. The web-search test
uses a benign fixed query; the fetch test retrieves a fixed public test page or a URL returned by
that query. A successful generation test must not mark web search or web fetch available, and a web
test must not mark model generation healthy.

**OpenAI OAuth card**

- availability of the bundled app-server runtime;
- disconnected, sign-in-pending, connected, refreshing, error, and disabled states;
- **Sign in with OpenAI**, displaying a selectable device code and an external verification link;
- bounded status polling that survives page navigation and expires cleanly;
- connected email/plan summary when returned, without exposing tokens;
- **Refresh models**, **Test connection**, and **Disconnect**;
- explicit notice that this is a shared server connection and may consume the account's limits.

### 7.2 Context Window

Separate model capacity from context strategy.

1. **Model profiles:** provider/model, advertised limit, configured limit, runtime allocation, maximum
   output, source/provenance, checked time, warning, and an administrator-entered override with note.
2. **Rolling context:** recent complete turns, input budget percentage, output reserve, tool-result
   reserve, and behavior when a single request cannot fit.
3. **Managed context:** trigger percentage, pre-request/tool-boundary evaluation, concurrency, L1
   pin rules, L2 summary model/instructions/output target, L3 state model/schema/instructions/output
   target, and L4 recent complete turns.
4. **Test and save:** validate both L2 and L3 providers/models, inspect context sources, run a
   synthetic compression example, display before/after estimates, and save only if every enabled
   required layer is operable.

For OpenAI OAuth, provider and model are dropdowns populated from the live account catalog; reasoning
effort is restricted to that model's returned values. NodeRag does not scrape documentation at
runtime or apply one global OpenAI effort list. For Ollama Cloud, `/api/show` capability metadata
determines whether the selector offers no override, a Boolean thinking toggle, or GPT-OSS
low/medium/high levels. Context discovery labels architecture maximum, model configuration, and
active `/api/ps` allocation separately. Missing output metadata remains Unknown rather than being
inferred from the total context window.

### 7.3 Chat Settings

- default provider, model, and reasoning effort;
- default context mode: managed or rolling;
- default internet and RAG switches, both off unless explicitly enabled;
- maximum provider turns, tool calls, wall-clock duration, output reserve, and tool-result size;
- whether user-displayable reasoning summaries are shown;
- chat storage location with **Browse**, **Probe**, and **Save**;
- log-segment size/age, retention, and optional compression settings;
- allowed generated formats and per-file/per-chat storage quotas;
- Markdown safe-content policy and optional sandboxed web-embed allow-list;
- current storage health, free space, last reconciliation, and orphan/corruption counts.

Saving Chat Settings must use the same persistence-safe reload pattern as revision 26: after save,
navigate away and back in an automated browser test and confirm every value remains.

---

## 8. Chat user experience

### 8.1 Navigation and layout

Sidebar order becomes:

1. Search
2. Research
3. Chat
4. Knowledge Bases
5. Ingest
6. Operations
7. Administration

Desktop Chat uses a two-panel layout. The left panel has search/filter, **New chat**, active chats,
archived chats, last activity, provider indicator, and running/error badges. The right panel has the
chat title and configuration summary, message history, source/tool activity, artifact drawer, run
status, and composer. On narrow screens, the chat list becomes a drawer and the composer remains
keyboard accessible.

### 8.2 New-chat dialog

The dialog requires a name and offers:

- provider/model/reasoning values initialized from Chat Settings and editable within allowed models;
- checkboxes for the owner's visible Research collections, showing item and document counts;
- **Allow RAG search access**;
- **Allow internet searches**, disabled with an explanation unless the Ollama Cloud web-search and
  web-fetch capabilities are tested and enabled;
- context mode, managed or rolling;
- a data-egress summary that changes with provider and tool selections.

Creating a chat snapshots its configuration and selected Research references. Settings changes do
not silently change an existing chat. A later **Update chat configuration** action creates an audited
configuration revision.

### 8.3 Messages and activity

- user messages are right-aligned bubbles;
- assistant final answers are visually distinct, labelled **Answer**, and left-aligned;
- reasoning summaries, when available, are collapsible and labelled **Model reasoning summary**;
- tool steps show status, duration, source count, and an expandable bounded preview;
- citations open the existing PDF/Markdown viewer at the cited page/location;
- Stop requests cancellation but preserves all events already received;
- Retry creates a new run linked to the failed run and never overwrites the old record;
- the composer is disabled while a run is active unless queued turns are deliberately implemented;
- the page reconnects to a running response using its last persisted event ID.

At the top of the loaded history, show the context boundary and a **View older logs** button. Loading
older messages is cursor-paginated; never send an entire long chat in one response.

### 8.4 Files

The artifact drawer supports folders, revision history, safe preview, download, rename, copy, and
explicit deletion confirmation. Markdown opens in NodeRag's rich reader. DOCX and PDF use downloads
and the appropriate viewer where supported. Each artifact shows who/what created it, size, hash,
revision, source citations, and whether that exact revision was uploaded to a knowledge space.

The **Upload to RAG database** dialog requires a knowledge space for which the user currently has
`upload`. It displays the immutable artifact revision/hash, queues the existing ingestion workflow,
and links to its progress. Ingestion failures remain visible without damaging the chat artifact.

---

## 9. Phased delivery sequence

### C00 — Scope, privacy, and feasibility gate

**Goal:** settle architecture-invalidating questions before adding schema or UI.

#### Work packages

1. Add an ADR amending the “only images leave the NAS” boundary for cloud chat.
2. Confirm the system-wide provider/per-user chat ownership model and Chat entitlement defaults.
3. Define retention, archive, explicit purge, backup, and restore semantics for chat data.
4. Specify the `ChatProvider`, normalized event, model-profile, and tool contracts.
5. Pin and license-review the Ollama Cloud HTTP adapter dependencies and the exact
   Codex/app-server package version.
6. In Linux x86_64 Docker, launch the pinned app-server, initialize it, call unauthenticated status,
   and shut it down without leaving credentials.
7. Verify the app-server binary and required native libraries on the target DSM toolchain/package
   layout. Record real NAS execution as deferred until C11 if the NAS is not used yet.
8. Build deterministic fake Ollama Cloud and fake OAuth/app-server transports for all later tests.
9. Define threat models for shared OAuth billing, credential theft, prompt injection, tool abuse,
   path traversal, SSRF, oversized context/tool output, malicious Markdown, and chat-log import.
10. Create feature flags with all new user-visible capability disabled.

#### Tests and evidence

- dependency/license/security scan;
- provider contract tests against both fakes;
- process start/timeout/kill/cleanup test;
- threat-model review and data-flow diagram;
- `c00-chat-proof.json` and `c00-chat-checklist.md`.

#### Exit gate

Exit only when the provider runtimes are packageable, the egress policy is approved, credential
storage is defined, and no model receives a raw shell/filesystem/network capability.

---

### C01 — Provider persistence and Ollama Cloud Administration

**Goal:** deliver the first Administration-only provider connection with no Chat page.

#### Work packages

1. Add migration `000019_chat_provider_foundation` for provider connections, model profiles, Chat
   entitlements, and required constraints/indexes.
2. Reuse `encrypted_secret` for one Ollama Cloud API key. Retain the saved key when the submitted
   field is blank; replace or clear it only through an explicit administrator action.
3. Fix the service root to `https://ollama.com`, construct only the approved `/api/chat`, `/api/tags`,
   `/api/show`, `/api/ps`, `/api/web_search`, and `/api/web_fetch` endpoints, require HTTPS, and apply
   timeout, redirect, and response-size policy. Reject custom, local, private, forwarded, or
   self-hosted addresses.
4. Implement authenticated Ollama Cloud model listing through `/api/tags`, per-model capability and
   capacity discovery through `/api/show`, active-allocation discovery through `/api/ps`, and a
   generation test using the selected or administrator-entered Cloud model name and a synthetic
   prompt. Treat `/api/show` architecture context as advertised, `num_ctx` as configured, and a
   matching `/api/ps` value as the active allocation. Record output capacity only when `num_predict`
   or an explicit output-limit field is a positive finite value.
5. Implement separate hosted web-search and web-fetch tests using the same stored Cloud key. Store
   per-capability status, latency, safe failure category, last-tested time, account-neutral metadata,
   and credential fingerprint.
6. Add server-admin GET/PUT/test/disable routes with CSRF and idempotency.
7. Add route-authorization entries, OpenAPI schemas, RFC 9457 errors, redacted audit records, and
   redacted rolling logs.
8. Add **Providers** to Administration and implement the Ollama Cloud card with a read-only service
   address and separate test controls.
9. Confirm that generation and both internet capabilities share one encrypted credential without
   sharing health state.
10. Verify save, navigate away, return, restart API/worker, and reload persistence.

#### Required tests

- unit: fixed-endpoint allow-list, rejection of custom/local addresses, `/api/show` and `/api/ps`
  parsing, Boolean and GPT-OSS reasoning mapping, missing-output handling, redaction;
- integration: encrypted secret round trip, admin-only access, CSRF/idempotency, restart persistence;
- fault: timeout, malformed JSON, 401/403/429/5xx, partial context discovery, unavailable Cloud
  service, and one healthy capability while another fails;
- browser: create/test/save/replace/clear key and persistent form values;
- optional live: Ollama Cloud generation, hosted web-search, and hosted web-fetch tests using
  synthetic/non-private input.

#### Exit gate

An administrator can safely configure Ollama Cloud once and independently verify model generation,
web search, and web fetch. No local Ollama address is accepted, and no Chat UI or model generation
for users is active.

---

### C02 — OpenAI OAuth Administration and model catalog

**Goal:** add a durable, headless-friendly OpenAI sign-in without exposing the credential cache.

#### Work packages

1. Add a supervised app-server adapter using newline-delimited JSON-RPC, bounded request IDs,
   protocol validation, stderr redaction, startup timeout, heartbeat, and graceful/forced shutdown.
2. Give the process a package-private isolated `CODEX_HOME`. Disable built-in shell/filesystem tools
   for NodeRag chat execution; later NodeRag tools stay behind NodeRag's own authorization layer.
3. Implement `account/login/start` with `chatgptDeviceCode`, login completion notifications,
   account read/refresh, logout, and pending-login cancellation/expiry.
4. Encrypt and persist the credential cache after successful login and refresh. Restore it after a
   process/package restart. Never expose, log, back up unencrypted, or accept it from the browser.
5. Implement paged `model/list`, filtering hidden entries, storing the live supported reasoning
   efforts and input modalities.
6. Keep token limits unknown unless supplied by a versioned documented table or explicit manual
   model profile. Record provenance and date for every non-null value.
7. Add status/login/models/test/disconnect routes and authorization/OpenAPI/audit entries.
8. Add the OpenAI OAuth card with device-code copy, verification link, polling, model refresh,
   connection test, account/plan summary, and disconnect confirmation.
9. Show a shared-account capacity/billing disclosure and current rate-limit status when available.
10. Add package and Docker process supervision checks; record DSM binary execution as a C11 gate.

#### Required tests

- fake protocol: fragmented lines, concurrent requests, notification ordering, malformed frames;
- login: start, pending reuse, expiry, success, denial, cancellation, refresh, restart restore;
- security: credential redaction, temp permissions, cross-tenant/principal denial, no browser token;
- catalog: pagination, unknown efforts, model removal, changed default, unknown context size;
- browser: full sign-in states, copyable code, reconnect after navigation, disconnect;
- optional live: sign in with a dedicated test account and generate a synthetic answer.

#### Exit gate

OpenAI OAuth survives a NodeRag restart, model/effort choices come from the connected account, and no
secret or private reasoning is exposed. Chat remains disabled.

---

### C03 — Context Window and Chat Settings Administration

**Goal:** complete every configuration dependency before exposing Chat.

#### Work packages

1. Add forward-only persistence for global context settings, chat defaults, model overrides, storage
   assignment, quotas, retention, and feature defaults.
2. Implement model-capacity resolution in this order: provider runtime/configured value,
   provider-advertised value, administrator-entered verified fallback, versioned known-model table,
   unknown.
3. Calculate input, output, pinned-instruction, and tool-result reserves without claiming they are
   provider-enforced limits.
4. Implement rolling-context validation using complete turns.
5. Implement managed-context configuration for L1–L4, including separate tested L2/L3 provider,
   model, reasoning effort, instructions, and output target.
6. Make `openai_oauth` a valid L2/L3 provider in NodeRag; do not copy the reference implementation's
   API-key-only `openai` limitation.
7. Add a synthetic compression preview that uses fake source text and reports before/after estimates,
   selected pins, summary/state status, layer errors, and projected provider calls.
8. Reuse managed-storage probing to create the `.noderag-chat` child and initialize its manifest.
9. Add **Context Window** and **Chat Settings** Administration sections and all help text from §7.
10. Add safe defaults: tools off, internet off, managed context only when fully configured, rolling
    fallback available, bounded timeouts/tool calls, and Markdown-only generation initially.
11. Make settings revisions immutable enough that each chat can snapshot the exact configuration.
12. Test form persistence across tabs, refreshes, API restart, and Package Center-style restart.

#### Required tests

- unit/property: token estimates, turn grouping, reserve arithmetic, profile precedence;
- integration: settings persistence, config revision identity, storage path/ACL containment;
- browser/accessibility: provider-dependent fields, dynamic effort choices, unknown-limit warnings,
  storage browsing/probe, disabled invalid saves, persistent reload;
- fault: missing provider, stale catalog, failed L2 or L3 test, full disk, unwritable root.

#### Exit gate

Both providers, both context modes, storage, and chat defaults can be configured and tested. The
Chat navigation item is still feature-flagged off.

---

### C04 — Durable chat core and two-panel UI

**Goal:** deliver named, resumable owner-scoped text chats without tools.

#### Work packages

1. Add migration for conversations, configuration revisions, messages, runs, normalized events, and
   usage fields.
2. Implement Chat entitlement checks and owner scope on every route/query.
3. Add conversation list/create/read/rename/archive/purge and cursor-paginated history APIs.
4. Create chats with immutable provider/model/effort/context/tool-policy snapshots.
5. Add durable send/stop/retry operations with idempotency and one-active-run enforcement.
6. Extend the worker with chat-run leases, provider streaming, persisted event sequencing, heartbeats,
   cancellation, retry classification, and restart recovery.
7. Add resumable SSE using event IDs and a bounded database replay window.
8. Write checksummed NDJSON events to the active chat log after the database transaction commits.
9. Add Chat below Research, but display it only for entitled users and only after a healthy default
   provider/model exists.
10. Implement the two-panel responsive UI, new-chat dialog, bubbles, final-answer label, tool-free
    activity, Stop, Retry, reconnect, and paginated **View older logs**.
11. Show reasoning summaries only under the §3.5 policy.
12. Add usage and error metadata without exposing secrets or hidden reasoning.

#### Required tests

- integration: owner isolation, API-key denial, CSRF/idempotency, concurrent send conflict;
- worker fault: browser disconnect, API restart, worker kill, lease expiry, provider timeout,
  cancellation, duplicate event, and replay;
- browser: create/select/rename/archive chat, stream/reconnect/stop/retry, mobile layout, keyboard/axe;
- storage: active log hash chain, interrupted append recovery, no duplicate event on replay.

#### Exit gate

An entitled user can run and resume a provider-backed chat with no tools. A browser disconnect or
worker restart does not lose committed messages or leave a permanent running state.

---

### C05 — Research attachment and citation foundation

**Goal:** let a chat focus on selected Research collections without enabling broad RAG search.

#### Work packages

1. Add Research attachment and immutable snapshot-item tables.
2. At chat creation, list only collections owned by the user and include only references currently
   visible through their read grants.
3. Snapshot reference IDs, document/page/chunk locators, hashes, confidence, query provenance, and
   Research update time; do not duplicate entire document bodies in the snapshot.
4. Build a bounded initial context pack from selected page references, prioritizing user-selected
   pages and preserving citation IDs.
5. Implement `research.list_sources`, `research.read_page`, and paged `research.read_document`.
6. Recheck ownership and current knowledge-space read access immediately before every read.
7. Return `access_revoked`/hidden citations when a grant is lost; never silently substitute a
   different document revision.
8. Add citation persistence and open citations through the existing PDF/Markdown viewers.
9. Show attached Research names and snapshot time in the chat header. Add an explicit refresh action
   that creates a new attachment revision after confirmation.
10. Ensure Research-only chats have no `rag.search` or internet tool definition in their model call.

#### Required tests

- two users with similarly named Research collections cannot cross-read;
- one collection spans two knowledge spaces and cites both correctly;
- grant revocation during a live chat blocks the next document read;
- changed/purged document produces stale-source status, not wrong content;
- citations open exact PDF pages/Markdown locations;
- prompt-injection fixtures remain labelled as untrusted source material.

#### Exit gate

A Research-only chat can analyze attached pages and their source documents with stable citations,
while broader RAG and internet access remain unavailable.

---

### C06 — Permission-scoped RAG search tool

**Goal:** allow optional wider NodeRag research using the chat owner's current access.

#### Work packages

1. Implement `rag.search.v1` as a direct application call into the existing retrieval service, not
   an HTTP loopback or unrestricted SQL query.
2. Resolve the current principal and `SiloScope` for every invocation. The model cannot supply a
   principal ID or widen knowledge-space IDs beyond that scope.
3. Accept query, mode, confidence threshold, formats, path prefix, knowledge-space subset, and bounded
   result count through a strict schema.
4. Return passage text, exact locator, confidence, evidence, content/model revision, and citation ID.
5. Implement `document.read_markdown.v1` for a result's canonical Markdown with bounded range paging.
6. Add per-run query/tool-call budgets, duplicate-query suppression, timeouts, and cancellation.
7. Persist tool request/result digests, safe summaries, citations, latency, and result count.
8. Add chat configuration controls and an obvious in-chat badge showing RAG access on/off.
9. Ensure disabling RAG removes the tool definitions from the next model request.

#### Required tests

- zero-grant and one-grant users; cross-silo tool-argument attacks; grant revocation mid-run;
- semantic/meaning/keyword/hybrid result and citation parity with ordinary Search;
- oversized result truncation and paging; duplicate-call loop protection;
- search-only API keys and non-owner sessions denied;
- browser disclosure and configuration-revision behavior.

#### Exit gate

The model can research only what the chat owner could search manually at that moment, with the same
retrieval confidence and source locators.

---

### C07 — Ollama Cloud internet search and web provenance

**Goal:** add optional internet research without granting unrestricted network access.

#### Work packages

1. Implement `web.search.v1` against `POST https://ollama.com/api/web_search` with a maximum of ten
   results and a lower NodeRag default.
2. Implement `web.fetch.v1` against `POST https://ollama.com/api/web_fetch` for URLs returned by web
   search or explicitly confirmed by the user.
3. Use the same encrypted Ollama Cloud API key as generation, but require independent healthy
   web-search and web-fetch capability states and a dedicated web-tool capacity scheduler.
4. Add strict timeout, response-size, redirect, MIME/content, URL, and repeated-call limits.
5. Sanitize returned text, mark it untrusted, and preserve title, URL, retrieval time, content hash,
   and originating query as citations.
6. Do not let provider-returned content add tools, change policy, or request secrets.
7. Keep direct binary downloads disabled initially. A later download operation must use a separate
   safe downloader with private-network/SSRF denial, allow-listing, signature checks, quotas, and
   explicit user intent.
8. Enable the new-chat internet checkbox only when the capability status is healthy. Existing chats
   show unavailable status if the credential is later disabled.
9. Add web-search usage/capacity diagnostics to Administration without logging raw private prompts.
10. Route these tools through Ollama Cloud even when OpenAI OAuth is the selected generation
    provider; never substitute an OpenAI browsing feature or direct model networking.

#### Required tests

- missing/invalid key, quota/rate limit, timeout, malformed/oversized result, unsafe URL;
- prompt injection in result snippets and fetched pages;
- independent tool switches: internet on/RAG off, RAG on/internet off, both off;
- citations and retrieval timestamps in final answers;
- optional live search using a benign fixed query.

#### Exit gate

Internet access is explicit, independently revocable, cited, bounded, and available only through the
tested Ollama Cloud hosted web capabilities.

---

### C08 — Chat filesystem and Markdown authoring

**Goal:** give each chat a safe, versioned document workspace with Markdown as the default.

#### Work packages

1. Add artifact metadata/revision tables and implement the contained filesystem service from §5.1.
2. Implement list, read, create, mkdir, rename, copy, patch, revision history, download, and explicit
   delete operations. Do not add shell execution.
3. Define a line-patch schema with expected SHA-256, exact range/context validation, output-size
   limit, atomic write, and conflict response.
4. Expose the narrow file tools to models only for chats owned by the current principal.
5. Write artifact provenance linking a revision to user messages, model runs, tool calls, and source
   citations.
6. Reuse the rich Markdown reader and source view. Support safe tables, task lists, code, Mermaid,
   ER diagrams, KaTeX/LaTeX, and a sanitized HTML subset.
7. Keep external images opt-in and preserve existing URL safety. Keep arbitrary scripts, forms,
   same-origin embeds, browser storage access, and unsandboxed HTML disabled.
8. Add artifact drawer, folder navigation, preview, copy, download, revision comparison, and storage
   quota display.
9. Segment and checksum active logs; implement **View older logs** from database/archive cursors.
10. Implement read-only existing-folder inventory and an explicit reconcile/import preview, without
    yet mutating the database automatically.
11. Add owner-only image uploads with UUID-based website routes in the form
    `/chat/<chat-id>/file/<file-id>.<extension>`. Preserve the `/noderag/` mount prefix in copied
    browser URLs, allow duplicate original filenames, and make the routes safe for managed Markdown
    and same-origin HTML without turning them into public shares.

#### Required tests

- traversal, symlink/junction, race, stale hash, Unicode/case collision, huge file, disk full;
- Markdown XSS, malicious Mermaid/HTML/URL, external-resource policy;
- simultaneous edits, worker restart during atomic write, revision/history integrity;
- artifact owner isolation, quotas, backups, and retained uninstall behavior;
- duplicate upload names, wrong chat/file/extension denial, MIME/signature validation, URL deletion,
  reverse-proxy mount preservation, and managed-image rendering;
- browser keyboard/file navigation and large Markdown rendering performance.

#### Exit gate

A model and user can safely create and revise Markdown without access outside the chat workspace, and
long chat/file lists remain responsive.

---

### C09 — DOCX/PDF generation and RAG-ingestion bridge

**Goal:** add controlled document exports and promote exact artifact revisions into NodeRag.

#### Work packages

1. Define a normalized document model for headings, paragraphs, lists, tables, code, equations,
   diagrams/images, citations, page breaks, headers/footers, and metadata.
2. Parse supported Markdown into that model; reject or visibly degrade unsupported constructs.
3. Select pure-JavaScript or prebuilt x86_64-safe DOCX/PDF libraries only after license, memory, font,
   reproducibility, and DSM compatibility tests.
4. Generate DOCX without macros, active content, or external relationships. Validate the OOXML
   package after creation.
5. Generate PDF with embedded/subset fonts, stable page size, page numbers, selectable text where
   possible, rendered diagrams, and source citations.
6. Run exports as durable jobs with progress, cancellation, memory/time limits, and cleanup.
7. Add preview/download and export-revision linkage in the artifact drawer.
8. Implement **Upload to RAG database under this knowledge base** using the current user's `upload`
   grant and the existing document-ingestion API/service.
9. Snapshot the selected artifact revision to the ingestion staging area, verify MIME/signature/hash,
   attach chat provenance, and return the existing document/job IDs.
10. Keep chat artifact and RAG document lifecycles independent. Purging one requires its own explicit
    permission and confirmation.

#### Required tests

- deterministic Markdown/DOCX/PDF fixtures, complex tables, equations, diagrams, Unicode, long docs;
- invalid OOXML/PDF, missing font, converter crash, memory ceiling, disk full;
- exact artifact hash/revision promoted to ingestion; edit-after-upload does not alter it;
- upload grant required, cross-knowledge-space denial, ingestion progress/failure linkage;
- generated documents successfully re-ingest and are searchable with correct provenance.

#### Exit gate

Markdown, DOCX, and PDF artifacts are safe, reproducible enough for release, downloadable, and can be
intentionally ingested into an authorized knowledge space.

---

### C10 — Managed context runtime, compression, archives, and reconciliation

**Goal:** make long-running chats bounded, resumable, and recoverable without losing history.

#### Work packages

1. Implement exact token/usage adapters where providers report usage and a versioned conservative
   estimator everywhere else. Include instructions, tool definitions, messages, attachments, tool
   results, output reserve, and provider wrapper overhead.
2. Enforce a preflight budget before every model request. Summarize/page/reject oversized first
   prompts and tool results rather than sending known-overflow requests.
3. Implement rolling context over complete turns with pinned-message handling.
4. Implement L1 exact selections with a real persisted user pin/unpin control.
5. Implement L2 narrative summary with an actual provider output cap where supported and a hard
   server-side accepted-size limit everywhere.
6. Implement L3 state using strict JSON Schema validation for goal, constraints, preferences,
   decisions, failed approaches, open questions, entities, current phase, and flagged notes.
7. Run L2/L3 concurrently only when both provider-capacity and NodeRag scheduling limits allow it;
   otherwise run sequentially.
8. If a layer fails, retain the prior valid layer. Do not fold messages unless the resulting context
   passes minimum-integrity and capacity checks.
9. Mark folded rows out of context, write an immutable compression snapshot, close the corresponding
   NDJSON segment, gzip it, checksum it, and update the manifest atomically.
10. Implement cursor paging across database rows and archived segments for **View older logs**.
11. Implement explicit manual compression and a dry-run preview.
12. Complete existing-folder import/reconciliation with ownership mapping, idempotent event IDs,
    conflict quarantine, and operator diagnostics.

#### Required tests

- triggers before prompts, after tool calls, and for oversized results;
- complete-turn L4 retention, pins, L2/L3 failure/malformed JSON, unknown context window;
- concurrent/sequential layer scheduling, provider timeout, cancellation, restart mid-compression;
- no original-message deletion, snapshot/hash-chain validity, older-log pagination;
- compression quality golden set checking retained decisions/citations/constraints;
- import clean chat, duplicate import, partial segment, bad checksum, conflicting owner, future schema.

#### Exit gate

A long chat remains within its declared provider budget, preserves complete original history, recovers
after interruption, and loads old logs on demand without sending the whole transcript to the browser.

---

### C11 — Security, evaluation, operations, and DSM release candidate

**Goal:** prove the combined system and create the first Chat-capable Synology candidate.

#### Work packages

1. Run the full unit/property/integration/browser/accessibility/contract/security suite.
2. Add adversarial tests for prompt injection, secret requests, tool escalation, cross-owner reads,
   revoked grants, malicious files/Markdown, archive tampering, SSRF, and resource exhaustion.
3. Create a conversation evaluation corpus covering Research-only analysis, RAG research, web
   research, citations, file creation/editing, context compression, refusal, and recovery.
4. Measure time-to-first-token, event latency, tool-call latency, tokens/context growth, compression
   ratio, browser history performance, memory, disk growth, and concurrent chat behavior.
5. Add Administration diagnostics for provider health, active runs, capacity, errors, context
   compression, storage quota, archive health, and reconciliation.
6. Add backup/restore coverage for tables, encrypted credentials, log segments, files, manifests, and
   in-flight run recovery. Restore credentials only when protected by the restored package root key.
7. Test forward upgrade from revision 26, feature disabled rollback, retained uninstall, destructive
   purge, and reinstall/import behavior.
8. Pin dependencies, regenerate OpenAPI/authorization/defaults/SBOM/notices/release freeze, and run
   a clean reproducible package build.
9. Run the Docker package-user lifecycle simulation and 1-hour mixed chat/ingest/search soak.
10. On the real Synology, verify app-server execution, OAuth device sign-in, credential restart,
    Ollama Cloud connectivity, chat storage ACLs, model streaming, tools, file exports, ingest bridge,
    reboot, backup/restore, and resource ceilings.
11. Build and publish a new numbered SPK only from the exact passing commit and attach its checksum,
    test evidence, operator guide, privacy disclosure, and upgrade notes.

#### Exit gate

All C00–C11 proof artifacts pass, the exact SPK passes live DSM acceptance, and the release notes do
not claim support for an untested provider, model limit, output format, or embedded-content feature.

---

## 10. Proposed API inventory

The final names must be generated into OpenAPI and the authorization inventory. This inventory is a
planning contract, not permission to omit equivalent authorization from internal worker calls.

### Administration

```text
GET    /v1/admin/chat/providers
PUT    /v1/admin/chat/providers/ollama-cloud
POST   /v1/admin/chat/providers/ollama-cloud/test-generation
POST   /v1/admin/chat/providers/ollama-cloud/test-web-search
POST   /v1/admin/chat/providers/ollama-cloud/test-web-fetch
POST   /v1/admin/chat/providers/openai-oauth/login
GET    /v1/admin/chat/providers/openai-oauth/status
GET    /v1/admin/chat/providers/openai-oauth/models
POST   /v1/admin/chat/providers/openai-oauth/test
DELETE /v1/admin/chat/providers/openai-oauth
GET    /v1/admin/chat/context
PUT    /v1/admin/chat/context
POST   /v1/admin/chat/context/test
GET    /v1/admin/chat/settings
PUT    /v1/admin/chat/settings
POST   /v1/admin/chat/storage/probe
POST   /v1/admin/chat/storage/reconcile/preview
POST   /v1/admin/chat/storage/reconcile
PUT    /v1/admin/chat/entitlements/:principalId
GET    /v1/admin/chat/health
```

### User Chat

```text
GET    /v1/chats
POST   /v1/chats
GET    /v1/chats/:chatId
PATCH  /v1/chats/:chatId
DELETE /v1/chats/:chatId
GET    /v1/chats/:chatId/messages
POST   /v1/chats/:chatId/messages
POST   /v1/chats/:chatId/runs/:runId/stop
POST   /v1/chats/:chatId/runs/:runId/retry
GET    /v1/chats/:chatId/events
GET    /v1/chats/:chatId/research
POST   /v1/chats/:chatId/research/refresh
GET    /v1/chats/:chatId/artifacts
POST   /v1/chats/:chatId/artifacts
GET    /v1/chats/:chatId/artifacts/*
PATCH  /v1/chats/:chatId/artifacts/*
DELETE /v1/chats/:chatId/artifacts/*
POST   /v1/chats/:chatId/artifacts/*/export
POST   /v1/chats/:chatId/artifacts/*/ingest
```

Every mutation requires a browser CSRF token and idempotency key. Wildcard artifact routes must use a
single decoded relative-path validator and must never pass raw URL path text directly to filesystem
APIs.

---

## 11. Error and recovery contract

Return stable problem codes with a safe explanation and request ID. At minimum cover:

- `chat_access_disabled`, `chat_not_found`, `chat_run_active`, `chat_run_not_found`;
- `chat_provider_unavailable`, `chat_provider_auth_required`, `chat_model_unavailable`;
- `chat_context_unknown`, `chat_context_overflow`, `chat_context_layer_failed`;
- `chat_research_access_revoked`, `chat_source_stale`, `chat_rag_access_disabled`;
- `chat_web_access_disabled`, `chat_web_credential_required`, `chat_web_rate_limited`;
- `chat_tool_limit_reached`, `chat_tool_argument_invalid`, `chat_tool_result_too_large`;
- `chat_artifact_path_invalid`, `chat_artifact_conflict`, `chat_artifact_quota_exceeded`;
- `chat_storage_unavailable`, `chat_log_corrupt`, `chat_import_conflict`.

Provider errors retain the provider status/category but never return secrets, credential payloads,
raw app-server stderr, unrestricted filesystem paths, or another user's identifiers. Retry only
transient classes with bounded attempts/backoff. Authentication, authorization, validation, context
overflow, and deterministic file conflicts require intervention and are not blind retries.

---

## 12. Test strategy and release gates

| Layer                | Minimum evidence                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Unit/property        | URL/model parsing, event normalization, context arithmetic, turn grouping, tool schemas, paths, patches, archive hashes  |
| Database integration | Migrations, owner scope, entitlements, current silo grants, idempotency, leases, pagination, compression/archive state   |
| Provider fake        | Streaming, reasoning summary, tools, usage, cancellation, errors for Ollama Cloud and OAuth                              |
| Live provider        | Synthetic Ollama Cloud generation/search/fetch and dedicated OpenAI OAuth test account; manually gated                   |
| Browser              | All three Administration sections, new chat, two-panel navigation, tool switches, messages, citations, files, older logs |
| Accessibility        | Keyboard/focus, screen reader names, contrast, reduced motion, live-region throttling, mobile drawer                     |
| Security             | Credential redaction, zero-grant, cross-owner, prompt injection, path/symlink, XSS, SSRF, quotas, archive tampering      |
| Fault/recovery       | Browser/API/worker/provider interruption, lease recovery, duplicate events, disk full, corrupt archive, restart/restore  |
| Evaluation           | Answer/citation correctness, tool-policy compliance, compression retention, refusal, artifact fidelity                   |
| Package              | Clean reproducible SPK, app-server/native dependency inspection, non-root runtime, upgrade/restore/uninstall             |
| DSM final            | OAuth device flow, Ollama Cloud, ACL storage, reboot, provider refresh, concurrent resource behavior, 1-hour soak        |

No live test may use private production documents. Seed only synthetic Research collections, public
test URLs, and purpose-built artifact fixtures. Secrets enter through ignored test configuration and
must not appear in command output, screenshots, logs, proof JSON, or CI artifacts.

---

## 13. Rollout and rollback

Use additive feature flags:

```text
chat.providers.enabled
chat.context.enabled
chat.ui.enabled
chat.tools.research.enabled
chat.tools.rag.enabled
chat.tools.web.enabled
chat.artifacts.enabled
chat.exports.enabled
chat.import.enabled
```

Migrations land before behavior and remain backward compatible. A failed phase is rolled back by
disabling its feature flag and stopping new work; do not reverse or delete applied migrations.
Provider disconnection stops new runs but preserves chats. Storage unavailability makes artifacts
read-only/unavailable with diagnostics; it does not delete database history. Context-layer failure
falls back only according to the chat's explicit saved policy and is visible to the user.

The first Synology Chat release must upgrade revision 26 in place and preserve every existing
knowledge base, document, Research collection, setting, and credential. Chat tables and folders are
additive. No document re-index or re-embedding is required solely to enable Chat.

---

## 14. Definition of done

The Chat capability is complete only when all of the following are true:

- Providers, Context Window, and Chat Settings are editable, explained, tested, and persistent.
- Ollama means Cloud only throughout Chat; no local, self-hosted, forwarded, or custom endpoint can
  be configured.
- one encrypted Ollama Cloud API key serves generation, web search, and web fetch, while their
  health, enablement, limits, and failure states remain independently represented.
- OpenAI OAuth signs in through a durable headless-safe device flow and restores securely.
- model and reasoning choices are provider-derived where possible; unknown limits remain honest.
- only entitled users see Chat, and each ordinary user can access only their own chats/files.
- attached Research, RAG search, and internet access remain independent and revocable.
- every document/RAG tool call applies the current user's current knowledge-space grants.
- chat runs survive browser/API/worker interruption and can be cancelled or retried safely.
- citations open NodeRag's existing PDF/Markdown viewers at their stored locations.
- Markdown files can be safely created, line-edited, rendered, versioned, and downloaded.
- DOCX and PDF exports are deterministic, safe, bounded, and linked to source citations.
- an exact chat artifact revision can be intentionally ingested into an authorized knowledge space.
- long chats compress within a known budget without deleting original history.
- older logs load incrementally and checksummed filesystem logs can be reconciled explicitly.
- no raw hidden chain-of-thought, provider credential, unsafe HTML, unrestricted file path, shell, or
  direct database/network access is exposed to a model or browser.
- the complete Docker testbed, security/evaluation suite, package simulation, and live Synology
  acceptance pass against the same immutable SPK.

---

## 15. Source references

- [Ollama connection and model implementation notes](../ollama-settings.md)
- [Local OpenAI OAuth implementation notes](../openai-oauth.md)
- [Local context-window implementation notes](../context-window.md)
- [NodeRag staged implementation plan](staged%20implementation.md)
- [NodeRag architecture](../planning/ARCHITECTURE.md)
- [Ollama Cloud API](https://docs.ollama.com/cloud)
- [Ollama API authentication](https://docs.ollama.com/api/authentication)
- [Ollama show model details API](https://docs.ollama.com/api-reference/show-model-details)
- [Ollama running-model allocation API](https://docs.ollama.com/api/ps)
- [Ollama thinking capability](https://docs.ollama.com/capabilities/thinking)
- [Ollama Modelfile parameters](https://docs.ollama.com/modelfile)
- [Ollama web search and fetch API](https://docs.ollama.com/capabilities/web-search)
- [Codex app-server authentication and device-code flow](https://learn.chatgpt.com/docs/app-server#3b-log-in-with-chatgpt-device-code-flow)
- [Codex authentication on headless devices](https://learn.chatgpt.com/docs/auth#preferred-device-code-authentication-beta)
