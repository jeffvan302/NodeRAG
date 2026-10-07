# M08 Retrieval, API, Gateway, MCP, and Evaluation Operations

NodeRag exposes one authorization model through the control listener, narrowed gateway listeners, REST, and MCP. Every operation starts with an authenticated principal and resolves a `SiloScope`; gateway scope is intersected with the principal's grants and can never add a silo.

## Retrieval behavior

`POST /v1/search` accepts `vector`, `semantic`, `keyword`, or `hybrid` mode. Queries are normalized to NFC, trimmed, and whitespace-collapsed before use. Vector requests prepend the active build's frozen query instruction and use only the active model manifest; matching-word evidence does not alter Meaning ranking. Semantic first obtains a bounded vector shortlist, embeds up to six sentence-sized candidates per shortlisted passage with the frozen document prefix, drops passages without an accepted sentence, and reranks the survivors by their strongest sentence. Its displayed confidence and returned green evidence are derived from that same sentence score. Keyword requests use PostgreSQL `websearch_to_tsquery('simple', ...)`. Hybrid requests combine vector and keyword ranks with Reciprocal Rank Fusion using `k=60`, and exact words plus simple singular/plural variants strengthen the resulting confidence. The operator UI defaults to Both/hybrid.

`POST /v1/search/evidence` accepts the normalized query, search mode, and up to eight authorized active-build chunk IDs from one displayed result. It returns bounded short evidence rather than the complete chunk: exact query words and supported inflections are marked `exact`, while vector/hybrid requests independently embed and score at most twelve sentence-sized candidates and return the strongest two as `semantic`. Evidence generation is on demand for those ordinary modes. Semantic search instead returns its already-ranked sentence evidence with each hit, ensuring that result order, displayed confidence, and green PDF highlights cannot disagree. A direct evidence request in Semantic mode returns green semantic evidence only.

Each permitted silo is searched through its own list partition. Vector transactions set `hnsw.ef_search` and relaxed iterative scan locally. Results from permitted partitions are merged, then overlapping or abutting character ranges in the same document are collapsed. Different documents are never collapsed together.

Supported filters are source, path prefix, format, created range, modified range, page range, image presence, and detected-table presence. Filter arrays and text lengths are bounded by the request schema. Page-bearing formats return a stable page range. Page-less formats return a percentage-through-document label. Context endpoints return `before`, `match`, and `after` strings so clients do not need to interpret UTF-16 character offsets.

Search responses use an HMAC-authenticated opaque cursor. A cursor is tied to the normalized query, mode, filters, and effective scope. Tampering, reuse with a changed request, an invalid offset, or an unknown cursor kind returns a 400 problem response.

## Authorization and artifact access

- Unauthenticated requests return 401.
- An authenticated non-administrator using an administration route returns 403.
- A principal without access to a requested document, chunk, page, image, source, job, or silo receives 404 or an empty collection according to the authorization inventory; the response does not reveal whether the object exists.
- Search-only API keys may search, list allowed silos, and retrieve scoped chunk/context results. They cannot retrieve whole documents, markdown, originals, images, raw embeddings, or mutations.
- Original and canonical Markdown downloads are streamed only after the stored SHA-256 is verified. Filesystem paths are never returned.
- Browser mutations require a valid session, Origin, and CSRF token. Idempotent mutations additionally require `Idempotency-Key`; the same key/body replays the saved response and a changed body returns 409.
- API-key CIDR failures return 403. Per-key rate-limit failures return 429 with `Retry-After`.
- Every response carries `X-Request-Id`. Errors use `application/problem+json` in the RFC 9457 shape.

The canonical authorization declaration is `platform/route-authorization.v1.json`. `platform/openapi.m08.json` is generated from that inventory. Application startup compares the complete registered Fastify route set with the inventory and fails on any missing, duplicate, or undocumented route. CI also regenerates the OpenAPI document and rejects drift.

## Gateway listeners

The control service manages optional gateway listeners only in the statically declared range 5300–5319. A listener exposes retrieval and MCP surfaces, not administration, setup, or ingestion surfaces. It uses the same authentication, scope, audit, rate-limit, and error services as the control listener.

