# C08 — Chat Filesystem and Markdown Authoring Checklist

**Status:** Testbed complete
**Environment:** F-drive worktree; WSL2 Linux/amd64 Docker testbed
**Recorded:** 2026-09-15

## Provider boundary

- [x] Every Chat Ollama capability means Ollama Cloud only.
- [x] Local, self-hosted, forwarded, and custom Ollama addresses remain unavailable to Chat.
- [x] Ollama Cloud remains the sole Chat internet-search and web-fetch provider, including for
      OpenAI-authored answers.
- [x] File tools cannot add a provider, URL, shell, network client, or hidden capability.

## Storage and data model

- [x] Migration 000026 adds artifact metadata, immutable artifact revisions, and log segments.
- [x] Every workspace resolves beneath the verified Chat root, owner principal, and chat UUID.
- [x] Working files, immutable revisions, and temporary atomic writes use separate contained folders.
- [x] Absolute/traversal/device/hidden/ADS/control/reserved/trailing-dot paths are rejected.
- [x] Portable case-insensitive keys prevent Unicode/case path aliases.
- [x] Symlink and junction path chains fail closed; real paths are rechecked for containment.
- [x] Only `.md` and `.markdown` files are accepted.
- [x] Maximum-file and per-chat quotas are enforced before commit.
- [x] Full encrypted backup includes artifact data/files; portable export excludes them.

## Operations and revisions

- [x] List, read, create, mkdir, rename, copy, patch, history, download, and confirmed delete exist.
- [x] There is no shell operation and delete is not exposed to the model.
- [x] Line patches require the current SHA-256 and exact expected source lines.
- [x] Writes use same-volume temporary files, file synchronization, atomic rename, and directory
      synchronization where supported.
- [x] Immutable revision files are hash-verified on every read/download.
- [x] Simultaneous writes serialize on the artifact row; only one stale-hash edit succeeds.
- [x] Abandoned temporary files cannot replace or contaminate a committed revision.
- [x] User mutations require authentication, entitlement, current ownership, CSRF, and idempotency.
- [x] Mutation audits record create/mkdir/revise/rename/copy/delete without file contents.

## Provenance and model tools

- [x] Model revisions link to the exact chat response, run, and persisted tool call.
- [x] Claimed R/S/W citations must exist on that same response.
- [x] Cross-owner or fabricated provenance is rejected.
- [x] Model tools are limited to list/read/create/mkdir/rename/copy/patch.
- [x] File/tool content remains explicitly untrusted.

## Interface and Markdown safety

- [x] Chat has a responsive artifact drawer with breadcrumbs and folder navigation.
- [x] Users can create folders/Markdown, preview, edit, save, copy, rename, download, and delete.
- [x] Revision history and side-by-side historical comparison are available.
- [x] Quota, file count, maximum-file size, and external-image policy are visible.
- [x] Up/Down selects entries, Right opens, and Left returns to the parent folder.
- [x] The shared reader supports GFM, sanitized Mermaid/ER diagrams, and trusted-off KaTeX/LaTeX.
- [x] Scripts, forms, frames, objects, unsafe links/HTML/styles, and browser storage are unavailable.
- [x] External images are administrator-opt-in and remain user-initiated.
- [x] Chat artifact size/quota/image and active-log settings persist across configuration revisions.

## Logs and reconciliation

- [x] Active NDJSON logs retain the existing per-event hash chain and database cursor.
- [x] Active log metadata records content SHA-256, bytes, count, path, and first/last event IDs.
- [x] An interrupted tail append is recoverable; earlier corruption fails closed.
- [x] **View older logs** remains database-cursor based; archive compression stays assigned to C10.
- [x] Reconciliation reports untracked/missing/changed/unsafe paths with zero automatic mutations.

## Verification

- [x] Focused artifact unit suite: 4/4 passing.
- [x] Focused artifact PostgreSQL integration: 7/7 passing.
- [x] Artifact/configuration/log focused PostgreSQL integration: 20/20 passing.
- [x] Full integration suite: 17 files and 108 tests passing.
- [x] Full browser suite: 28/28 passing, including artifact navigation/edit/compare/delete and
      sanitized Mermaid/KaTeX rendering.
- [x] Full unit suite: 49 files and 205 tests passing.
- [x] Migration inventory passes at `000026_chat_artifacts`.
- [x] OpenAPI, typecheck, lint, formatting, boundaries, build/smoke, licenses, SBOM, and secret scan
      pass as one quality gate.
- [x] Real DSM execution and a new SPK remain explicitly deferred to C11.

## Exit gate

C08 is closed. A chat owner and response model can safely create and revise Markdown inside a
versioned contained workspace, with no shell or external filesystem access. Long-lived logs and
files have verifiable integrity, and the responsive interface exposes the required navigation,
preview, history, comparison, download, quota, and recovery information.
