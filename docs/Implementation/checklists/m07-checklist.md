# M07 — Vision and Bad-PDF Recovery Checklist

Status: testbed-complete

Environment: WSL/Docker testbed, PostgreSQL 17/pgvector containers, and non-root Linux package simulation

Recorded: 2026-09-04

## Provider contract and activation

- [x] `VisionProvider` has an explicit `vision-provider.v1` capability version and a typed request/response boundary.
- [x] The response schema is versioned, strict, and limited to `kind`, `markdown`, `alt`, and bounded `confidence`.
- [x] Allowed kinds are table, chart, diagram, screenshot, photo, formula, logo, and decorative.
- [x] Ollama discovery validates `/api/tags`; a missing model fails with a permanent, stable code.
- [x] Ollama transcription uses `/api/chat`, base64 image input, `stream=false`, JSON Schema format, temperature 0, configured context, and keep-alive.
- [x] Nested `message.content` JSON is parsed and Zod-validated; malformed JSON, omitted fields, and extra fields are rejected.
- [x] Activation requires both discovery and a bundled table-image structured-output test before settings are changed.
- [x] Self-hosted endpoints need no token; reverse proxies can use a bearer token encrypted by the existing secret vault.
- [x] A non-loopback plaintext HTTP endpoint returns an explicit security warning.
- [x] Cloud behavior is capability-tested rather than assumed; an endpoint that cannot return the required structured result remains inactive.

## Preprocessing, provenance, and PDF recovery

- [x] Original image SHA-256 is retained independently from the normalized PNG SHA-256.
- [x] Images are decoded locally and downscaled to the configured maximum dimension with high-quality interpolation.
- [x] Images below 64×64, over 20:1 aspect ratio, or below the low-entropy threshold are skipped with a stable reason.
- [x] Accepted Markdown is inserted at the image/page position inside invisible provenance comments.
- [x] Provenance records image digest, page when present, kind, provider, model, and provider/model/prompt/schema/preprocessing revisions.
- [x] Low-confidence accepted output remains searchable but produces a visible extraction warning.
- [x] Bad or scan-only PDF pages render to PNG at 2× PDF scale and pass through the identical provider interface.
- [x] PDF page extraction is `vision` or `mixed` based on whether trustworthy native text was retained.
- [x] The deterministic fake provider derives stable content from the preprocessed image hash.

## Cache, dispatch, and concurrency

- [x] The global cache identity includes original/preprocessed digests, provider/model identity, and every invalidation revision.
- [x] The cache contains no silo or document membership fields; document membership remains only in silo-scoped image rows.
- [x] A durable dispatch row is committed before each outbound provider call.
- [x] A validated result and its dispatch settlement are committed together immediately after the call.
- [x] Failed dispatches retain a stable error code and settlement time for operator inspection.
- [x] Duplicate image content reuses one validated provider result.
- [x] Changing the model revision creates a cache miss; prompt/schema/preprocessing revisions participate in the same key.
- [x] Provider calls use bounded timeout, exponential backoff, and maximum attempts.
- [x] A local fair semaphore bounds concurrent calls within a process.
- [x] PostgreSQL advisory slots enforce the configured maximum across worker processes, capped by the declared provider capacity.

## Durable ingestion and recovery

- [x] Managed original image bytes/page renders are written under the document directory and referenced by relative managed paths.
- [x] Image rows persist state, media, dimensions, both digests, cache identity, output, confidence, revisions, and last error.
- [x] Provider loss writes an alt-text placeholder, records `pending_vision`, and schedules a durable vision job.
- [x] Text-bearing documents still complete canonical assembly and embedding while vision is pending.
- [x] A terminal vision retry never changes the document to generic `failed`; it remains `awaiting_vision` for manual recovery.
- [x] Manual retry safely reactivates the one live vision job for the selected document/silo.
- [x] Successful recovery replaces placeholders, decrements old cache/vector references, removes stale chunks, and re-embeds the updated Markdown.
- [x] Vision cache reference accounting participates in integrity checks and destructive document/silo purge.
- [x] The migration is forward-only, checksum-pinned, and advances the expected head to `000005_vision_recovery`.

## Administration, contracts, and tests

- [x] Admin status reports settings, analysed/pending/failed/skipped counts, open/failed dispatches, projected calls, and estimated elapsed time.
- [x] Per-document estimation is silo-authorized and warns when a scan reaches 400 pages.
- [x] Manual test/activation and retry require server administration, browser CSRF, and idempotency keys.
- [x] `platform/openapi.m07.json` and the authorization inventory contain the M07 routes.
- [x] Unit tests cover strict schema behavior, malformed output, model missing, rate limit, timeout, preprocessing skips/downscale, cache reuse/invalidation, and concurrency.
- [x] PostgreSQL integration covers scanned-PDF searchability, encrypted reverse-proxy activation, offline text ingestion, durable retry, low confidence, dispatch history, and 400-page warnings.
- [x] The opt-in real-provider suite exists outside normal CI and requires explicit endpoint/model credentials.
- [x] The complete M01–M07 local integration regression suite passes.

## Production bundle, package, and evidence

- [x] `@napi-rs/canvas@1.0.8` and the Linux x64 GNU native binary are pinned and documented as bundled MIT components.
- [x] Cross-platform pnpm installation retains the Windows development binary and Linux x64 GNU package payload.
- [x] The Linux x64 GNU renderer loads and creates a PNG inside the Docker testbed.
- [x] The production server/worker bundles build and the server smoke test passes.
- [x] The thin SPK includes migration 000005, M07 OpenAPI, activation fixture, renderer JavaScript, and Linux native binary.
- [x] Non-root thin-SPK lifecycle simulation passes.
- [x] Two local SPK builds are byte-identical at 16,168,960 bytes with SHA-256 `6aa0e52cb5b0f724ea1965361a85459386567376ecdae515c530c5aaa76fdcfe`; these values will be frozen into `m07-proof.json` after the implementation commit exists.
- [x] Frozen install, migrations, TypeScript, lint, formatting, boundaries, units, production build/smoke, licenses, secrets, and repository hygiene pass locally.
- [x] Implementation commit `d91e6f8d81ea00ab56bd7ec28907c65d35defaa2` is pushed to `main`; M07 run `33874353464` passed quality, vision integration, Linux compatibility, and deterministic thin-SPK jobs.
- [x] Proof-closure commit `2d6510b258ff5e461e1f0c1cd43063846d675dc6` passes every required M07 GitHub job.
- [x] The final certification commit passes every required M07 GitHub job, and annotated tag `m07-complete` resolves remotely to that commit.

## Honest limitations and DSM deferral

- [x] The live Ollama suite is opt-in and is not represented as passed without an explicitly configured real endpoint/model.
- [x] Final endpoint routing/authentication, package-identity network access, native renderer ABI, scan performance, memory, thermals, and retry behavior remain in the DSM register.
- [x] No Docker, WSL, mocked-provider, static archive, or package-simulator result is represented as live DSM evidence.

M08 is authorized. No M07 testbed result closes a live DSM register row.
