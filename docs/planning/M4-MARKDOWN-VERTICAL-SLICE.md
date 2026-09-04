# Milestone 4 — Markdown Vertical Slice Record

Status: testbed-complete

Recorded: 2026-09-04

Evidence environment: Windows/WSL 2, Docker Desktop, production q8 model probe, and Linux package simulation; not DSM

Certification ceiling: `testbed-complete`

## Outcome

Milestone 4 proves the first complete NodeRag content path: an authorized user streams a Markdown upload, NodeRag durably stores its original, creates one canonical Markdown source of truth, resumes extraction and embedding from PostgreSQL jobs, stores cached vectors and exact provenance in the silo partition, and returns a permitted passage with independently reproducible UTF-16 and UTF-8 locators.

This is intentionally the narrow vertical slice specified by the staged plan. It supports direct Markdown upload and vector search, not TXT/PDF/DOCX/XLSX extraction, watched sources, hybrid ranking, broad retrieval endpoints, production deletion, or the final self-contained model package. Those capabilities remain owned by later milestones.

## Migration and authoritative data placement

Forward-only migration `000003_markdown_slice` has SHA-256 `abcf51a9108f16d6b1547abdfd0c7f45dfbc425c46b9d26e966a6dc550051dd0` and advances the expected head to `000003_markdown_slice`. It creates one-active-build and one-live-document-job guards, seeds the initial active build from the M03 settings/model manifest, and attaches every existing silo to that build.

Canonical Markdown remains a managed file rather than a second full-text database copy. The data-placement contract is:

| Item                                                                | Authoritative location                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Uploaded bytes                                                      | `documents/<bucket>/<document-id>/original.md`                        |
| Canonical LF/NFC text                                               | `documents/<bucket>/<document-id>/canonical.md`                       |
| Original/canonical SHA-256, sizes, normalization, state             | `noderag.document`                                                    |
| Page/document UTF-16 and UTF-8 boundaries                           | `noderag.document_page`                                               |
| Passage text, vector, locators, heading path, build/hash provenance | silo-partitioned `noderag.chunk`                                      |
| Reusable vector                                                     | `noderag.embedding_cache` keyed by exact embedded-text hash and model |

The embed stage rereads `canonical.md` and compares its SHA-256 with the document row before chunking. This preserves the staged plan's rule that PostgreSQL carries hashes, bounds, identities, and provenance while the managed canonical file remains the source of truth.

## Streaming upload and durable write order

`POST /v1/documents?siloId=<id>` authenticates first, verifies operational readiness, applies Origin/CSRF to browser credentials, resolves exact upload scope, and requires an idempotency key before accepting the file. `@fastify/multipart` 10.1.1 supplies the stream and enforces one file, no form fields, and the byte ceiling. NodeRag never calls a helper that buffers the entire upload.

The storage sequence is:

1. Verify free space for the configured maximum plus reserve.
2. Stream to a private random temporary file while counting bytes and updating SHA-256.
3. Reject empty/excess input and fsync the completed temporary file.
4. Allocate the PostgreSQL document sequence ID inside the idempotent operation.
5. Create the document-ID directory and atomically rename the temporary file to `original.md`.
6. Fsync the containing directory on Linux before inserting the authoritative document and job rows.
7. Commit document, queued extract job/event, upload audit metadata, and idempotency outcome together.

The default direct-upload ceiling is 2 GiB minus one byte and can be lowered by the caller constructing the route. The single-byte reservation keeps every canonical locator inside the schema's signed PostgreSQL `integer` range. Tests use a small ceiling. Extension is strictly `.md`; accepted media types are `text/markdown` and `text/plain`. Filenames must be basenames and cannot contain a NUL. The same key and digest returns the existing document/job with an explicit replay header; a changed digest under the key returns 409.

## Canonicalization and locator invariants

The extract job verifies the managed original against its recorded SHA-256, then decodes UTF-8 with fatal error handling. It removes one UTF-8 BOM, converts CRLF and lone CR to LF, applies Unicode NFC, and records whether each transformation occurred. `offsets_match_original` is true only when the final canonical UTF-8 bytes are identical to the uploaded bytes.

`packages/shared/locator` creates one UTF-16-boundary-to-UTF-8-byte map for the canonical string. It rejects endpoints inside surrogate pairs. Every chunk range is minted through this producer, and the tests independently prove both of these equations:

```text
canonical.slice(characterStart, characterEnd) == passage
UTF8(canonical)[byteStart:byteEnd].decode() == passage
```

The Markdown page has ordinal zero and nullable page numbers because its page basis is `none`. Its end offsets cover the complete canonical file. Chunks keep nullable page fields but always contain both character and byte ranges.

