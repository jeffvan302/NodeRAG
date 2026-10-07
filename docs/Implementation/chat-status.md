# NodeRag Chat Implementation Status

**Authority:** [Chat phased implementation plan](chat-phased-implementation.md)
**Last updated:** 2026-09-16
**Current stage:** C11 — security, evaluation, operations, and DSM release candidate
**Overall state:** C00–C10 are complete; C11 Docker/package qualification is complete and live DSM acceptance is pending

## Stage dashboard

| Stage                             | State            | Completed evidence                                                                                                                                                   | Still required to close stage                                                               |
| --------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| C00 Scope/privacy/feasibility     | Testbed complete | Accepted egress/security decision; provider/event contract and fakes; nine disabled flags; Windows, WSL, and isolated Docker app-server smoke; complete quality gate | Real DSM app-server execution remains intentionally deferred to C11                         |
| C01 Ollama Cloud Administration   | Testbed complete | Migration 000019; encrypted key retain/replace/clear; fixed Cloud adapter; independent generation/search/fetch health; admin API/UI; backup/recovery and full gates  | Optional synthetic live-account test; real DSM execution remains deferred to C11            |
| C02 OpenAI OAuth Administration   | Testbed complete | Supervised app-server; device-code login; encrypted restart restore; live models/efforts; rate limits; admin API/UI; recovery and full gates                         | Optional dedicated live account test; real DSM app-server execution remains deferred to C11 |
| C03 Context Window Administration | Testbed complete | Migration 000021; immutable settings; capacity provenance; rolling/managed validation; storage probe; admin API/UI; recovery and full gates                          | Real DSM ACL/filesystem execution remains deferred to C11                                   |
| C04 Durable Chat core/UI          | Testbed complete | Migration 000022; owner/entitlement isolation; durable runs/events; leases/SSE/NDJSON recovery; Cloud/OpenAI generation; responsive UI; all gates                    | Real DSM execution remains deferred to C11                                                  |
| C05 Research attachments          | Testbed complete | Migration 000023; immutable bounded snapshots; per-read grants/hashes; three provider-bound Research tools; stable citations/viewers; backup/restore and all gates   | Real DSM execution remains deferred to C11                                                  |
| C06 RAG tools                     | Testbed complete | Migration 000024; direct retrieval service; current per-call `SiloScope`; bounded tools/results; immutable citations; all Search modes; viewers and all gates        | Real DSM execution remains deferred to C11                                                  |
| C07 Ollama Cloud internet         | Testbed complete | Migration 000025; fixed hosted search/fetch; strict URL/content limits; immutable web citations; safe usage diagnostics; all gates                                   | Optional synthetic live-account test; real DSM execution remains deferred to C11            |
| C08 Chat files/Markdown           | Testbed complete | Migrations 000026/000029; contained Markdown workspace; immutable revisions; owner-only UUID image URLs; safe reader; artifact drawer; recovery and all gates        | Real DSM filesystem execution remains deferred to C11                                       |
| C09 DOCX/PDF export               | Testbed complete | Migration 000027; passive deterministic DOCX/PDF; durable export jobs; exact-revision RAG promotion; preview/download; all gates                                     | Real DSM filesystem/execution remains deferred to C11                                       |
| C10 Managed context/archives      | Testbed complete | Migration 000028; conservative budgets; L1–L4 compression; immutable snapshots; verified gzip paging; owner-mapped reconciliation; all gates                         | Real DSM filesystem/execution remains deferred to C11                                       |
| C11 DSM package/release           | DSM pending      | Security/evaluation/recovery gates; revision 32 exact-SPK lifecycle and 26→32 upgrade; short and one-hour mixed workloads; Chat file URL qualification               | Live checksum-matched Synology acceptance                                                   |

## Current verification

- C11 revision 32 is the active package candidate:
  `spk/artifacts/noderag-1.0.0-32-x86_64.spk`, 188,426,240 bytes, SHA-256
  `24e0115026d6b8ccc1b9e8aba5cbeb17bdfef00dcef8535ca3931465a24c8bd4`.
- C11 provider boundary: Chat generation, internet search, and internet fetch use Ollama Cloud
  only; the service root is fixed to `https://ollama.com`, and no local/custom Chat endpoint is
  accepted. The loopback Ollama process in soak testing is a vision-only outage test double.
- C11 final quality gate: 29 forward-only migrations through `000029_chat_files`, 53 unit files and
  237 tests, type checks, lint/format, dependency boundaries, production build and
  smoke, licenses, SBOM, and secret scan all pass.
