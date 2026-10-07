# C10 — Managed Context, Archives, and Reconciliation Checklist

**Status:** Testbed complete
**Environment:** F-drive worktree; WSL2 Linux/amd64 Docker testbed
**Recorded:** 2026-09-15

## Cloud boundary

- [x] Every Chat Ollama capability means Ollama Cloud only.
- [x] Local, self-hosted, forwarded, and custom Ollama endpoints remain unavailable to Chat.
- [x] Ollama Cloud remains the sole Chat web-search and web-fetch service, including for OpenAI
      response models.
- [x] L2/L3 compression calls have no tools or independent network capability.

## Context runtime

- [x] Migration 000028 adds usage, pin, snapshot, compression-job/event, archive, and import state.
- [x] Conservative provider-aware estimation accounts for messages, injected context, tools, tool
      results, wrappers, and output reserve.
- [x] Capacity is checked before the initial provider request and after each admitted tool result.
- [x] Unknown context, invalid reserves, oversized mandatory input, exact pins, and cumulative tool
      continuations fail closed.
- [x] Rolling L4 context keeps complete turns, current input, and bounded exact pins.
- [x] Managed context combines L1 pins, bounded L2 narrative, validated L3 JSON, and complete L4
      turns.
- [x] L2/L3 use saved independent providers/models/efforts, no tools, timeouts, and lease heartbeats.
- [x] Layers run concurrently only with two scheduler slots and distinct providers.
- [x] Failed/malformed layers retain a prior valid layer or fold nothing when none exists.
- [x] Immutable snapshots include source/layer hashes, estimates, scheduling, retained-layer status,
      and the linked log segment.
- [x] Compression never deletes original messages; folded rows remain page-readable.
- [x] Manual dry run, queue, status, cancellation, pin/unpin, and older-log controls are usable and
      accessible in Chat.

## Archive and recovery

- [x] Event logs use bounded canonical NDJSON and database-derived hash chains.
- [x] Deterministic gzip sealing is synchronized and verified before manifest publication.
- [x] Folded rows reference the sealed segment; reads verify the referenced archive before returning.
- [x] Cursor paging sends only the selected history page to the browser.
- [x] Portable content-addressed manifests include conversation, owner, configuration, messages,
      runs, and segments.
- [x] Read-only inspection validates containment, symlinks, schema, hashes, ordering, identities, and
      the root manifest.
- [x] Import requires explicit source-owner mapping, is durable/idempotent, preserves event IDs, and
      disables all imported tools.
- [x] Partial, corrupt, unmapped, conflicting, future, duplicate, and unsafe data are quarantined
      without guessed repair or overwrite.
- [x] Administration exposes inspection, owner mapping, reconcile, and safe operation status.

## Verification

- [x] Context runtime unit suite: 12/12 passing, including the three-case retention golden set.
- [x] Focused context/reconciliation PostgreSQL integration: 3/3 passing.
- [x] Combined configuration/context PostgreSQL integration: 7/7 passing.
- [x] Full integration suite: 19 files and 118 tests passing.
- [x] Full browser suite: 29/29 passing, including pins, dry run, queue/cancel, verified older logs,
      recovery UI, and WCAG A/AA scans.
- [x] Full unit suite: 51 files and 224 tests passing.
- [x] Migration inventory passes at `000028_chat_managed_context`.
- [x] OpenAPI, authorization inventory, type-check, lint, formatting, dependency boundaries,
      production build/smoke, licenses, SBOM, and secret scan pass.
- [x] Real DSM execution and a new SPK remain explicitly deferred to C11.

## Exit gate

C10 is closed. Long Chats stay within verified provider budgets, retain complete original history,
recover compression after interruption, verify archived history before paging it, and reconcile an
existing `.noderag-chat` folder only through explicit, safe, owner-mapped operations. C11 can now
perform combined security/evaluation/recovery hardening and produce the first Chat-capable DSM
candidate.