## Chunk construction and exact embedding identity

The build profile drives a 2,000-character target, 300-character overlap, a proportional snap window, heading prefixes, token ceiling, and rules version. Heading paths are detected from Markdown without modifying the canonical text.

Candidate boundaries prefer paragraph, sentence, line, word, then a surrogate-safe hard cut. A small final remainder merges into the preceding chunk. The token guard asks the same embedder tokenizer that will perform inference and recursively splits an oversized candidate at safe boundaries. Passage text remains the exact canonical slice. Heading context exists only in `embeddingText`, and SHA-256 is calculated over exactly those UTF-8 bytes.

This distinction is important: retrieval can show a clean source passage without slicing, while cache identity and provenance still describe the precise model input.

## Private embedder process

The API and worker communicate with one private embedder service using 4-byte big-endian length-prefixed JSON frames. The decoder handles fragmented and coalesced frames and rejects payloads over 16 MiB. Request IDs correlate concurrent count/embed operations. Query requests use higher queue priority than document work.

The production runtime loads the pinned local tokenizer JSON with `@huggingface/tokenizers` and opens one `onnxruntime-node` session configured for sequential CPU execution, graph optimization, bounded intra-op threads, and one inter-op thread. There is no model download path. It supplies input IDs, attention mask, position IDs, and empty past-key/value tensors required by the Qwen ONNX export. It pools the last non-padding hidden state, converts float16 when required, requires exactly 1,024 finite values, and L2-normalizes the result.

A direct run against the testbed's pinned q8 Qwen3-Embedding-0.6B assets returned 13 tokens, 1,024 finite values, norm exactly 1 at recorded precision, and approximately 60 ms inference time on the development host. This is a functional test, not a portable performance claim and not DSM evidence.

The package simulator sets `NODERAG_TEST_EMBEDDER=1`, selecting a deterministic 1,024-dimensional word-hash implementation with the same protocol and token-limit behavior. That makes packaging reproducible and exercises every application seam without claiming that the M04 thin SPK contains the native runtime/model. The self-contained production model payload remains a later packaging milestone.

## Durable stages, restart, and cache reuse

The worker claims with `FOR UPDATE SKIP LOCKED`, durable attempt counts, priorities, leases, and database time. Database time avoids host/container clock skew when determining whether work is available, assigning leases, and scheduling retries. An expired lease is safely reclaimed. API and worker startup can both request migrations, so a PostgreSQL advisory lock serializes the complete manifest/migration/checksum operation. The integration suite starts two migration runners concurrently against a fresh database.

The two M04 stages are:

| Stage     | Durable effect                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `extract` | Verify original, normalize, fsync canonical, update metadata/bounds, queue `embed`, complete event                        |
| `embed`   | Chunk/token-guard, reuse/embed vectors, insert cache refs and silo chunks, mark ready, update build count, complete/audit |

Every terminal state and event is written with its data mutation. A simulated dead worker claims the duplicate document's extract job; the lease is expired; a restarted worker reclaims and completes both stages. The second document reuses all document embedding vectors and increments each cache reference to two.

M05 will extend this foundation with lease epochs/fencing, heartbeats, retry classes, SSE event delivery, fair document scheduling, integrity sweeps, missing-source behavior, and complete purge. M04 proves restart safety for the narrow slice without prematurely claiming those controls.

## Scoped vector search and audit privacy

`POST /v1/search` authenticates, checks read readiness, validates and narrows requested silo IDs through `SiloScope`, and returns immediately for a zero-grant scope before spending embedding work. It applies the active build's query instruction prefix, obtains a high-priority vector, sets `hnsw.ef_search`, and runs cosine distance only within the authorized silo IDs and active build under transaction-local RLS.

Each result includes chunk/document/silo identity, source name/title, score, passage, heading path, page basis/range, UTF-16 range, UTF-8 range, and `offsetsMatchOriginal`. The integration test slices the canonical file independently in both units. A zero-grant user gets an empty response and does not trigger a query embedding.

Search audit stores the normalized query's SHA-256, result count, request ID, mode, and silo count. It does not store the raw query. Upload/index audit similarly records identifiers, byte or row counts, and safe format/build metadata only.

## Production bundle and unpacked-SPK exercise

The production build now emits API, worker, and embedder bundles. The DSM lifecycle script starts embedder, then API, then worker; service status requires all three. Stop/restart terminates all three PID-tracked processes and removes the socket. Setup creates the package data/run/log/secret directories with private permissions.