Creating or changing a gateway probes the requested port before activation. At process start and after gateway mutations, the listener manager reconciles desired and active listeners. A conflicting or failed gateway is recorded as `conflict` or `error`; the control server and other gateways remain available.

Operational checks:

1. Inspect `GET /v1/admin/gateways` from an administrator session.
2. Verify every enabled port is within 5300–5319 and has a recorded bind state.
3. Test the same principal through the control listener and gateway. The gateway result must be an equal or smaller silo set.
4. Occupy a proposed port, reconcile, and verify the conflict appears without affecting `/health` or `/ready` on the control listener.
5. Never place a reverse proxy in front of a gateway that bypasses NodeRag authentication.

## MCP contract

`POST /mcp` implements JSON-RPC 2.0 initialization, ping, tool discovery, and tool invocation. The supported tools are:

- `search_documents`
- `get_chunk_context`
- `get_document_page`
- `list_silos`

Tool arguments are strictly validated. Model-supplied silo IDs are treated only as a requested subset and are intersected with server-resolved scope. Tool results use the same retrieval/context functions as REST and return both MCP content and structured content where applicable. Expected tool failures are represented with `isError`; protocol errors use JSON-RPC error objects. Raw queries are not written to the audit log.

## Audit and diagnostics

Search audit events store principal, request ID, gateway, query SHA-256, query length, mode, filters, effective silo IDs, hit count, latency, and outcome. They never store raw search text. Audit reads are administrator-only.

The M08 database diagnostic uses eight silos and 8,500 chunks, with 5,000 chunks in the target silo. It alternates 160 RLS-on/off samples after warmup. Each sample averages ten PostgreSQL-reported `EXPLAIN ANALYZE` execution times so runner/network scheduling is not mistaken for RLS cost. The gate also requires the plan to retain both the target partition and HNSW index. The accepted result was:

| Gate                      |    Result | Threshold |
| ------------------------- | --------: | --------: |
| RLS-on p95                | 0.2018 ms |  Recorded |
| RLS-off p95               | 0.1970 ms |  Recorded |
| RLS overhead              |     2.44% |      ≤15% |
| Scoped partition retained |       Yes |  Required |
| HNSW index retained       |       Yes |  Required |
| ANN Recall@10             |      0.90 |     ≥0.90 |

The decision is to keep chunk RLS. See `docs/Implementation/decisions/m08-rls-decision.md`. Runtime diagnostics are stored in `noderag.retrieval_diagnostic` and are visible through the administration evaluation endpoint.

## Evaluation format

Golden cases use a stable external case ID, silo slug, natural-language query, and one or more relevant document paths with optional zero-based page ordinals. Chunk IDs are deliberately excluded because rechunking must not invalidate relevance judgments. The machine-readable schema is `docs/Implementation/evaluation/m08-golden-set.schema.json`.

Evaluation reports case count, Recall@10, MRR, nDCG@10, zero-result rate, p50/p95 latency, and breakdowns by silo and returned format. A queued evaluation run records its retrieval mode and `document-page` relevance unit.

## Packaged testbed smoke procedure

Run these gates from a clean checkout with Docker available:

```text
pnpm install --frozen-lockfile
pnpm ci:quality
pnpm test:integration
pnpm package:thin
pnpm package:thin
pnpm package:verify
pnpm repo:check
```

The two package checksums must match. Package verification unpacks the SPK and runs the non-root lifecycle simulator. M08 evidence is Docker/testbed evidence only; it does not close any live DSM register item.

## Failure triage

- `active_build_missing`: activate a valid build/model manifest before search or raw embedding.
- `query_too_long` or `input_too_long`: reduce the input; the server does not silently truncate retrieval input.
- `invalid_cursor`: restart pagination using the original query and filters.
- `markdown_integrity_failed` or `original_integrity_failed`: quarantine the artifact, inspect storage health, and reingest from a trusted source.
- Gateway `conflict`: choose another free static-range port and reconcile; do not widen the range dynamically.
- Low ANN recall: increase `ef_search`, rerun the exact comparison, and record the new diagnostic before accepting the setting.
- RLS overhead above 15% or loss of partition/HNSW plan: do not waive the gate; reopen the RLS decision and implement the documented metadata-RLS plus mandatory partition-scope fallback.
