# M04 — Markdown Vertical Slice Checklist

Status: implementation-complete-ci-pending

Environment: WSL/Docker testbed, native Windows model probe, and Linux package simulation

Recorded: 2026-09-04

## Migration and canonical storage

- [x] Forward-only migration `000003_markdown_slice` is the expected migration head and has an exact SHA-256 in the migration manifest.
- [x] The migration seeds one active build from the pinned settings/model manifest and adds active-build and live-document-job uniqueness guards.
- [x] Existing silos receive an active `silo_build_state` without inventing a second build.
- [x] Managed originals use `documents/<bucket>/<document-id>/original.md`; canonical text uses `canonical.md` in the same package-managed document directory.
- [x] PostgreSQL stores document/page boundaries, hashes, state, provenance, and managed relative paths, not a duplicate canonical Markdown body.
- [x] Original and canonical writes use private files, fsync the file before promotion, atomically rename, and fsync the containing directory on Linux.
- [x] The embed stage reads canonical Markdown from the managed file and rejects a file whose SHA-256 differs from the authoritative document row.

## Streaming upload and normalization

- [x] `POST /v1/documents?siloId=<id>` requires authentication, exact upload scope, operational readiness, browser Origin/CSRF, and `Idempotency-Key`.
- [x] Multipart input is streamed directly to a temporary file while counting bytes and calculating SHA-256; the route does not buffer the whole document.
- [x] Disk reserve is checked before consuming the stream, and the default direct-upload ceiling is the PostgreSQL signed-integer-safe 2 GiB minus one byte with a downward test/configuration hook.
- [x] Empty uploads, invalid filenames, traversal-shaped names, non-`.md` extensions, unsupported MIME types, excess bytes, and insufficient space fail closed.
- [x] The same key and request digest returns the original document/job; the same key with different input returns conflict.
- [x] The document ID is allocated before promotion so the original is written directly to its final document-ID layout.
- [x] UTF-8 is decoded fatally, the UTF-8 BOM is removed, CRLF and lone CR become LF, and Unicode becomes NFC.
- [x] `offsets_match_original` is true only when the canonical UTF-8 bytes are byte-for-byte equal to the original upload.
- [x] Normalization decisions, byte/character counts, hashes, encoding, confidence, and version are durably recorded.

## Locator and chunk contract

- [x] `packages/shared/locator` is the only producer of canonical UTF-16/UTF-8 offset pairs.
- [x] One pass maps every valid UTF-16 boundary to the corresponding UTF-8 byte position.
- [x] A locator cannot begin or end inside a surrogate pair, and both slicing methods reproduce the same text.
- [x] Markdown headings are detected without reformatting the canonical file, and heading ancestry is recorded per chunk.
- [x] Boundary selection uses paragraph, sentence, line, word, and surrogate-safe hard-cut priority.
- [x] The system profile applies the planned 2,000-character target, 300-character overlap, snap window, and final-runt merge.
- [x] Token guard recursively splits an over-limit candidate at safe whitespace/surrogate boundaries before embedding.
- [x] Heading context is prefixed only to embedding input; returned passage text remains an exact canonical Markdown slice.
- [x] `chunk_sha256` hashes exactly the prefixed bytes sent to the document embedder.

## Embedder and cache

- [x] The private protocol is length-prefixed JSON with a 16 MiB frame ceiling, fragmentation/coalescing support, request IDs, token counting, and embedding operations.
- [x] The Unix socket is package-private and mode 0600; the Windows development path uses a named pipe.
- [x] One long-lived runtime owns one sequential CPU ONNX session with explicit thread counts and no network model download.
- [x] The standalone Hugging Face tokenizer loads only local `tokenizer.json` and `tokenizer_config.json` files.
- [x] Query input receives the pinned instruction prefix; document chunks remain unprefixed except for the configured heading context.
- [x] Inference uses last non-padding token pooling and L2 normalization, and rejects a vector that is not finite and exactly 1,024 dimensions.
- [x] A direct testbed run of the production q8 runtime returned 1,024 finite values with norm 1 using the pinned model assets.
- [x] The test-only deterministic runtime is activated only by `NODERAG_TEST_EMBEDDER=1` and preserves the same dimensions and token-limit contract.
- [x] Embedding cache identity includes exact embedded-text SHA-256 plus model manifest, with transactional reference increments.
- [x] Uploading the same canonical content under a new idempotency key reuses every cached document vector.