The verifier unpacks the SPK and checks metadata, JSON, shell syntax, both historical/current OpenAPI documents, all three migrations, and all three bundles. It then creates a private Docker network and digest-pinned PostgreSQL 17/pgvector service. A non-root, read-only Node container installs the unpacked package into simulated DSM paths and performs:

1. idempotent post-install and root-key persistence checks;
2. three-process start and health/status checks;
3. one-time setup-token consumption and administrator login;
4. BOM/CRLF Markdown upload;
5. durable worker polling through vector search;
6. canonical file and dual-locator verification;
7. full service restart followed by persisted authenticated search;
8. retained uninstall and explicit destructive uninstall checks.

The installed-package migration path uncovered a packaging-only defect during development: manifest entries are repository-relative, but installed migrations live directly under the package migration directory. Verification now uses immutable repository paths in development and the explicit package directory at runtime. Repeated lifecycle runs also exposed the API/worker migration-start race; the advisory lock removed it, and three consecutive unpacked-SPK simulations passed afterward.

## Dependency and security decisions

The upload parser is pinned to `@fastify/multipart` 10.1.1, which is the reviewed fixed version for the known upload-abort resource-exhaustion advisory affecting earlier releases.

The first implementation used the broad `@huggingface/transformers` package only for tokenization. The license gate correctly revealed that it also pulled image-processing/native packages, including an LGPL-bearing platform bundle irrelevant to text embeddings. M04 replaced it with zero-dependency `@huggingface/tokenizers` 0.1.3. Direct runtime components and ONNX/model notices are recorded in `THIRD-PARTY.md`; the thin M04 package does not redistribute the external native/model assets.

Setup token files are atomically created as regular non-symlink mode-0600 files, contain the only plaintext copy, and are removed after configuration. PostgreSQL stores only the token SHA-256.

## Tests and reproducible facts

The local gate runs frozen dependency checks, peer validation, migration checksums, strict TypeScript, ESLint, Prettier, dependency boundaries, unit tests, production builds, bundle smoke, license policy, secret scanning, repository hygiene, PostgreSQL/pgvector integration, repeat package construction, archive verification, and non-root package lifecycle simulation.

Current deterministic outputs after the final local implementation are:

| Artifact                      | Value                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| Dependency lock SHA-256       | `c299069355f2b314dd67b1607b196847b9cd701bcc6a319b2ac0adee7f8ed9c7` |
| Migration 000003 SHA-256      | `abcf51a9108f16d6b1547abdfd0c7f45dfbc425c46b9d26e966a6dc550051dd0` |
| M04 OpenAPI SHA-256           | `0684c52dc2499b0bc69c2d88087ee1b23e2d8957f0a4b01d56f5c0ff873457af` |
| Thin SPK bytes                | `1,116,160`                                                        |
| Thin SPK SHA-256 (two builds) | `04cb0b13c66d9f5ed6f179ccecfd1b3a126d075245066a00885125cdb5ed4b85` |
| Server bundle SHA-256         | `0e5c0fd9eedb5a01b6d10f3475a6a390fb97d00b401cfabdb1efb3edc7ea1edb` |
| Worker bundle SHA-256         | `e1af3cd683b2474e37c3a8469162c521905f7aadca0b37920cec40b716086ad1` |
| Embedder bundle SHA-256       | `a89f97a3e10b8e6315f240b1d450ca7d6fcb74a23a45fbc2a0bf135a3dcc88d2` |

The M04 GitHub workflow separates repository quality, the cumulative PostgreSQL/identity/Markdown integration suite, M01 Linux compatibility including real ONNX, and deterministic end-to-end thin-SPK verification. The M03 workflow is retained as a manually runnable historical workflow so later changes cannot rewrite its milestone evidence.

## Deferred DSM and later-milestone work

M04 does not close DSM package-user ABI, ONNX native loading, socket ACL, reverse-proxy Origin/cookie, filesystem fsync, Package Center upgrade, or live restart rows. Those remain in `docs/Implementation/dsm-deferred-register.md` and the final DSM certification after M14.

The following are deliberately deferred:

- M05: complete durable job controls, watched sources, integrity sweep, locator sweep, missing/restored states, and purge;
- M06–M08: TXT/PDF/DOCX/XLSX and vision extraction;
- M09: full retrieval, keyword/hybrid ranking, filters, context, and MCP/gateway surfaces;
- M10: production UI and a complete native/model-bearing SPK;
- M11–M14: rebuilds, evaluation, recovery/security, soak, and immutable release candidate;
- final DSM certification: exact tagged candidate on the user's Synology device.

## Gate state

All local M04 gates pass. The exact implementation and proof-closure commits
also pass all four GitHub jobs. The final certification commit is subject to the
same workflow before annotated tag `m04-complete` is pushed and verified.
