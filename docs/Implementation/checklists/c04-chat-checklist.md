# C04 — Durable Chat Core and Two-Panel UI Checklist

**Status:** Testbed complete
**Environment:** F-drive worktree; WSL2 Linux/amd64 Docker testbed
**Recorded:** 2026-09-15

## Persistence and ownership

- [x] Migration 000022 adds conversations, immutable configuration snapshots, messages, runs,
      normalized events, log cursors, and daily usage.
- [x] Every conversation and query is owner-scoped; another entitled user receives a hidden 404.
- [x] Browser session, entitlement, CSRF, and idempotency checks cover every applicable route.
- [x] Search-only/API-key access is hidden as 404.
- [x] One active run per conversation is enforced by both application checks and a partial unique
      database index.
- [x] Chat configuration snapshots pin provider, model, effort, rolling context, capacity, and a
      tool policy with Research/RAG/internet disabled.

## Cloud and provider boundaries

- [x] Ollama generation uses only `https://ollama.com/api/chat` with encrypted bearer credentials.
- [x] Local, self-hosted, forwarded, and custom Ollama addresses are absent and rejected.
- [x] OpenAI runs through the pinned supervised app-server using an ephemeral read-only thread.
- [x] OpenAI web search, workspace roots, environments, dynamic tools, and approvals are disabled.
- [x] Every provider request receives an empty tool list; unexpected tool activity fails closed.
- [x] Reasoning output is limited to provider-supplied safe summaries; hidden reasoning is not stored.

## Worker, stream, and storage

- [x] Durable send, Stop, and Retry operations persist before work begins.
- [x] Worker claims, renewable leases, bounded timeouts, retry classification, cancellation, and
      expired-lease recovery are implemented.
- [x] Provider event order is checked; repeated sequence numbers and missing terminal events fail.
- [x] Conversation-before-run locking prevents Stop/stream deadlocks.
- [x] SSE supports committed replay with increasing IDs and `Last-Event-ID` resume.
- [x] PostgreSQL events and private NDJSON logs share a verified SHA-256 chain.
- [x] Interrupted trailing appends are repaired from PostgreSQL; corrupt chains/checkpoints fail.
- [x] API restart and worker restart preserve committed history and release permanent running states.

## API and interface

- [x] List/create/read/rename/archive/purge and cursor-paginated history routes exist.
- [x] Send/Stop/Retry and resumable event routes exist.
- [x] Administrator entitlement mutation exists and is audited through normal route protections.
- [x] Route authorization, OpenAPI inventory, migration checksums, and backup classifications include
      C04.
- [x] Chat appears directly below Research only for entitled users with a healthy model.
- [x] Two-panel responsive layout, create dialog, bubbles, final-answer marker, provider label,
      capability disclosure, Stop, Retry, reconnect, and older-history paging are implemented.
- [x] Enter sends and Shift+Enter inserts a line break.
- [x] Rename/archive, mobile overflow, and focused accessibility checks pass.

## Verification

- [x] C04 Linux/amd64 PostgreSQL integration: 8/8 passing.
- [x] Combined configuration/provider/recovery integration: 22/22 passing; 30/30 including C04.
- [x] Full browser suite: 24/24 passing with WCAG A/AA checks.
- [x] Full unit suite: 47 files and 191 tests passing.
- [x] Migration inventory passes at `000022_chat_core`.
- [x] Workspace typecheck, lint, formatting, boundaries, build/smoke, licenses, SBOM, and secret scan
      pass in the combined quality gate.
- [x] Real DSM execution remains explicitly deferred to C11.

## Exit gate

C04 is closed. An entitled user can create and resume durable provider-backed text chats with no
tools. Browser/API restarts and worker lease recovery preserve committed history. C05 may add only
permission-checked Research snapshots and citations; internet remains disabled until C07 and remains
Ollama Cloud-only when enabled.
