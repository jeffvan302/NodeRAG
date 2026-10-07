# C09 — DOCX/PDF Export and RAG Promotion Checklist

**Status:** Testbed complete
**Environment:** F-drive worktree; WSL2 Linux/amd64 Docker testbed
**Recorded:** 2026-09-15

## Provider boundary

- [x] Every Chat Ollama capability means Ollama Cloud only.
- [x] Local, self-hosted, forwarded, and custom Ollama addresses remain unavailable to Chat.
- [x] Ollama Cloud is the sole Chat internet-search and web-fetch provider, including for OpenAI
      responses.
- [x] Converters and diagrams have no shell, browser, or network capability.

## Normalized model and conversion

- [x] A versioned normalized model covers headings, rich text, lists, quotes, tables, code,
      equations, diagrams, page breaks, notes, headers/footers, and provenance metadata.
- [x] Markdown is parsed with raw HTML and automatic URL fetching disabled.
- [x] Unsupported content is rejected or represented by a visible warning/degradation.
- [x] Source characters, blocks, table dimensions, diagram complexity, and warnings are bounded.
- [x] DOCX uses deterministic ordering/timestamps and contains no macros, active content, external
      relationships, XML entities, path traversal, or malformed ZIP parts.
- [x] PDF uses A4, embedded Noto Sans subsets, selectable text, stable metadata, page numbers,
      diagrams, source notes, and no active actions or embedded files.
- [x] Supported Unicode is selectable and re-ingestable; unsupported glyphs degrade visibly.
- [x] Exact dependency versions and licenses are recorded in the lockfile, notices, SBOM, and
      reviewed-license policy.

## Durable jobs and storage

- [x] Migration 000027 adds immutable export job/event and exact promotion-link records.
- [x] Jobs snapshot source artifact revision/hash, limits, parser/generator policy, and provenance.
- [x] Worker leases, heartbeats, expiry reclaim, retry limits, progress, and cancellation exist.
- [x] Simultaneous workers cannot claim or complete the same export twice.
- [x] Atomic contained publication synchronizes and renames the completed file before success.
- [x] Cancellation, timeout, crash, disk-full, invalid output, and failed success commit remove any
      partial published output.
- [x] Download rechecks containment, symlinks, size, and SHA-256.
- [x] Safe failures expose stable codes without raw paths, prompts, credentials, or exceptions.
- [x] Administration exposes maximum output bytes, timeout, attempts, and converter capability.

## RAG promotion and interface

- [x] Artifact drawer queues DOCX/PDF, polls progress, cancels, downloads, and previews PDF.
- [x] Export rows retain their immutable source artifact revision even after later edits.
- [x] Promotion supports Markdown and successful DOCX/PDF outputs.
- [x] Promotion requires current authentication, ownership, entitlement, CSRF, idempotency, and the
      exact knowledge-base `upload` grant.
- [x] Source/output hashes, MIME/signature/package, export/source revision, and containment are
      verified before accepting the existing ingestion job.
- [x] Document metadata records chat/artifact/export provenance.
- [x] Idempotent retries return the original document/job.
- [x] Chat artifact/export and RAG-document purge lifecycles remain independent.

## Verification

- [x] Focused export unit suite: 7/7 passing.
- [x] Focused export/promotion PostgreSQL integration: 7/7 passing.
- [x] Full integration suite: 18 files and 115 tests passing.
- [x] Full browser suite: 28/28 passing, including export progress, PDF preview, exact-revision
      upload, administration limits, and converter capability.
- [x] Full unit suite: 50 files and 212 tests passing.
- [x] Production server/UI build and built-server converter smoke pass.
- [x] Built DOCX/PDF probe passes in Linux/amd64 Docker with networking disabled.
- [x] Migration inventory passes at `000027_chat_exports`.
- [x] OpenAPI, typecheck, lint, formatting, dependency boundaries, licenses, SBOM, and secret scan
      pass as one quality gate.
- [x] Real DSM execution and a new SPK remain explicitly deferred to C11.

## Exit gate

C09 is closed. Markdown, DOCX, and PDF artifacts are bounded, passive, deterministic enough for the
release contract, downloadable, and promotable from an exact immutable revision into an authorized
knowledge base. C10 can now add managed context, compressed archives, existing-folder import, and
full external Chat-root recovery without changing this export contract.