- C11 full PostgreSQL integration suite: 19 files and 119 tests passing. The initial isolated rerun
  omitted one planning fixture from its test-only copy; after copying that fixture, its 10 tests
  passed without a product-code change.
- C11 full browser/accessibility suite: 29/29 passing.
- C11 conversation evaluation: eight frozen scenarios, 12 executable evidence references, 18
  focused unit tests, and 38 focused PostgreSQL integration tests passing.
- Chat file verification covers duplicate original filenames, distinct UUID URLs, owner/search-only/
  disabled isolation, exact extension matching, binary integrity, shared quota, delete invalidation,
  DSM mount-prefix URL resolution, Markdown rendering, and the complete browser workflow.
- Revision 32 exact-SPK lifecycle verification passed under the non-root package identity, including
  retained uninstall/reinstall, destructive purge, and feature-disabled rollback behavior.
- The revision 26→32 forward-upgrade simulation passed while preserving administrator authentication,
  the knowledge base, the existing search index without re-embedding, Research data, and the setup
  root key.
- The revision 32 90-second validation passed with zero failures. It recorded 16 resource samples,
  94 searches, 16 Chat reads, package restart/log rotation, verified manual and scheduled backups,
  source-loss recovery, reindexing, and rebuild activation. Its proof SHA-256 is
  `fd4e2339a342c00099f41df79670405fabade728dfe49610e9765445010a6e4d`.
- The exact revision 32 one-hour mixed workload passed with zero failures over 3,618.296 seconds. It
  recorded 60 resource samples, 324 searches, 60 MCP requests, 60 gateway requests, 60 cross-silo
  checks, 60 Chat reads/health checks, six background ingests, six Chat artifact checkpoints,
  restart/log rotation, backup verification, scheduled backup verification, source-loss recovery,
  reindexing, rebuild activation, and vision outage/recovery. Peak sampled RSS was 208,504 KiB for
  the server, 137,500 KiB for the worker, and 67,344 KiB for the embedder; peak package data was
  178,105,180 bytes. The preserved proof SHA-256 is
  `7dcc6ff957640f0adfafd79ae2c69f1b078e248e03f3e7fd5344f57cffa8666a`.

- C10 focused context runtime unit suite: 12/12 passing, including the retained-facts golden set.
- C10 focused managed-context/reconciliation PostgreSQL integration: 3/3 passing; combined
  configuration/context group 7/7.
- C10 full integration suite: 19 files and 118 tests passing.
- C10 full browser suite: 29/29 passing, including pin/unpin, compression preview/cancel, verified
  older-log paging, existing-folder owner mapping/reconciliation, and WCAG A/AA scans.
- C10 full unit suite: 51 files and 224 tests passing.
- C10 migration head: `000028_chat_managed_context`.
- C10 workspace migration/OpenAPI, type-check, lint, format, boundary, build/smoke, license, SBOM,
  and secret-scan quality gate: passing.

- C09 focused export unit suite: 7/7 passing.
- C09 focused export and exact-revision promotion PostgreSQL integration: 7/7 passing.
- C09 full integration suite: 18 files and 115 tests passing.
- C09 full browser suite: 28/28 passing, including export progress/cancel/download, PDF preview,
  exact-revision upload, Administration limits, and converter health.
- C09 full unit suite: 50 files and 212 tests passing.
- C09 migration head: `000027_chat_exports`.
- C09 Linux/amd64 production converter probe passes with networking disabled.
- C09 workspace migration/OpenAPI, type-check, lint, format, boundary, build/smoke, license, SBOM,
  and secret-scan quality gate: passing.

- C08 focused artifact unit suite: 4/4 passing.
- C08 focused artifact PostgreSQL integration: 7/7 passing; artifact/configuration/log group 20/20.
- Full integration suite: 17 files and 108 tests passing.
- C08 full browser suite: 28/28 passing, including artifact navigation/edit/compare/delete,
  external-image blocking, safe Mermaid, and KaTeX.
- C08 full unit suite: 49 files and 205 tests passing.
- C08 migration head: `000026_chat_artifacts`.
- C08 workspace migration/OpenAPI, type-check, lint, format, boundary, build/smoke, license, SBOM,
  and secret-scan quality gate: passing.

