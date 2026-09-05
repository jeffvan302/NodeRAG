# M09 Operator UI and First-Run Guide

NodeRag now provides a complete local control surface for first-time setup, retrieval, document handling, ingestion, job recovery, and administration. The browser is deliberately a thin client: it calls the same `/v1` REST contract available to an equivalent API client and receives no private filesystem route, database connection, or browser-only privilege.

## First-time setup

1. Open the NodeRag control listener. Readiness routing sends an unconfigured service to the setup screen, an operational service to sign-in, and an incompatible database/runtime to the protected maintenance screen.
2. Copy the one-time setup key from the protected installer output. The on-disk key is mode `0600`; PostgreSQL stores only its SHA-256 verifier. The key expires after 24 hours by default, can be bounded from 1–168 hours with `NODERAG_SETUP_TOKEN_HOURS`, rotates on restart after expiry, is consumed on successful setup, and is never written by application logging.
3. Create the first administrator and default knowledge space. Password hashing uses the pinned Argon2id policy. The response displays a high-entropy recovery code once; only its verifier is retained.
4. Sign in. The session is stored in an HttpOnly, SameSite=Strict cookie. The browser keeps only the session's CSRF token in its tab session storage; closing the tab may require signing in again before a mutation.
5. Choose the document storage directory. NodeRag requires an absolute path, creates it if necessary, performs an exclusive write/fsync/remove probe, reads filesystem capacity, and warns below 10 GiB free. DSM-specific `/volumeN`, filesystem, encrypted-share, and indexing-service policies are intentionally finalized in M10 and certified on DSM at the final milestone.
6. Keep the included checksum-pinned Qwen3 model or perform the air-gapped browser checksum preflight. The preflight reads the file locally and never sends it. Resumable model download and atomic server-side manual import are M10 production-package work.
7. Run embedding calibration. The server embeds twenty fixed representative passages with the active model and reports measured characters/second plus projected minutes per million characters. Calibration passages contain no user document content and are not retained.
8. Optionally configure Ollama. The default address is `https://ollama.com/api/chat`; direct cloud
   use requires an Ollama API key and sends image content outside the local network. The form also
   accepts an `/api` base or self-hosted address. NodeRag checks reachability, confirms the exact
   model/revision, validates a sample image-to-Markdown response, reports elapsed time, and stores a
   supplied API key only through the encrypted secret vault.
9. Add an input folder only after the path has been shared with the package account. This is a
   read/watch source where people or other systems place files; it is not a NodeRag storage
   destination. NodeRag does not modify those source files. A crawl copies each supported file to
   protected managed storage before processing. The API resolves the path against configured
   source roots and rejects traversal, inaccessible roots, and undeclared locations.
10. Each post-login setup step is persisted in `noderag.setup_state`; sanitized events are appended to `noderag.setup_event`. `/v1/setup/events` returns SSE status and durable progress frames, so a refresh resumes the recorded step.

## Search

The Search page uses one query field and three plain-language modes:

- **Meaning** maps to vector retrieval.
- **Keyword** maps to PostgreSQL lexical retrieval.
- **Both** maps to hybrid Reciprocal Rank Fusion.

Visible knowledge-space chips define only a requested subset; the server still resolves authoritative silo scope. Filters cover source IDs, path prefix, format, created and modified ranges, page range, image presence, and table presence.

Results are grouped by document. Every passage shows heading breadcrumbs, the server-prepared page/sheet/percentage label, score, and document metadata. Selecting a passage requests server-prepared neighboring context. Operators can open the integrity-checked original or copy a citation containing document identity, qualified locator, passage text, and stable NodeRag IDs. The UI never slices by character offsets. Display truncation is grapheme-aware, while locator arithmetic remains server-owned UTF-16/UTF-8 data.

## Documents and missing sources

The Documents page lists ingest state, source state, size, page basis, page count, and image count. Its detail dialog displays canonical Markdown, warns when canonical locators do not match source-file text offsets, and exposes the original only through the authenticated streaming endpoint.

When a mapped source disappears, extracted text remains available with `source_missing` state. An operator can record a missing-source review note, re-index after recovery, or purge. Purge requires typing `document <ID>` and calls the idempotent API with the exact document and silo IDs.

## Ingest and durable work

