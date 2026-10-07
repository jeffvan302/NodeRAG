# M09 Operator UI and First-Run Guide

NodeRag now provides a complete local control surface for first-time setup, retrieval, document handling, ingestion, job recovery, and administration. The browser is deliberately a thin client: it calls the same `/v1` REST contract available to an equivalent API client and receives no private filesystem route, database connection, or browser-only privilege.

## First-time setup

1. Open the NodeRag control listener. Readiness routing sends an unconfigured service to the setup screen, an operational service to sign-in, and an incompatible database/runtime to the protected maintenance screen.
2. Copy the one-time setup key from the protected installer output. The on-disk key is mode `0600`; PostgreSQL stores only its SHA-256 verifier. The key expires after 24 hours by default, can be bounded from 1–168 hours with `NODERAG_SETUP_TOKEN_HOURS`, rotates on restart after expiry, is consumed on successful setup, and is never written by application logging.
3. Create the first administrator and default knowledge space. Password hashing uses the pinned Argon2id policy. The response displays a high-entropy recovery code once; only its verifier is retained.
4. Sign in. The session is stored in an HttpOnly, SameSite=Strict cookie. The browser keeps only the session's CSRF token in its tab session storage; closing the tab may require signing in again before a mutation.
5. Choose the document storage directory. On DSM, keep the package-owned default `/var/packages/noderag/var/data/documents`, or select an existing shared folder to have NodeRag create a dedicated `.noderag-managed` child without changing the parent ACL. NodeRag resolves the actual `/volumeN` path, performs an exclusive write/fsync/rename/read/remove probe, reads filesystem capacity, and reports specific permission, path, filesystem, encryption, or capacity failures.
6. Install the checksum-pinned Qwen3 model into private package storage. The wizard shows byte and percentage progress, resumes an interrupted download, follows only approved HTTPS provider redirects, and verifies every artifact before activation. The air-gapped browser preflight reads a selected file locally and never sends it.
7. Run embedding calibration. The server embeds twenty fixed representative passages with the active model and reports measured characters/second plus projected minutes per million characters. Calibration passages contain no user document content and are not retained.
8. Optionally configure Ollama. The default address is `https://ollama.com/api/chat`; direct cloud
   use requires an Ollama API key and sends image content outside the local network. The form also
   accepts an `/api` base or self-hosted address. NodeRag checks reachability, confirms the exact
   model/revision, validates a sample image-to-Markdown response, reports elapsed time, and stores a
   supplied API key only through the encrypted secret vault. Parallel calls and images per call are
   separate controls; images per call defaults to 3.
9. Add an input folder only after the path has been shared with the package account. This is a
   read/watch source where people or other systems place files; it is not a NodeRag storage
   destination. NodeRag does not modify those source files. A crawl copies each supported file to
   protected managed storage before processing. The API resolves the path against configured
   source roots and rejects traversal, inaccessible roots, and undeclared locations. The folder
   picker starts at the server filesystem root and exposes only the path segments that lead to an
   allowed source root; once inside an allowed root, it lists readable subfolders. The DSM package
   declares detected `/volumeN` locations as its default roots, while the dedicated `noderag`
   account still requires read permission on any shared folder selected for ingestion.
10. Each post-login setup step is persisted in `noderag.setup_state`; sanitized events are appended to `noderag.setup_event`. `/v1/setup/events` returns SSE status and durable progress frames, so a refresh resumes the recorded step.

## Search

The Search page uses one query field and four plain-language modes:

- **Meaning** maps to pure vector retrieval without matching-word strengthening.
- **Semantic** shortlists passages by meaning, confirms them against sentence-sized phrases, drops
  weak sentence matches, and derives both ranking and confidence from the strongest accepted
  sentence. Those same sentences appear as green PDF highlights.
- **Keyword** maps to PostgreSQL lexical retrieval.
- **Both** is the UI default and maps to hybrid Reciprocal Rank Fusion. Exact words and simple
  singular/plural variants strengthen confidence in this mode.

Visible knowledge-space chips define only a requested subset; the server still resolves authoritative silo scope. Filters cover source IDs, path prefix, format, created and modified ranges, page range, image presence, and table presence.

Results are grouped by document. Every passage shows heading breadcrumbs, the server-prepared page/sheet/percentage label, calibrated match confidence, and document metadata. The confidence value is derived from model-specific similarity anchors and retrieval evidence; it is not the probability that a generated answer is correct. Meaning search suppresses candidates below the configured weak-similarity cutoff, while Keyword and Both can still retain exact lexical evidence. The Filters panel provides a per-search minimum-confidence slider from 5% through 95%, defaulting to 30%. Selecting a passage requests server-prepared neighboring context. Operators can open the integrity-checked original or copy a citation containing document identity, qualified locator, passage text, and stable NodeRag IDs. The UI never slices by character offsets. Display truncation is grapheme-aware, while locator arithmetic remains server-owned UTF-16/UTF-8 data.