## Durable worker and scoped search

- [x] Upload commits an extract job and initial event with the authoritative document row.
- [x] Extract verifies the original hash, writes canonical Markdown, records the page boundary, and queues embed work transactionally.
- [x] Embed inserts cache references, complete chunk provenance, vector data, ready state, build counts, terminal job state, and audit metadata transactionally.
- [x] Claims use database time, `FOR UPDATE SKIP LOCKED`, priorities, attempts, leases, and append-only events.
- [x] API and worker startup migrations are serialized by a PostgreSQL advisory lock and a fresh-database concurrency test.
- [x] An expired lease is reclaimed and completed by a restarted worker without creating another logical document job.
- [x] `POST /v1/search` resolves a narrowing-only `SiloScope` before embedding the query and sets RLS scope locally for vector retrieval.
- [x] A zero-grant principal gets an empty result without invoking the embedder; unauthenticated upload is rejected.
- [x] Search returns the passage, document identity, score, heading path, page basis/range, UTF-16 range, UTF-8 range, and original-offset compatibility.
- [x] Search audit stores normalized query SHA-256 and safe counts only; raw query text is absent.

## Production bundle and package simulation

- [x] The production build emits separate `server.cjs`, `worker.cjs`, and `embedder.cjs` entry points.
- [x] Package lifecycle starts the private embedder, API, and worker; status requires all three; stop/restart settles all three and removes the socket.
- [x] Installed-package migration verification resolves migration files from the package path while repository verification retains immutable repository-relative paths.
- [x] The thin SPK verifier requires migration 000003, M03 and M04 OpenAPI contracts, and all three process bundles.
- [x] Package simulation creates a private digest-pinned pgvector service and runs the SPK as non-root with a read-only root filesystem.
- [x] The simulator consumes the one-time setup token, logs in, uploads BOM/CRLF Markdown, waits for durable indexing, searches, and validates both locator units.
- [x] Full API/worker/embedder restart preserves the session, database state, managed Markdown, and vector search result.
- [x] Retained and destructive uninstall behavior still passes after the M04 service expansion.
- [x] Two independent thin-package builds produced the same 1,116,160-byte SPK and SHA-256 `04cb0b13c66d9f5ed6f179ccecfd1b3a126d075245066a00885125cdb5ed4b85`.

## Quality and delivery

- [x] The multipart dependency is pinned at the reviewed fixed release `10.1.1` rather than a version affected by the upload-abort denial-of-service advisory.
- [x] The embedder uses standalone `@huggingface/tokenizers` instead of pulling unused image-processing/native dependencies from the broad Transformers package.
- [x] Runtime dependency licenses pass the permissive allowlist and direct components are recorded in `THIRD-PARTY.md`.
- [x] Migration verification, strict TypeScript, ESLint, unit tests, production build, bundle smoke, license, secret scan, and repository hygiene pass locally.
- [x] The PostgreSQL/pgvector integration suite passes upload, identity, RLS, normalization, restart, cache, locator, and search behavior.
- [x] The deterministic thin SPK build and non-root end-to-end package lifecycle pass locally.
- [x] The implementation commit is pushed to `main` and all four M04 GitHub Actions jobs succeed.
- [x] `m04-proof.json` records the exact implementation workflow and successful job IDs.
- [ ] The proof-closure and final certification commits pass M04 CI, and annotated tag `m04-complete` resolves to the certification commit remotely.

M05 remains unauthorized until the three remote-delivery items above are complete.
No M04 testbed result closes a live DSM register row.
