# M07 Vision Operations

NodeRag keeps vision disabled in practice until the system-wide endpoint and model pass a live activation test. The activation test first discovers the configured model through Ollama `/api/tags`, then sends the built-in table image through `/api/chat` with the exact versioned JSON schema used by ingestion. Settings are changed only after both calls succeed.

The sample is a small deterministic PNG generated and retained by the server module itself. It is
not loaded from a fixture path at request time, so provider activation behaves the same from a
source checkout, a production bundle, a package, or any working directory. Unit coverage verifies
its PNG signature, deterministic bytes, and copy isolation; the integration activation route sends
those same bytes to the mocked provider.

## Supported endpoint patterns

- The setup default is the full Ollama Cloud chat endpoint, `https://ollama.com/api/chat`.
  Direct cloud access requires an Ollama API key sent as a bearer token and sends sample and
  document images outside the local network. Provider charges may apply.
- The address field accepts a host root, an `/api` base, or the full `/api/chat` endpoint. NodeRag
  derives the sibling `/api/tags` discovery endpoint without duplicating path segments.
- NodeRag uses Ollama's native REST image shape: the user message contains an `images` array whose
  items are the raw PNG bytes encoded as base64, without a `data:image/...` prefix. Ollama's separate
  OpenAI-compatible `/v1/chat/completions` endpoint instead uses `content` parts with an
  `image_url` data URL; that is not the contract selected by an `/api/chat` address.
- A self-hosted Ollama endpoint can be used without a token.
- Ollama Cloud and authenticated reverse proxies can use a bearer token. A token submitted to the
  activation API is encrypted with the NodeRag secret root; the plaintext is never returned.
- A runtime-managed token may instead be supplied with `NODERAG_OLLAMA_BEARER_TOKEN_FILE`. `NODERAG_OLLAMA_BEARER_TOKEN` is also accepted for controlled test environments.
- Ollama Cloud currently does not enforce the native API's `format` schema. For the canonical
  cloud host, NodeRag puts the exact schema in the prompt, omits the unsupported `format` field,
  disables optional thinking, and still rejects any response that fails strict local schema
  validation. The parser accepts a single JSON object either bare or inside the narrow JSON-fence
  forms emitted by Ollama Cloud; explanatory prose and invalid objects remain rejected. The
  provider is usable only if the live table-image activation succeeds.
- HTTPS is expected for non-loopback routes. Plain HTTP outside localhost produces `ollama-plaintext-non-loopback`.

The package service already supplies `NODERAG_SECRET_ROOT`. A standalone deployment defaults it to `<data-root>/secrets/root.key`. The file is created with private permissions and must be retained with the database; losing it makes encrypted provider credentials unreadable.

## Activation contract

`POST /v1/admin/vision/test` requires a server administrator, browser CSRF validation, and an `Idempotency-Key`. Its body accepts:

```json
{
  "baseUrl": "https://ollama.com/api/chat",
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

The administrator screen exposes the same activation contract as an explained form. It shows the
current provider and queue status; permits editing the address, model, `maximumParallel` (1–16),
timeout, attempts, and image-size cap; and accepts an optional replacement API key in a masked
field. A blank key keeps the existing encrypted credential. The status response reports only
whether a vault credential is configured and never returns its plaintext.

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