- File upload supports PDF, DOCX, XLSX, Markdown, and text through the existing streamed multipart API.
- Input-folder mappings expose include/exclude patterns and an optional interval schedule. The
  source stays read-only; the durable original used for processing and recovery is held in
  NodeRag-managed storage.
- The live queue shows job kind, state, attempt count, and progress. It refreshes every eight seconds and supports pause, resume, cancel, and retry according to job state.
- All durable actions carry CSRF and a new idempotency key. A service restart resumes from database checkpoints rather than browser state.

## Administration

The control center provides API-backed pages for knowledge spaces, users, search-only API keys,
independent read/upload/delete capabilities, gateways, audit, settings, models, builds, storage,
backups, restore, evaluation, image understanding, and the generated OpenAPI contract. Every
section begins with a plain-language explanation instead of presenting the endpoint path as its
description.

Administrators can add knowledge spaces and edit their names/descriptions; slugs remain permanent
partition identifiers. System settings expose documented limits and explain whether they affect
chunking, workers, search, or audit retention. Vision settings expose the Ollama-compatible address,
model, optional replacement API key, 1–16 parallel-call limit, timeout, retries, and image-size cap;
the stored API key is never returned. Saving vision settings performs the live activation test.

Storage administration distinguishes managed destinations from input folders. An administrator can
probe, add, rename, enable/disable, and edit an unused destination. Once a backup, schedule, or
relocation refers to a location, its path and purpose are locked so recovery records cannot be
orphaned; create a new location instead. The configured path appears only through the
server-administrator storage endpoint and administrator screen, never through ordinary document,
search, health, or non-administrator list responses.

Capability grants are independently addressable by principal, silo, and `read`, `upload`, or
`delete` capability. Knowledge-space purge requires typing the exact slug. API key secret material
is displayed only in the create response.

## Accessibility and responsive behavior

The UI provides a skip link, semantic headings/landmarks, programmatic labels, visible focus, text-backed status, keyboard-operable controls, Escape-close dialogs, light/dark system themes, 320-pixel responsive layouts, horizontal table overflow, automatic text direction, and reduced-motion behavior. Evaluation cards explicitly inherit the active panel foreground/background pair, preventing white-on-white content in dark mode. Playwright uses role and label locators rather than implementation selectors. Axe scans login, authenticated search, and the dark-mode administration/evaluation surface for WCAG 2 A/AA and 2.1 A/AA issues. The maintained human review list is `docs/Implementation/checklists/m09-accessibility-checklist.md`.

## Testbed verification

From a clean checkout with Docker available:

```text
pnpm install --frozen-lockfile
pnpm ci:quality
pnpm test:integration
pnpm --filter @noderag/ui exec playwright install chromium
pnpm test:e2e
pnpm package:thin
pnpm package:thin
pnpm package:verify
pnpm repo:check
```

The two SPK hashes must match. The M09 workflow repeats quality, browser E2E/accessibility, PostgreSQL integration, Linux compatibility, and deterministic thin-SPK checks on GitHub.

## Failure guidance

- **Setup key missing or expired:** restart NodeRag so the expired protected file and verifier rotate together, then use the new key.
- **Storage probe failed:** use an absolute writable path shared with the service account; confirm capacity and ownership outside the browser.
- **Storage path/purpose is locked:** the location is already referenced by recovery or relocation
  history. Keep it intact, disable it if no new work should use it, and add a replacement location.
- **Calibration failed:** check active-model availability and embedder health before changing concurrency.
- **Ollama test failed:** verify its URL is reachable from the NodeRag container/package namespace,
  the model is available to the account/server, and the API key is correct. Ollama Cloud must use
  HTTPS and a bearer API key; a self-hosted endpoint may be unauthenticated.
- **CSRF/session error:** sign in again; do not copy cookies or CSRF values between browsers.
- **Source rejected:** add the path to the package's declared source roots and verify the package user can traverse and read it.
- **Missing original:** record review, restore the source if appropriate, or use typed purge. Extracted content is intentionally retained until an authorized decision.

M09 evidence is WSL/Docker/testbed evidence. It does not claim DSM Package Center layout, ACL, storage, reverse-proxy, browser-launch, or service-impact certification; those remain in the DSM deferred register for the final live-device milestone.
