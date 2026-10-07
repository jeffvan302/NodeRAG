# C05 — Research Attachments and Citations Checklist

**Status:** Testbed complete
**Environment:** F-drive worktree; WSL2 Linux/amd64 Docker testbed
**Recorded:** 2026-09-15

## Snapshot and persistence

- [x] Migration 000023 adds immutable attachment revisions, collection summaries, source snapshots,
      citations, and durable Research tool calls.
- [x] Snapshot creation is owner-only, bounded to 500 visible references, and prioritizes page
      references.
- [x] Snapshots retain stable hashes, exact locators, confidence/evidence, query/mode, and source
      identity without copying whole source documents.
- [x] Send and Retry pin the attachment revision used by that run.
- [x] Refresh requires confirmation, creates a new revision, and cannot update an old revision.
- [x] Old messages continue resolving citations through their original attachment revision.

## Authorization and integrity

- [x] Another user's similarly named Research collection is hidden and cannot be attached.
- [x] Current `SiloScope` read permission is resolved again before every source list/read.
- [x] A grant revoked between live tool calls blocks the next read and persists a safe failed call.
- [x] Changed or purged sources become `source_stale`; no current content is substituted.
- [x] Managed original and Markdown files are hash-checked before viewer content is returned.
- [x] Research content is bounded, wrapped, and labelled untrusted; prompt-injection text cannot alter
      tools or policy.

## Provider and Ollama Cloud boundary

- [x] Research runs expose only `research.list_sources.v1`, `research.read_page.v1`, and
      `research.read_document.v1`.
- [x] RAG and web tool definitions are absent in C05.
- [x] Ollama means Ollama Cloud only and uses the fixed `https://ollama.com/api/chat` endpoint.
- [x] Local, self-hosted, forwarded, and custom Ollama addresses are not accepted for Chat.
- [x] OpenAI binds only the same NodeRag Research dynamic tools; built-in web/shell/file/workspace
      capabilities remain disabled.
- [x] Chat internet will use only Ollama Cloud `web_search`/`web_fetch` in C07, regardless of response
      model.
- [x] Tool count, duplicate call ID, result-size, cancellation, timeout, and malformed-provider bounds
      fail safely.

## API and interface

- [x] Chat creation lists only the owner's readable Research collections and accepts selected IDs.
- [x] Attachment read and confirmed refresh routes are owner-scoped.
- [x] Exact page, paged Markdown document, and original-file routes recheck revision, grant, and hash.
- [x] Route authorization and generated OpenAPI include all C05 routes.
- [x] Chat header shows Research names, snapshot time/revision, counts, and unavailable-source status.
- [x] Assistant messages show stable source buttons with document, page, confidence, and status.
- [x] PDF and Markdown viewers reuse existing keyboard/source-passage behavior and preserve the
      answer's revision.
- [x] Browser wording states Research on/off, RAG off, and internet off/Ollama Cloud only.

## Backup and verification

- [x] Backup classification includes C05 tables in full backup and excludes them from portable
      corpus export.
- [x] Full restore handles the nullable conversation/current-Research-revision cycle and passes.
- [x] Focused C05 PostgreSQL integration: 5/5 passing.
- [x] Combined Chat/configuration/provider/recovery integration: 35/35 passing.
- [x] Production provider tool-binding unit suite: 13/13 passing.
- [x] Full browser suite: 25/25 passing with focused WCAG A/AA checks.
- [x] Full unit suite: 47 files and 195 tests passing.
- [x] Migration inventory passes at `000023_chat_research`.
- [x] Workspace typecheck, lint, formatting, boundaries, build/smoke, licenses, SBOM, and secret scan
      pass in the combined quality gate.
- [x] Real DSM execution remains explicitly deferred to C11.

## Exit gate

C05 is closed. A Research-only chat can analyze fixed, owner-scoped references through bounded tools,
retain stable message citations, and open permission- and hash-checked source content. Current grant
loss and source changes fail closed. C06 may add wider permission-scoped RAG; internet remains off
until C07 and will be Ollama Cloud-only.
