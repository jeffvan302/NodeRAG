# C06 — Permission-scoped RAG Checklist

**Status:** Testbed complete
**Environment:** F-drive worktree; WSL2 Linux/amd64 Docker testbed
**Recorded:** 2026-09-15

## Search tools and persistence

- [x] Migration 000024 expands durable tool calls and adds immutable RAG citations.
- [x] `rag.search.v1` calls the existing retrieval service directly without HTTP loopback or model
      SQL access.
- [x] `document.read_markdown.v1` reads only a citation returned by the active chat and pages at
      24,000 characters.
- [x] Strict arguments cover query, all four Search modes, confidence, formats, path prefix,
      knowledge-base subset, and bounded result count.
- [x] Results retain confidence, evidence, exact locator, active build, model-manifest digest, and a
      stable citation ID/label.
- [x] Large merged passages are clipped around evidence with explicit passage offsets/truncation;
      contributing chunk IDs are bounded and truncation is explicit.
- [x] Tool calls persist request/result digests, safe summary, latency, result count, status, and safe
      failures without raw result bodies.

## Authorization and safety

- [x] The run owner, never a model-supplied principal, determines authorization.
- [x] Current `SiloScope` is resolved for every search and every subsequent citation read.
- [x] RLS-protected document/page queries execute inside the current scope.
- [x] Requested knowledge-base IDs are intersected with current grants and cannot widen access.
- [x] Zero-grant users receive no results; one-grant users cannot retrieve a matching private-space
      document.
- [x] Grant revocation between search and read fails with `chat_rag_access_revoked` and is durably
      recorded.
- [x] Changed document hashes produce `source_stale` with no content substitution.
- [x] Search-only API credentials and non-owner sessions cannot use Chat/citation routes.
- [x] Retrieved material is labelled untrusted and cannot add tools, reveal secrets, or change policy.

## Budgets and provider boundary

- [x] Overall tool budget and an eight-query RAG ceiling are enforced per run.
- [x] Canonical request digests suppress identical search loops within a run.
- [x] Tool output has bounded per-hit text/chunks and a 512 KiB runner ceiling.
- [x] Durable-run cancellation, timeout, lease, and retry behavior is reused by RAG calls.
- [x] RAG-disabled chats receive no RAG tool definitions; deployment-level disable rejects opt-in.
- [x] Research and RAG remain independent.
- [x] Internet tool definitions remain absent in C06.
- [x] Ollama means Ollama Cloud only; local/custom/self-hosted Ollama is never accepted for Chat.
- [x] C07 internet is fixed to Ollama Cloud `web_search`/`web_fetch`, including when OpenAI writes the
      answer.

## API and interface

- [x] New Chat dialog has an independent broader knowledge-base search checkbox with permission
      explanation.
- [x] Immutable conversation configuration records `allow_rag=true` and `allow_internet=false`.
- [x] Chat capability strip clearly shows **RAG on · current permissions** or **RAG off**.
- [x] Assistant messages show `S…` sources with document, page, confidence, and live availability.
- [x] Exact RAG page, bounded Markdown document, and hash-checked original routes are owner-scoped.
- [x] Existing PDF and Markdown viewers open RAG citations and preserve source navigation.
- [x] Browser disclosure says internet is off and future internet uses Ollama Cloud only.
- [x] Route authorization and generated OpenAPI include all three RAG citation routes.

## Verification

- [x] Focused C06 PostgreSQL integration: 5/5 passing.
- [x] Keyword, semantic, hybrid, and vector parity with ordinary Search is verified.
- [x] Long-result clipping/paging, duplicate suppression, zero/one grant, cross-space arguments,
      mid-run revocation, stale source, search-only credential, and non-owner faults are verified.
- [x] Combined Chat/provider/configuration/Research/RAG/recovery integration: 40/40 passing.
- [x] Full browser suite: 26/26 passing with C06 accessibility coverage.
- [x] Full unit suite: 47 files and 195 tests passing.
- [x] Migration inventory passes at `000024_chat_rag`.
- [x] Workspace OpenAPI, typecheck, lint, format, dependency boundaries, build/smoke, license, SBOM,
      and secret-scan combined quality gate passes.
- [x] Full encrypted backup classification includes C06 data; portable export excludes it.
- [x] Real DSM execution remains explicitly deferred to C11.

## Exit gate

C06 is closed. A response model can search only the knowledge bases the owner could search manually
at that moment and can read bounded canonical Markdown only through a current, stable citation.
Confidence and locators match ordinary Search, oversized passages fail safely through explicit
clipping/paging, and internet remains unavailable until the Ollama Cloud-only C07 stage.