PDF results open directly at the cited page in a viewport-fitted PDF.js viewer. Evidence highlights are enabled by default and can be toggled from the toolbar without changing the active citation: yellow identifies exact query words, phrases, and supported inflections; green identifies independently scored semantic sentences. The overlay is restricted to the result's cited page range and never paints the complete chunk merely because the result confidence is high. Pages without a reliable PDF text mapping, including image-only scans without OCR word coordinates, remain unhighlighted. The viewer keeps the active result's cited page and confidence visible while Left/Right browse ordinary PDF pages. Down selects the next PDF search passage in displayed result order and jumps to its cited page; Up returns to the previous PDF result and its original cited page. At either boundary the result does not wrap. The Source passage control toggles to extracted neighboring text, while closing either view returns directly to the search results.

Every non-PDF search result opens its canonical Markdown in the same responsive reader used by the
Documents page. This includes native Markdown and text files plus the canonical Markdown extracted
from Word and Excel documents. The reader identifies and scrolls to the cited passage when the
rendered text can be matched, with the stored character position as a fallback, and marks that
block without changing the source. Right scrolls forward through the document and Left scrolls
back; Down selects the next displayed search passage and Up restores the previous passage's
original position. The viewer changes between Markdown and PDF automatically when adjacent results
use different source types, and confidence remains tied to the active result. Source passage
toggles to neighboring extracted context, and its document control returns to the correct reader
rather than opening another window. Closing either view returns directly to the search results.

## Research

Research appears directly below Search in the left navigation. Each signed-in user can create a
personal named collection such as **Legal Notes**. At the top of Search, choose the collection that
should receive passages. Open a result in either the PDF, Markdown, or source-passage view and press
`0`, or use the matching toolbar button, to save that exact citation snapshot. If no collection is
selected, NodeRag shows an error without saving anything. Search results display every collection in
which the passage is already saved.

Pressing `0` again removes the passage only after confirmation; it never deletes the source document.
The Research page lists saved passages in selection order and records the original query, search mode,
confidence, evidence, locator, document, and knowledge-space identity. A collection can contain
references from several knowledge spaces. Open any saved item to use the same responsive viewer:
Up/Down selects the previous or next saved reference, while Left/Right moves within the current PDF or
Markdown document.

Research collections are personal, are unavailable to search-only API keys, and never widen document
access. If a user later loses read access to a referenced knowledge space, the saved item is counted as
hidden and is not returned until access is restored.

## Documents and missing sources

The Documents page lists ingest state, source state, size, page basis, page count, and image count. Its detail dialog displays live ingestion progress for the selected document, including the current stage, pages or passages completed, elapsed time, and an approximate remaining time once enough work has completed to estimate it. Progress is durable and refreshes every two seconds. The dialog also displays canonical Markdown in a responsive, full-height reader, warns when canonical locators do not match source-file text offsets, and exposes the original only through the authenticated streaming endpoint.

The Markdown reader opens in Preview mode and renders GitHub-style headings, paragraphs, emphasis,
links, lists, task lists, blockquotes, tables, horizontal rules, inline code, and fenced code blocks.
Fenced `mermaid` blocks render as diagrams with their source retained in a collapsible fallback. The
Markdown source control switches to the exact canonical text, Copy Markdown copies that source,
and the toolbar shows its word count. Raw HTML is shown as text, unavailable relative links and
images are explained instead of followed, and remote images remain blocked until the reader opts
in for that document view. Diagram output is sanitized and displayed as an isolated image; a
malformed diagram falls back to its readable source without breaking the document.

When a mapped source disappears, extracted text remains available with `source_missing` state. An operator can record a missing-source review note, re-index after recovery, or purge. Purge requires typing `document <ID>` and calls the idempotent API with the exact document and silo IDs.

## Ingest and durable work

PDF ingestion now uses the selective, layout-preserving hybrid pipeline documented in
`docs/Implementation/pdf-layout-hybrid-operations.md`. Document diagnostics distinguish extraction
confidence from search confidence and report the frozen extraction/vision revisions, native versus
vision routing, provider calls, cache hits, elapsed time, warnings, and fallbacks. Enhanced re-index
keeps the prior search chunks active until the replacement embeddings are complete and swaps the
new chunk set transactionally.

- File upload supports PDF, DOCX, XLSX, Markdown, and text through the existing streamed multipart API.
- Input-folder mappings expose include/exclude patterns and an optional interval schedule. The
  source stays read-only; the durable original used for processing and recovery is held in
  NodeRag-managed storage.
