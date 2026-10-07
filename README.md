# NodeRag

NodeRag is a private, local-first retrieval system designed to ship as one
Synology DSM package. Development and milestone certification run in WSL 2 and
Docker until the immutable release candidate is ready for final DSM testing.

## Development prerequisites

- Windows 11 with WSL 2 or a Linux workstation
- Docker Desktop or a compatible Linux Docker Engine
- Node.js 22 (`>=22.13 <23`)
- Corepack with the repository-pinned pnpm release

Bootstrap the database and install dependencies:

```bash
bash docker-testbed/scripts/bootstrap.sh
bash docker-testbed/scripts/up.sh
corepack pnpm@11.25.0 install --frozen-lockfile
corepack pnpm@11.25.0 dev
```

The development command starts the Fastify API, durable ingestion worker,
private framed embedder, and Preact/Vite UI. For the real local Qwen runtime,
set `NODERAG_MODEL_ROOT` to the directory containing `tokenizer.json` and
`tokenizer_config.json`, and set `NODERAG_MODEL_PATH` to the pinned ONNX model.
Use `NODERAG_TEST_EMBEDDER=1` only in automated tests and package simulation.
Real-Qwen retrieval rejects cosine matches below the provisional calibrated
`NODERAG_VECTOR_MINIMUM_SIMILARITY` value (`0.30` by default) and maps accepted
matches against `NODERAG_VECTOR_HIGH_CONFIDENCE_SIMILARITY` (`0.70` by default)
for the UI's match-confidence display. Override either value only after a
versioned evaluation run for the exact model and corpus profile.
The database secret remains in the ignored
`docker-testbed/.secrets/` directory and is read from that file rather than
printed or copied into an environment file.

## Markdown upload and search

Milestone 4 implements the first complete content path. An authorized browser
can stream one `.md` file to `POST /v1/documents?siloId=<id>` with Origin, CSRF,
and `Idempotency-Key` headers. NodeRag stores and fsyncs the managed original,
normalizes a canonical LF/NFC Markdown copy, resumes work through PostgreSQL
jobs, creates cached 1,024-dimensional embeddings, and returns authorized
passages from `POST /v1/search` with exact UTF-16 and UTF-8 locators.

The thin SPK remains a testbed package at this milestone. It contains the API,
worker, and deterministic package-simulation embedder, but not the production
Qwen model or ONNX native runtime; the fully self-contained production SPK is a
later packaging milestone.

## First-time setup and identity

After migrations, NodeRag starts in the `unconfigured` readiness state. A
single-use setup token creates the first server administrator and a default
silo; only then does readiness become `operational`. Passwords use Argon2id,
browser sessions are stored as SHA-256 hashes, and browser mutations require
both the session CSRF value and the configured Origin. Persistent mutations
also require an `Idempotency-Key` unless the route inventory explicitly records
a narrow exception.

Silo access is deliberately split into independent `read`, `upload`, and
`delete` grants. API keys are shown once, stored only as SHA-256 digests, and can
be constrained by expiry, source CIDR, request rate, silo grants, and a
search-only flag. The machine-readable authorization contract is
`platform/route-authorization.v1.json`; the authenticated API contract is
available at `/v1/openapi.json`.

## Quality gates

```bash
corepack pnpm@11.25.0 ci:quality
corepack pnpm@11.25.0 test:integration
corepack pnpm@11.25.0 package:thin
corepack pnpm@11.25.0 package:verify
```

Docker evidence is labeled `testbed-complete`. It is not evidence that a build
runs on DSM; the final live checks remain in
`docs/Implementation/dsm-deferred-register.md`.
