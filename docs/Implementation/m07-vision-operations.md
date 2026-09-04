# M07 Vision Operations

NodeRag keeps vision disabled in practice until the system-wide endpoint and model pass a live activation test. The activation test first discovers the configured model through Ollama `/api/tags`, then sends the bundled table image through `/api/chat` with the exact versioned JSON schema used by ingestion. Settings are changed only after both calls succeed.

## Supported endpoint patterns

- A self-hosted Ollama endpoint can be used without a token.
- An authenticated reverse proxy can use a bearer token. A token submitted to the activation API is encrypted with the NodeRag secret root; the plaintext is never returned.
- A runtime-managed token may instead be supplied with `NODERAG_OLLAMA_BEARER_TOKEN_FILE`. `NODERAG_OLLAMA_BEARER_TOKEN` is also accepted for controlled test environments.
- A cloud endpoint is not assumed to support structured output. It is usable only if the same live table-image activation succeeds.
- HTTPS is expected for non-loopback routes. Plain HTTP outside localhost produces `ollama-plaintext-non-loopback`.

The package service already supplies `NODERAG_SECRET_ROOT`. A standalone deployment defaults it to `<data-root>/secrets/root.key`. The file is created with private permissions and must be retained with the database; losing it makes encrypted provider credentials unreadable.

## Activation contract

`POST /v1/admin/vision/test` requires a server administrator, browser CSRF validation, and an `Idempotency-Key`. Its body accepts:

```json
{
  "baseUrl": "https://ollama.example.internal/",
  "model": "vision-model:latest",
  "bearerToken": "optional-secret",
  "maximumParallel": 2,
  "timeoutMs": 120000,
  "maximumAttempts": 3,
  "maximumImageDimension": 2048
}
```

The response reports the discovered model revision, validated sample, elapsed time, transport warning, and whether a submitted token was persisted. Never place a real token in a committed script, fixture, proof, or terminal transcript.

Set `NODERAG_OLLAMA_NUM_PARALLEL` to the provider's actual process-wide capacity when it is lower than the saved NodeRag value. NodeRag uses the lower value and coordinates worker processes with PostgreSQL advisory slots.

## Failure and recovery behavior

Text extraction is independent from provider availability. On a provider error, NodeRag writes an explicit pending placeholder, commits any available text, records the image as `pending_vision`, and schedules a durable vision job. Automatic retries use bounded exponential backoff. Exhaustion leaves the document `awaiting_vision`; it does not convert an otherwise usable document into a generic failure.

Use these endpoints to operate the queue:

- `GET /v1/admin/vision/status` — provider settings, result counts, dispatch counts, projected calls, elapsed estimate, and scan warnings.
- `GET /v1/documents/{id}/vision-estimate` — silo-authorized estimate for one document.
- `POST /v1/admin/vision/retry` — manually reactivates pending work globally or for a supplied `documentId`/`siloId`; requires CSRF and an idempotency key.

A successful retry rewrites canonical Markdown with invisible provenance, removes the document's stale chunks, corrects cache reference counts, and re-embeds the new content.

## Real-provider test outside normal CI

The deterministic provider covers normal unit and PostgreSQL integration testing. To run the opt-in real-provider suite:

```text
NODERAG_M07_OLLAMA_URL=<endpoint>
NODERAG_M07_OLLAMA_MODEL=<model>
NODERAG_M07_OLLAMA_BEARER_TOKEN=<optional-token>
pnpm test:vision-real
```

The test must report `status: passed`, a table activation result, and searchable scanned-PDF characters. It is external integration evidence, not DSM certification. Final DSM certification repeats the test from the installed package identity and additionally verifies native renderer ABI, routing, concurrency, interruption, retry, resource use, and thermals.
