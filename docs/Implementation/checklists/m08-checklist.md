# M08 — Retrieval, API, Gateway, MCP, and Evaluation Checklist

Status: implementation CI passed; proof-closure CI pending

Environment: WSL/Docker testbed, PostgreSQL 17/pgvector containers, and non-root Linux package simulation

Recorded: 2026-09-04

## Retrieval

- [x] Query text is normalized to NFC and bounded before retrieval.
- [x] Vector search uses the active build/model query instruction and only active-build chunks.
- [x] Vector/keyword candidates are selected per authorized silo partition.
- [x] Vector transactions set HNSW `ef_search` and relaxed iterative scan locally.
- [x] Keyword retrieval uses `websearch_to_tsquery('simple', ...)` and partition GIN indexes.
- [x] Hybrid retrieval uses Reciprocal Rank Fusion with `k=60`.
- [x] Source, path, format, created/modified, page, image, and table filters are bounded.
- [x] Same-document overlapping/abutting hits collapse; different documents never merge.
- [x] Page-bearing formats return stable page labels and page-less formats return percentage labels.
- [x] Page and chunk context is pre-split into strings for clients.

## REST, contracts, and protocol behavior

- [x] The Section 4.7 setup, identity, retrieval, ingestion, jobs, vision, and administration route family is implemented.
- [x] Every response carries a request ID and failures use RFC 9457 problem details.
- [x] Search and document collections use authenticated opaque cursors; tampering fails cleanly.
- [x] Browser mutations enforce Origin/CSRF and declared mutations enforce idempotency.
- [x] Same idempotency key/body replays; changed body returns 409.
- [x] API keys enforce CIDR policy and per-key rate limits with 429/`Retry-After`.
- [x] Markdown and original downloads stream only after SHA-256 verification.
- [x] Private managed paths are never returned; download tickets are unnecessary for the current authenticated streaming design.
- [x] `platform/openapi.m08.json` is generated from the authorization inventory.
- [x] Startup fails if the registered Fastify routes and authorization inventory differ.
- [x] CI fails when the generated OpenAPI document is stale.

## Scope, gateways, and MCP

- [x] All retrieval/document/chunk/image paths use server-resolved `SiloScope`.
- [x] Unauthorized IDs return 404 or an empty result without enumeration.
- [x] Search-only keys cannot retrieve whole artifacts or mutate.
- [x] Gateway listeners are restricted to the statically declared 5300–5319 range.
- [x] Gateway scope is always intersected with principal scope and never widens it.
- [x] Port conflicts are recorded without crashing the control listener.
- [x] Gateway listeners expose retrieval/MCP, not setup, ingestion, or administration.
- [x] MCP supports initialize, ping, tool listing, and strict tool invocation.
- [x] MCP search, chunk context, document page, and silo tools use the same scope/audit services as REST.
- [x] Model-supplied silo IDs cannot escape server scope.

## Audit, RLS, ANN, and evaluation

- [x] Search audit records hash/length/mode/filters/scope/hits/latency/request/principal/gateway/outcome and never raw query text.
- [x] The RLS benchmark uses 8 silos, 8,500 chunks, a 5,000-chunk target partition, HNSW, warmup, 160 alternating samples, and 10 server-reported executions per sample.
- [x] RLS-on p95 is 0.2018 ms versus 0.1970 ms off: 2.44% overhead, below the 15% gate.
- [x] The measured plan retains both the scoped partition and HNSW index.
- [x] The accepted decision keeps chunk RLS and is recorded in an ADR and database diagnostic.
- [x] Approximate-versus-exact Recall@10 is recorded at 0.90.
- [x] The evaluation schema uses document/page relevance and excludes chunk IDs.
- [x] Evaluation computes Recall@10, MRR, nDCG@10, zero-result rate, latency, silo, and format breakdowns.

## Local verification and package

- [x] Six forward-only migration checksums verify with head `000006_retrieval_interfaces`.
- [x] TypeScript, lint, formatting, dependency boundaries, OpenAPI drift, licenses, and secret scanning pass.
- [x] All 21 unit files and 59 unit tests pass.
- [x] All 8 PostgreSQL integration files and 44 integration tests pass.
- [x] Production UI/server/worker/embedder builds and the built-server smoke test pass.
- [x] Two thin-SPK builds are byte-identical at 16,189,440 bytes with SHA-256 `bc753fb8690215d0a0d648d3b0ab32725ec6574ad004a542eddbd86c3e79bfb5`.
- [x] Thin-SPK archive/static checks and non-root lifecycle simulation pass.
- [x] Repository hygiene passes.

## GitHub and closure

- [x] The M08 implementation commit is pushed to `main`; M08 run `33881015555` passes all four required jobs.
- [x] `m08-proof.json` freezes commit, workflow, contract, diagnostic, and package evidence.
- [ ] The proof-closure commit passes every required M08 GitHub job.
- [ ] The final certification commit passes every required M08 GitHub job.
- [ ] Annotated tag `m08-complete` resolves remotely to the final certification commit.

## Honest limitations and DSM deferral

- [x] Live gateway port ownership, reverse-proxy/web integration, package-identity networking, retrieval load, thermals, and DSM service impact remain in the deferred register.
- [x] No Docker, WSL, static archive, or package-simulator result is represented as live DSM evidence.

M09 is not authorized until the GitHub and closure items pass. No M08 testbed result closes a live DSM register row.
