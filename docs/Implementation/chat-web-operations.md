# C07 Ollama Cloud Internet — Operations Guide

**Applies to:** NodeRag Chat migration `000025_chat_web`
**Environment:** WSL/Linux Docker testbed; DSM packaging remains deferred to C11

## What C07 delivers

C07 adds optional public-internet research to Chat. This capability is separate from attached
Research and from permission-scoped NodeRag knowledge-base search. It is disabled for a new chat
unless the user explicitly selects **Allow Ollama Cloud internet search**.

Every Chat internet operation uses **Ollama Cloud**, never a local Ollama process, LAN endpoint,
custom Ollama address, direct model connection, or OpenAI browsing feature. This remains true when
an OpenAI OAuth model writes the answer. NodeRag calls only these hosted endpoints:

1. `POST https://ollama.com/api/web_search` through `web.search.v1`.
2. `POST https://ollama.com/api/web_fetch` through `web.fetch.v1`.

Both operations use the protected Ollama Cloud API key already configured under **Administration →
Chat providers**. Generation, hosted search, and hosted fetch retain separate health results.

## Enabling Cloud internet for a chat

1. Open **Administration → Chat providers → Ollama Cloud**.
2. Verify the service address is the read-only value `https://ollama.com`.
3. Save a valid Cloud API key. Leaving the field blank later retains the protected key.
4. Run **Test Internet search** and **Test Web-page fetch** independently.
5. Confirm both capability cards show healthy status. Generation health alone is insufficient.
6. Enable the deployment flag `NODERAG_CHAT_WEB_TOOLS_ENABLED=true` together with the required Chat
   feature dependencies.
7. Open **Chat**, select **New chat**, and choose either an Ollama Cloud or OpenAI OAuth response
   model.
8. Select **Allow Ollama Cloud internet search** and create the chat.
9. Confirm the capability strip says **Internet on · Ollama Cloud only**.

The internet choice is copied into the chat's immutable configuration revision. Research, RAG, and
internet may be enabled in any independent combination. If either hosted-web capability or the
credential later becomes unavailable, an existing opted-in chat shows **Internet unavailable ·
check Ollama Cloud health** and no web tools are sent to the response model.

## Tool boundaries

### `web.search.v1`

- accepts only a non-empty text query of at most 4,000 characters;
- accepts 1–10 results and defaults to 5;
- sends the query only to the fixed Ollama Cloud search endpoint;
- stores a SHA-256 query digest rather than raw query text in tool diagnostics and citations;
- drops unsafe URLs and duplicate canonical URLs;
- clips each result snippet to 8,000 characters;
- returns immutable `W1`, `W2`, and later citation labels.

### `web.fetch.v1`

- accepts only the ID of a search-result citation created in the same chat run;
- does not accept an arbitrary model-supplied URL;
- sends the previously validated canonical public URL only to the fixed Ollama Cloud fetch
  endpoint;
- clips extracted page text to 120,000 characters and marks truncation;
- filters returned links through the same public-URL policy;
- links the fetched-page citation to its immutable parent search result.

A run can perform no more than six accepted web operations and remains subject to the overall Chat
tool budget. Repeating the same canonical tool request in one run is rejected before another Cloud
request is made. Binary download is not available in C07.

## Network and content safety

NodeRag accepts only public `http` and `https` citation URLs on ordinary ports. It rejects embedded
credentials, fragments are removed, and local/private/link-local addresses and local/internal host
suffixes are denied. Redirect following is disabled for NodeRag's request to Ollama Cloud.

Cloud API responses must be JSON and remain within the response-size limit. Requests have a bounded
timeout and share both a dedicated in-process concurrency gate and a database-backed per-minute
counter. Status, media-type, timeout, cancellation, and size failures are normalized to safe codes;
the key and response body do not enter the error text.

Search snippets and fetched pages are sanitized and labelled **untrusted evidence** before reaching
the response model. Instructions found in a page cannot add tools, change system policy, select a
different provider, request secrets, enable local Ollama, or authorize a new URL. Final answers must
treat web material as cited evidence rather than executable instructions.

## Durable provenance and citation viewing

Each accepted source stores:

- immutable conversation, message, run, and tool-call identity;
- `W…` label and source type (`search_result` or `fetched_page`);
- title, original URL, canonical URL, and hostname;
- sanitized stored text, truncation state, and SHA-256 content digest;
- originating query digest and search rank when applicable;
- fixed provider name and exact hosted endpoint;
- safe provider request ID, duration, retrieval time, and capture time;
- parent citation identity for a fetched page.

Assistant messages show web citations without inventing a vector confidence percentage. Opening one
shows the stored evidence, Ollama Cloud/public-internet provenance, retrieval time, and a safe
**Open original website** link. The owner-scoped exact citation API can return the complete bounded
stored text. Another user and a search-only API credential cannot read it.

## Administration diagnostics

The Ollama Cloud panel includes **Hosted web-tool usage** with:

- requests in the current minute;
- requests in the last 24 hours;
- active request minutes in the last 24 hours;
- configured dedicated concurrent capacity;
- configured per-minute limit or the NodeRag safe default;
- last hosted web request time.

These diagnostics contain counters and times only. They never include raw search text, fetched page
content, authorization headers, or API keys. Minute-counter rows older than 48 hours are removed as
new requests are reserved.

## Safe failure codes

- `chat_web_not_available` — the deployment flag or required Cloud capabilities are unavailable;
- `chat_web_credential_required` / `chat_web_credentials_rejected` — the protected key is absent or
  rejected;
- `chat_web_rate_limited` — the configured/shared per-minute limit was reached;
- `chat_web_capacity_timeout` — the dedicated web scheduler did not grant capacity in time;
- `chat_web_timeout` / `chat_web_unavailable` — the hosted call timed out or could not be reached;
- `chat_web_request_rejected` — Ollama Cloud rejected a request safely;
- `chat_web_response_malformed` / `chat_web_response_too_large` — the response violated the JSON or
  size contract;
- `chat_web_url_unsafe` — a URL failed the public-web policy;
- `chat_web_citation_not_found` — a citation is absent, outside the run, or not owned by the chat;
- `chat_web_query_duplicate` / `chat_web_query_limit_reached` — the run repeated or exhausted its
  bounded web operations;
- `chat_web_cancelled` — the durable run was cancelled before completion.

## Backup and recovery

Immutable web citations participate in the full encrypted backup and restore path. They are excluded
from portable corpus export. Derived per-minute usage counters are excluded from both full backup and
portable export. External provider credentials remain governed by the existing encrypted-secret
restore policy and restored external providers remain disabled until deliberately revalidated.

## Troubleshooting

- **Internet checkbox disabled:** verify the C07 rollout flag, saved Cloud key, enabled Cloud
  connection, fixed service root, and healthy search plus fetch checks.
- **OpenAI chat cannot search:** do not configure OpenAI browsing. Repair the separate Ollama Cloud
  search/fetch capability because all Chat web access uses it.
- **Existing chat says unavailable:** health or credentials changed after creation. Re-test both
  hosted web capabilities; the immutable opt-in remains recorded.
- **Unsafe URL:** use a normal public HTTP(S) page. Local servers, private addresses, unusual ports,
  embedded credentials, and arbitrary fetch URLs are intentionally unsupported.
- **Rate limited:** inspect **Hosted web-tool usage**, reduce concurrency, or configure an accurate
  account per-minute limit. NodeRag will not bypass the shared counter.
- **Fetched page is clipped:** the 120,000-character boundary is deliberate. C07 does not perform
  binary downloads or unrestricted crawling.
- **No confidence percentage:** web citations record provenance, rank, hashes, and retrieval time;
  they are not vector-search matches and therefore do not fabricate semantic confidence.

## Deferred behavior

- Optional live-account search remains a manually gated synthetic check; automated tests use only
  fake Cloud responses and public example URLs.
- C08 adds contained Chat files and Markdown authoring.
- C09 adds deterministic DOCX/PDF export.
- C10 adds artifact ingestion, managed/rolling context, archives, and reconciliation.
- C11 completes the Docker/security/evaluation gate, DSM package integration, live Synology
  acceptance, and the first immutable Chat-capable SPK.