- Document processing shows one row per document even though restart-safe extraction, vision,
  chunking, and embedding work remains internally separated. The row advances through 1/3
  Markdown ingestion, 2/3 chunking, and 3/3 embedding, with a progress bar that restarts for each
  stage and names the current task. A first attempt is treated as normal work; actual retries name
  the affected stage, next attempt, and reason. Embedding displays separate newly embedded,
  cache-reused, completed, and remaining passage counts; the active passage range; measured
  passages per minute; and a token-throughput ETA. Passage groups start at two and adapt between
  one and sixteen to target roughly twenty seconds between completed-group updates. A lightweight
  pulse keeps the durable lease and screen current during a slow model call, so the stalled warning
  is reserved for a genuinely overdue heartbeat. Each completed group is committed to the cache
  immediately and is reused after an automatic retry. Input-folder scans appear in their own
  section. Successful and cancelled rows are hidden by default but can be shown again, preserving
  durable diagnostic history. Workflow-level pause, resume, and cancel apply to all eligible
  internal work for that document; retry targets its failed stage.
- Extraction quality checks flag likely repeated headers, replacement/control characters,
  mojibake, symbol-heavy lines, and unusually token-dense passages. NodeRag retains the source and
  extracted Markdown rather than silently deleting questionable content, records the assessment
  in document metadata, and displays a review warning in the active workflow.
- All durable actions carry CSRF and a new idempotency key. A service restart resumes from database checkpoints rather than browser state.

## Administration

For server administrators, **Knowledge Bases** appears as its own left-navigation page immediately
below Documents. It contains the API-backed controls to add an isolated library, edit its name and
description, and permanently purge it with typed confirmation. Non-administrators do not see or gain
route access to this page.

The Administration control center provides API-backed pages for users, search-only API keys,
independent read/upload/delete capabilities, gateways, audit, ingestion logs, settings, models,
builds, storage, backups, restore, evaluation, image understanding, and the generated OpenAPI
contract. Every section begins with a plain-language explanation instead of presenting the endpoint
path as its description. Logs displays the newest ingestion events from the last 24 hours and
refreshes every eight seconds. It can filter failures, warnings/retries, successful stages, or
progress, and exposes safe database table/constraint diagnostics behind expandable technical detail.

The Color schemes section offers Light, Dark, Forest green, Midnight blue, and Deep red previews.
Selecting one applies it immediately and stores the preference under the signed-in principal's ID
in that browser. It does not alter server settings or another user's view. Forest green preserves
the original NodeRag dark-green appearance. The NodeRag `N` appears in desktop and mobile
navigation and in the browser/site icon.

On the Knowledge Bases page, administrators can add knowledge bases and edit their names and
descriptions; slugs remain permanent partition identifiers. System settings expose documented limits
and explain whether they affect chunking, workers, search, or audit retention. The Processing
resources card reports the logical processors available to NodeRag and the embedding threads that
are currently active. Responsive, Balanced, and Fastest highlights presets adjust the embedding CPU
slider, background document concurrency, and interactive-work preference. Applying a changed CPU
value safely reloads the private embedding engine after its current request completes; the NAS does
not restart. If live control is unavailable, the saved value is marked pending and is applied by the
Synology service script on the next Package Center restart. With interactive priority enabled, CPU
slot zero remains available to searches and semantic PDF highlighting while background ingestion
uses the remaining slot and the embedder's priority queue. The worker reads the saved ingestion
concurrency continuously and processes that many independent document workflows, bounded by the
logical CPU count and the configured maximum. Vision settings expose
the Ollama-compatible address, model, optional replacement API key, 1–16 parallel-call limit, a
separate 1–16 images-per-call limit defaulting to 3, timeout, retries, and image-size cap; the stored
API key is never returned. Saving vision settings performs the live activation test.

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

The UI provides a skip link, semantic headings/landmarks, programmatic labels, visible focus, text-backed status, keyboard-operable controls, Escape-close dialogs, five explicit color schemes, 320-pixel responsive layouts, horizontal table overflow, automatic text direction, and reduced-motion behavior. Evaluation cards explicitly inherit the active panel foreground/background pair, preventing white-on-white content in dark schemes. Playwright uses role and label locators rather than implementation selectors. Axe scans login, authenticated search, and the themed administration/evaluation surface for WCAG 2 A/AA and 2.1 A/AA issues. The maintained human review list is `docs/Implementation/checklists/m09-accessibility-checklist.md`.

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
  HTTPS and a bearer API key; a self-hosted endpoint may be unauthenticated. If an error mentions a
  local image fixture or `ENOENT`, the running server predates the built-in activation sample and
  must be upgraded.
- **CSRF/session error:** sign in again; do not copy cookies or CSRF values between browsers.
- **Source rejected:** add the path to the package's declared source roots and verify the package user can traverse and read it.
- **Missing original:** record review, restore the source if appropriate, or use typed purge. Extracted content is intentionally retained until an authorized decision.
- **Regional PDF vision fails after upgrade:** verify migration head
  `000017_ingestion_log_window`, then inspect the document's extraction diagnostics and retryable
  vision error. Do not bypass the strict layout schema or edit canonical Markdown in place.

M09 evidence is WSL/Docker/testbed evidence. It does not claim DSM Package Center layout, ACL, storage, reverse-proxy, browser-launch, or service-impact certification; those remain in the DSM deferred register for the final live-device milestone.
