# C09 Chat DOCX/PDF Export and RAG Promotion — Operations Guide

**Applies to:** NodeRag Chat migration `000027_chat_exports`
**Environment:** WSL/Linux Docker testbed; Synology DSM execution remains deferred to C11
**Provider boundary:** Chat Ollama means Ollama Cloud only

## What C09 adds

C09 turns an immutable Markdown artifact revision into a downloadable DOCX or PDF without giving
the response model a shell, browser, network connection, office application, or arbitrary
filesystem access. Export work runs in the durable worker queue. Every job records the exact source
artifact ID, source revision, source SHA-256, parser/generator policy revision, settings snapshot,
progress events, output MIME type, output SHA-256, and final byte count.

The same exact source revision—or a finished DOCX/PDF export made from it—can be promoted into an
authorized NodeRag knowledge base. Promotion creates an ordinary NodeRag document and ingestion job,
so its parsing, chunking, embedding, progress, retry, and failure behavior remain visible in the
existing document-processing interface.

C09 does not change Chat networking. Ollama generation uses only Ollama Cloud at
`POST https://ollama.com/api/chat`. Chat internet search and page retrieval use only Ollama Cloud at
`POST https://ollama.com/api/web_search` and `POST https://ollama.com/api/web_fetch`, including when
OpenAI generates the response. Local, self-hosted, forwarded, and custom Ollama endpoints are not
Chat options.

## Exporting an artifact

1. Open **Chat**, select a conversation you own, and open **Artifacts**.
2. Select a Markdown file and the immutable revision to export.
3. Choose **Export DOCX** or **Export PDF**.
4. Follow the durable job in the export panel. The panel shows its format, state, progress,
   attempts, warnings, and the source revision it will use.
5. A queued or running job can be cancelled. Cancellation never changes the artifact and removes a
   partially published export.
6. When the job succeeds, select **Download**. PDF exports also have an inline preview.

Editing the Markdown file after submitting an export does not change the queued job. Repeating an
idempotent request returns the original job. Creating a new export from a later revision creates a
separate immutable result.

## Supported document content

The normalized document model supports:

- headings, paragraphs, bold, italic, inline code, links rendered with their visible URL, and rules;
- ordered/unordered lists, block quotes, fenced code, tables, equations, and explicit page breaks;
- a bounded Mermaid flowchart subset rendered without a browser or network connection;
- source/revision provenance, notes, headers, footers, and page numbers;
- Latin, Latin Extended, Greek, Cyrillic, Devanagari, and Vietnamese text through bundled Noto Sans
  fonts.

Unsupported raw HTML is omitted visibly and recorded as a warning. Remote images are not fetched;
the export contains a visible placeholder and warning. Oversized tables, unsupported diagrams, and
unsupported glyphs degrade visibly instead of disappearing silently. The parser accepts at most
10,485,760 source characters, 50,000 blocks, 50 table columns, 500 table rows, and 200 retained
warnings.

## Safety and reproducibility

DOCX output is a passive OOXML package. NodeRag rejects macros, executable or embedded content,
external package relationships, XML entities/DTDs, path traversal, corrupt ZIP entries, excessive
entry counts, and excessive expanded size. Stable ZIP ordering, timestamps, core properties, and
document metadata make the same revision and policy reproducible.

PDF output uses a stable A4 layout, embedded fonts, selectable text, stable metadata, source notes,
and page numbers. NodeRag rejects malformed output and active PDF actions such as JavaScript,
launch actions, embedded files, rich media, additional actions, or open actions.

The production build performs a converter capability probe that generates and validates both
formats. The probe runs entirely in-process and succeeds in a Linux/amd64 container with networking
disabled. Administrators can see the same converter health under **Administration → Chat
settings**.

## Durable execution and limits

Open **Administration → Chat settings** to set:

- **Maximum export size:** 1–512 MiB; default 64 MiB;
- **Export timeout:** 10 seconds–15 minutes; default 120 seconds;
- **Maximum attempts:** 1–5; default 2.

Each job snapshots these limits. A later configuration edit affects only later jobs. Workers claim
jobs by lease, heartbeat while working, and can reclaim an expired lease after a stopped worker.
Two workers cannot complete the same job twice. A cancelled, timed-out, crashed, disk-full, invalid,
or exhausted job never exposes a partial download. Safe errors contain a stable code and do not
contain provider secrets, prompts, or host filesystem paths.

## Promoting an exact revision to a knowledge base

1. Select the finished artifact revision or export in the artifact drawer.
2. Under **Upload to RAG database**, choose a knowledge base for which your account currently has
   the `upload` grant.
3. Choose Markdown, DOCX, or PDF and select **Upload exact revision**.
4. NodeRag verifies the source revision and SHA-256, stages the bytes through the normal document
   file store, validates MIME/signature/package safety, and creates the existing ingestion job.
5. Follow the returned document/job in the knowledge-base document-processing view.

The document metadata retains the chat, artifact, artifact revision, export job/revision when used,
source SHA-256, output SHA-256, format, and generation-policy revision. Editing or deleting the
working artifact later does not mutate the promoted document. Purging the RAG document does not
purge the Chat artifact or export; each lifecycle requires its own authorization and confirmation.

Cross-knowledge-base arguments are rejected unless the current principal has the exact upload
grant. Revoking that grant before promotion prevents the operation. Idempotent retries return the
same document and ingestion job rather than creating duplicates.

## Recovery and storage notes

Full encrypted backup classification includes export job, event, and ingestion-link rows. Portable
exports exclude them. Export files live under the verified contained Chat storage root and are
hash-checked before download. The complete external `.noderag-chat` folder archive/import and
existing-folder reconciliation workflow is delivered in C10; do not treat copying only the database
rows as a complete Chat-file backup before C10 closes.

## Safe error guidance

- `chat_export_source_revision_missing`: reload revision history and select a retained revision.
- `chat_export_output_too_large`: reduce the document or raise the administrator limit safely.
- `chat_export_timeout`: reduce document complexity or raise the bounded timeout and retry.
- `chat_export_insufficient_disk_space`: free space on the verified Chat volume and retry.
- `chat_export_output_invalid`: keep the source; review warnings and converter health before retry.
- `chat_export_cancelled`: the job was cancelled and no partial output was retained.
- `upload_grant_required`: choose a knowledge base where the signed-in user has upload access.
- `chat_export_hash_mismatch`: do not use the file; inspect storage integrity and retry from the
  immutable source revision.

## C09 verification baseline

- focused converter unit tests: 7/7 passing;
- focused PostgreSQL export/promotion integration: 7/7 passing;
- complete unit suite: 50 files, 212 tests passing;
- complete Docker PostgreSQL integration: 18 files, 115 tests passing;
- complete Chromium operator workflow: 28 tests passing;
- production build/smoke, no-network Linux converter probe, migrations, API inventory, type checks,
  lint, formatting, dependency boundaries, license review, SBOM, and secret scan: passing.
