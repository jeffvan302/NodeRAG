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
