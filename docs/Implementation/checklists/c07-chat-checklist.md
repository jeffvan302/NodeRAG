# C07 — Ollama Cloud Internet Checklist

**Status:** Testbed complete
**Environment:** F-drive worktree; WSL2 Linux/amd64 Docker testbed
**Recorded:** 2026-09-15

## Provider and network boundary

- [x] Chat internet means Ollama Cloud hosted web APIs only.
- [x] Search is fixed to `POST https://ollama.com/api/web_search`.
- [x] Fetch is fixed to `POST https://ollama.com/api/web_fetch`.
- [x] Local, self-hosted, forwarded, and custom Ollama endpoints are excluded.
- [x] OpenAI browsing/direct networking is excluded even when OpenAI writes the answer.
- [x] The encrypted Ollama Cloud key is reused without appearing in logs, responses, or proofs.
- [x] Search and fetch require independent healthy capability states.
- [x] A dedicated bounded web-call scheduler and shared database minute counter are enforced.

## Tool and content controls

- [x] `web.search.v1` accepts a strict query, defaults to 5, and permits at most 10 results.
- [x] `web.fetch.v1` accepts only a same-run immutable search citation, never an arbitrary URL.
- [x] Public URL validation rejects private/local/link-local targets, credentials, and unusual ports.
- [x] Redirects, timeouts, MIME, status, JSON, response-size, and cancellation are bounded.
- [x] Search snippets, fetched text, and links are sanitized and clipped.
- [x] Binary downloads remain disabled.
- [x] Six web operations per run and the overall Chat tool budget are enforced.
- [x] Canonical request digests suppress repeated calls before another Cloud request.
- [x] Web content is explicitly untrusted and cannot alter policy, tools, secrets, or provider choice.
- [x] Raw private search text is redacted from durable tool arguments/events and replaced by a digest.

## Provenance and authorization

- [x] Migration 000025 adds immutable search-result and fetched-page citations with `W…` labels.
- [x] Citations preserve title, canonical URL, hostname, content hash, query digest, endpoint,
      retrieval time, duration, request ID, rank, and parent linkage.
- [x] Web citations do not fabricate a vector confidence value.
- [x] Citation listing and exact reads are conversation-owner scoped.
- [x] Non-owner and search-only principals cannot read Chat web citations.
- [x] Full encrypted backup includes citations; portable export excludes them.
- [x] Derived minute counters are excluded from backup/export and pruned after 48 hours.

## API, interface, and administration

- [x] New Chat shows an independent **Allow Ollama Cloud internet search** checkbox only when healthy.
- [x] Existing opted-in chats visibly become unavailable after Cloud health is lost.
- [x] Capability text says **Internet on · Ollama Cloud only**.
- [x] Disclosure states Ollama Cloud remains the web provider for OpenAI-authored answers.
- [x] Web sources open a stored-evidence preview with retrieval time and safe external link.
- [x] Administration shows safe minute/24-hour usage, capacity, limit, and last-use diagnostics.
- [x] Administration diagnostics contain no raw prompt, page body, key, or authorization header.
- [x] Route authorization and generated OpenAPI include the owner-scoped exact web citation route.

## Verification

- [x] Focused C07 PostgreSQL integration: 5/5 passing.
- [x] Provider plus C07 integration: 19/19 passing.
- [x] Combined Chat/provider/configuration/Research/RAG/web/recovery integration: 46/46 passing.
- [x] Full browser suite: 27/27 passing with C07 accessibility coverage.
- [x] Full unit suite: 48 files and 201 tests passing.
- [x] Missing/rejected key, rate limit, timeout, malformed/oversized response, unsafe URL,
      cancellation, duplicate call, and unhealthy capability paths are covered.
- [x] Prompt-injection text remains untrusted and cannot select local Ollama or expose the key.
- [x] Internet-on/RAG-off, RAG-on/internet-off, and both-off combinations are covered.
- [x] Migration inventory passes at `000025_chat_web`.
- [x] Workspace OpenAPI, typecheck, lint, format, dependency boundaries, build/smoke, license, SBOM,
      and secret-scan combined quality gate passes.
- [x] Optional real-account search is documented as a manual synthetic check and was not required for
      the deterministic testbed gate.
- [x] Real DSM execution remains explicitly deferred to C11.

## Exit gate

C07 is closed. Internet access is explicit, independently revocable, cited, bounded, and available
only through the tested Ollama Cloud hosted search and fetch capabilities. No local Ollama or OpenAI
browsing path exists for Chat.