- C07 focused Ollama Cloud web PostgreSQL integration: 5/5 passing, including fixed endpoints,
  OpenAI generation with Cloud-only web tools, immutable citations, unsafe URL filtering, prompt
  injection containment, redacted queries, capability loss, owner isolation, and shared rate limit.
- Provider plus C07 integration: 19/19 passing, including safe Administration usage diagnostics.
- Combined Chat configuration/provider/Research/RAG/web/recovery integration: 46/46 passing.
- C07 full browser suite: 27/27 passing, including independent Cloud internet opt-in, durable web
  citation preview, Administration diagnostics, and WCAG A/AA checks.
- C07 full unit suite: 48 files and 201 tests passing.
- C07 migration head: `000025_chat_web`.
- C07 workspace migration/OpenAPI, type-check, lint, format, boundary, build/smoke, license, SBOM,
  and secret-scan quality gate: passing.

- C06 focused permission-scoped RAG PostgreSQL integration: 5/5 passing, including all four Search
  modes, cross-space arguments, zero/one grant, live revocation, stale sources, duplicate loops,
  long-result clipping/paging, search-only credentials, and owner isolation.
- Combined Chat configuration/provider/Research/RAG/recovery integration: 40/40 passing.
- C06 full browser suite: 26/26 passing, including independent RAG opt-in, exact citation viewers,
  Ollama Cloud-only disclosure, and WCAG A/AA checks.
- C06 full unit suite: 47 files and 195 tests passing.
- C06 migration head: `000024_chat_rag`.
- C06 workspace migration/OpenAPI, type-check, lint, format, boundary, build/smoke, license, SBOM,
  and secret-scan quality gate: passing.

- C05 focused Research PostgreSQL integration: 5/5 passing, including cross-owner isolation, live
  grant revocation, stale sources, immutable refresh, and exact viewer reads.
- Combined Chat configuration/provider/Research/recovery integration: 35/35 passing.
- C05 full browser suite: 25/25 passing, including stable Research citations and WCAG A/AA checks.
- C05 full unit suite: 47 files and 195 tests passing.
- C05 migration head: `000023_chat_research`.
- C05 workspace migration/OpenAPI, type-check, lint, format, boundary, build/smoke, license, SBOM,
  and secret-scan quality gate: passing.

- C04 durable Chat Docker integration: 8/8 passing, including restart, timeout, cancellation,
  expired-lease, replay, event-order, and interrupted-append faults.
- Combined Chat configuration/provider/recovery integration: 30/30 passing.
- C04 full browser suite: 24/24 passing, including Chat workflow, mobile layout, and accessibility.
- C04 full unit suite: 47 files and 191 tests passing.
- C04 migration head: `000022_chat_core`.

- C03 configuration, provider, and encrypted recovery Docker integration: 22/22 passing.
- C03 known-model capacity table and administrator/provider precedence are exercised end to end.
- C03 full browser suite: 23/23 passing, including focused WCAG A/AA scans.
- C03 full unit suite: 45 files and 186 tests passing.
- C03 migration head: `000021_chat_configuration`.
- C02 protocol and OAuth focused unit checks: 14/14 passing.
- Combined Chat provider Docker integration: 13/13 passing, including correct OpenAI capability
  revalidation after model changes and provider re-enablement.
- Encrypted backup/restore integration, including disabled-on-restore Ollama Cloud and OpenAI OAuth
  credentials: 4/4 passing.
- Focused OpenAI device-code/model/disconnect browser workflow and WCAG A/AA scan: passing.
- Full browser suite: 23/23 passing.
- `@noderag/server` TypeScript check: passing.
- `@openai/codex@0.147.0` app-server initialize/account/model-catalog smoke: passing on Windows x64.
- Source-tree and production-built app-server smoke: passing in Linux/amd64 Node 22 Docker.
- Docker Linux/amd64 engine inside WSL: running with overlayfs/systemd.
- Isolated Node 22 Docker app-server smoke with networking disabled: passing.
- Workspace-wide migration/OpenAPI, type-check, lint, format, boundary, build/smoke, license, SBOM,
  and secret-scan gate: passing.
- Full unit suite: 45 files and 186 tests passing.

## Immediate next work

1. Install the exact checksum-matched SPK on the real Synology and complete the DSM acceptance
   matrix, including Web Station, package ACLs, Ollama Cloud, optional OpenAI OAuth claim scope,
   restart/reboot, backup/restore, exports, ingestion bridge, and resource ceilings.
2. Freeze the implementation in a source commit before any release publication.
