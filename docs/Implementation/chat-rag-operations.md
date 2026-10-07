# C06 Permission-scoped RAG — Operations Guide

**Applies to:** NodeRag Chat migration `000024_chat_rag`
**Environment:** WSL/Linux Docker testbed; DSM packaging remains deferred to C11

## What C06 delivers

C06 lets an entitled user opt a new chat into wider searches of NodeRag knowledge bases. It is
separate from attached Research and from internet access. Every search and document read uses the
chat owner's permissions at the moment the operation runs; a model cannot nominate another user or
widen the set of knowledge bases.

The response provider can receive exactly two C06 operations when RAG is enabled for that chat:

1. `rag.search.v1` calls NodeRag's existing retrieval service directly.
2. `document.read_markdown.v1` reads a bounded canonical-Markdown range through a citation returned
   by the first operation.

The search operation accepts a strict query, Search mode, confidence cutoff, document formats, path
prefix, requested knowledge-base subset, and result limit. NodeRag intersects the requested subset
with current `SiloScope`; inaccessible knowledge bases silently contribute no results. The returned
confidence, evidence, model/build identity, and source locator use the same retrieval result as the
ordinary Search workspace.

Internet remains unavailable in C06. For Chat, Ollama means **Ollama Cloud only**. C07 will add
internet search and fetch exclusively through `POST https://ollama.com/api/web_search` and
`POST https://ollama.com/api/web_fetch`, even when an OpenAI model writes the answer. Local,
self-hosted, forwarded, and custom Ollama endpoints are never Chat providers.

## Enabling RAG for a chat

1. Confirm Chat providers, Context Window, and Chat are enabled and healthy.
2. Enable the rollout flag `NODERAG_CHAT_RAG_TOOLS_ENABLED=true` together with its required Chat
   feature dependencies.
3. Open **Chat** and select **New chat**.
4. Select a healthy Ollama Cloud or OpenAI response model.
5. Select **Allow broader knowledge-base search**.
6. Create the chat and verify the capability strip says **RAG on · current permissions**.
7. Ask the model to find evidence in NodeRag. The answer's source buttons show `S1`, `S2`, and later
   labels with document, page when available, confidence, and availability.
8. Open a source to use the existing PDF or Markdown viewer. Each viewer request checks ownership,
   current permission, and captured file hashes again.

The choice is stored in the chat's immutable configuration revision. Turning the deployment flag
off removes the two tool definitions from subsequent provider requests and rejects attempts to
create another RAG-enabled chat. It does not delete earlier messages or citations.

## Search and result boundaries

- query length is 1–4,000 characters;
- modes are `vector`, `semantic`, `keyword`, and `hybrid`;
- confidence is 0.05–0.95 and defaults to 0.30;
- formats are limited to NodeRag's supported document formats;
- path prefixes are bounded to 1,024 characters;
- a provider can request at most 20 results and the default is 8;
- a run can issue no more than the configured tool limit and no more than eight RAG searches;
- an identical RAG request digest cannot run twice in one model run;
- canonical Markdown reads return at most 24,000 characters and expose `nextOffset` for paging;
- large merged passages are clipped to 12,000 characters around the strongest exact/semantic
  evidence and are marked `passageTruncated` with exact passage start/end offsets;
- a citation retains at most 64 contributing chunk IDs, always includes the ranked chunk, and marks
  `chunkIdsTruncated` when more existed;
- a serialized tool result remains under the runner's 512 KiB ceiling.

Source text is explicitly marked untrusted. Instructions inside retrieved material cannot request
credentials, add tools, enable internet, change authorization, or cause a local Ollama call.

## Authorization and integrity behavior

The worker takes the owner from the leased durable run, not tool arguments. It resolves current
`SiloScope` for every search and resolves it again for every citation/document/page read. Database
reads of RLS-protected documents and pages run inside that scope. A request containing inaccessible
knowledge-base IDs returns only accessible matches; a user with no grants receives an empty result.

Every citation captures the source knowledge base, document/chunk IDs, original and Markdown hashes,
retrieval locator, evidence, confidence, query digest, Search mode, active build, embedding-model
manifest digest, passage bounds, and capture time. If the read grant is removed, the citation becomes
`access_revoked`. If either captured source hash changes or the document disappears, it becomes
`source_stale`. NodeRag never substitutes newer content under the old citation.

Chat ownership is checked before every browser citation route. Search-only API keys cannot enter the
Chat API, and another user receives `chat_not_found` rather than learning citation identifiers.

## Durable diagnostics

Each accepted tool call stores the run/call identity, ordinal, strict arguments, request digest,
status, result digest/bytes, duration, result count, safe result summary, failure code, and timestamps.
RAG citations are immutable. Useful safe failure codes include:

- `chat_rag_query_duplicate` — the same search was requested twice in one run;
- `chat_rag_query_limit_reached` — the per-run RAG-search budget was exhausted;
- `chat_rag_access_revoked` — permission disappeared before a follow-up read;
- `chat_rag_source_stale` — source identity no longer matches the captured citation;
- `chat_rag_citation_not_found` — the citation is absent or not owned by this chat;
- `chat_tool_limit_reached` — the overall configured tool budget was exhausted;
- `chat_tool_result_too_large` — the final encoded result exceeded the hard ceiling;
- `chat_run_cancelled` or provider timeout codes — the durable run stopped safely.

Raw queries are not stored in the citation table: only their SHA-256 digest is retained. Result
summaries contain counts, mode, scope size, latency, and digest—not source bodies or credentials.

## Backup and recovery

`chat_rag_citation` and the expanded `chat_tool_call` participate in full encrypted backup and are
excluded from portable corpus export. Citation rows are restored after their conversations,
messages, runs, and tool calls so foreign-key identity remains exact. Restored external providers
remain disabled under the existing recovery policy.

## Troubleshooting

- **RAG checkbox is disabled:** verify the C06 feature flag, Chat dependencies, entitlement, and at
  least one healthy response model.
- **No results:** confirm current read grants, query mode, confidence cutoff, format/path filters,
  and that the knowledge base has an active index. A zero-grant result is intentionally empty.
- **A requested knowledge base is missing:** the model requested a scope the user cannot currently
  read; NodeRag intersected it with the current scope.
- **Duplicate-query error:** the provider repeated identical search arguments in one run. Reuse the
  first result or materially refine the query.
- **Source unavailable:** inspect whether the user's grant changed or the document was re-ingested.
  Retry the question to create a current citation; never edit the old immutable citation.
- **Long result is clipped:** use `document.read_markdown.v1` with its citation and `nextOffset` to
  page through canonical Markdown.
- **Internet unavailable:** expected until C07. C07 uses Ollama Cloud hosted web APIs only.

## Deferred behavior

- C07: explicit, independently revocable Ollama Cloud internet search/fetch and web provenance.
- C08: contained Chat filesystem, Markdown authoring, revisions, preview, and older logs.
- C09: deterministic DOCX/PDF exports.
- C10: artifact ingest, managed/rolling context, archive and reconciliation.
- C11: complete Docker/security/evaluation gate, DSM package integration, live Synology acceptance,
  and the first immutable Chat-capable SPK.
