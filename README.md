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

The development command starts the Fastify API, the worker skeleton, and the
Preact/Vite UI. The database secret remains in the ignored
`docker-testbed/.secrets/` directory and is read from that file rather than
printed or copied into an environment file.

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
