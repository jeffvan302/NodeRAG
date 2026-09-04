# Milestone 2 — Repository Foundation and Thin SPK Record

Status: implementation CI passed; proof closure pending
Recorded: 2026-09-04
Evidence environment: Windows/WSL 2, Docker Desktop, and GitHub Actions; not DSM
Certification ceiling: `testbed-complete`

## Outcome

Milestone 2 turns the feasibility repository into an executable application
foundation. It adds an exact pnpm workspace, strict TypeScript boundaries, a
Fastify service and separate worker, a built Preact UI, a forward-only migration
contract, Testcontainers integration, and a deterministic thin DSM archive.

No step installs the archive through Package Center or runs it with a Synology
Node binary. Those assertions remain in the deferred DSM certification register.

## Pinned toolchain and dependencies

| Component | Pin | Purpose |
|---|---:|---|
| Node compatibility | `>=22.13 <23`; CI `22.22.0` | Matches the Node 22 testbed and future `Node.js_v22` dependency |
| pnpm | `11.25.0` | Exact workspace and lockfile manager through Corepack |
| TypeScript | `6.0.3` | Latest pinned release accepted by the current typed ESLint stack |
| Fastify | `5.12.1` | Schema-first HTTP service and injection tests |
| Preact / Vite | `10.29.8` / `8.2.2` | Static no-SSR browser application |
| PostgreSQL client / migrations | `pg` 8.23.0 / node-pg-migrate 9.0.0 | Direct SQL and programmatic forward migration runner |
| Vitest / Testcontainers | `4.1.11` / `11.14.0` | Unit and real PostgreSQL integration gates compatible with Node 22 |
| dependency-cruiser | `18.2.0` | Enforced one-direction module boundaries |
| esbuild | `0.28.2` | Bundled CommonJS server and worker outputs |
| sharp | `0.35.4` | Build-only deterministic SVG-to-PNG package icon rasterization |

pnpm 11 rejects unreviewed dependency lifecycle scripts by default. The
workspace explicitly permits only esbuild and sharp build behavior and denies
the optional cpu-features, protobufjs, and ssh2 scripts. `pnpm peers check`
reports no conflicts. The lockfile is the only dependency resolution input in
CI; its SHA-256 is
`9bc5840cc03149a0c33486511385263238089a9bc41321618fc67776e41ac30c`.

## Workspace and dependency boundaries

The workspace contains the three application packages from the architecture and
two interchangeable platform adapters:

```text
packages/shared    runtime contracts and Zod service schemas
packages/server    Fastify API, database migration/readiness, worker, build
packages/ui        Preact/Vite static application
adapters/local     workstation paths, process, and port behavior
adapters/dsm       explicit DSM path/process/resource contract
```

`dependency-cruiser` rejects cycles and unresolvable imports. Shared code cannot
reach an application or adapter; adapters cannot reach applications or one
another; UI cannot reach server or platform adapters. This gives later
milestones a checked direction rather than a convention.

TypeScript enables strict mode, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, and consistent casing.
Linting and formatting run from the same pinned lockfile on Windows and Linux.

## Service, UI, and logging skeleton

The Fastify application exposes:

- `GET /health`: process liveness and build version;
- `GET /ready`: fail-closed database/migration readiness;
- the compiled Preact UI and assets from the same service.

Every request receives or preserves a request ID. Structured logging redacts
authorization, cookies, response cookies, request bodies, passwords, hashes,
tokens, API keys, and database URLs. The production build generates bundled
CommonJS `server.cjs` and `worker.cjs`; the bundle smoke gate launches the actual
output and checks both `/health` and the compiled HTML.

The UI is intentionally a foundation page rather than a premature product
surface. It checks health, contains no SSR/build server requirement, and is
copied into the thin package.

## Migration contract and real database test

`platform/migration-checksums.v1.json` declares expected head
`000001_foundation` and SHA-256
`e9a9aa52c0c2462daad199c44414d27d93fcc515d60abd32b1eced9f157caa39`
for the only migration. Verification fails on an unlisted file, reordered or
duplicate ID, head drift, checksum drift, a down marker, or a non-up-only entry.

The migration creates pgvector, the `noderag` schema, a small system metadata
table, and an applied-checksum ledger. The programmatic runner uses an advisory
lock and a single transaction through node-pg-migrate, then records and verifies
the immutable checksums.

The integration test starts the same digest-pinned PostgreSQL 17/pgvector image
used by the testbed, applies the migration twice, obtains readiness `ok`, checks
the expected head and checksum ledger, confirms pgvector 0.8.6, and reads the M02
foundation marker. This is real PostgreSQL behavior, not a database mock.

## Thin package construction and lifecycle

The repository pins SynoCommunity spksrc as a shallow submodule at
`1f638f9f331d881b2fd5cb45bb24071e9f723400`, identical to the cross-build pin
from M1. `spk/noderag/Makefile` records the future production recipe boundary;
M10 owns the complete bundled PostgreSQL/pgvector package.

The Linux archive builder emits `noderag-0.2.0-1-x86_64.spk` with deterministic
ordering, timestamps, owner, and group. It contains:

- DSM INFO metadata and deterministic 72/256-pixel package icons;
- package-identity privilege configuration;
- data-share, one-port, reverse-proxy, and launcher UI resources;
- install UI, install/upgrade/uninstall hooks, and service controls;
- bundled server/worker, static UI, migration, and checksum manifest payloads.

Two independent builds produced the same 583,680-byte archive with SHA-256
`fe29a181c00f65969050be6973560a852d6be95c64e2f6cc726e9331419e6d3f`.
The bundled server and worker SHA-256 values are respectively
`c2f5103d9f30976d486df006546ff52b5112028abdc4510d1983996bd2fd6ad7`
and `47205c2b0de3b30faeff0c3fc19044c43058edb68070e6e236b380bb3377ec7f`.

The verifier rejects absolute/traversing archive paths and requires every
declared member. It parses JSON, checks INFO, validates shell syntax, and then
runs the extracted archive in the pinned Node 22 container as UID/GID 1000 with
a read-only root, no network, no Linux capabilities, and no-new-privileges.

The simulation passes install, mode 0700, start, health, status, restart, stop,
reboot-style stop/start, retained uninstall, and separately authorized
destructive uninstall. It does not establish Package Center acceptance,
Synology ABI compatibility, DSM ACL correctness, or DSM service integration.

## Reproducible commands

```bash
corepack pnpm@11.25.0 install --frozen-lockfile
corepack pnpm@11.25.0 ci:quality
corepack pnpm@11.25.0 test:integration
corepack pnpm@11.25.0 package:thin
corepack pnpm@11.25.0 package:verify
```

The M02 workflow runs the quality, Testcontainers integration, M1 Node/ONNX/
Argon2/database compatibility, and thin-SPK jobs independently on Ubuntu 24.04.
All actions, Node, pnpm, application dependencies, container images, spksrc, and
migration/model inputs are pinned.

## Deferred DSM mapping

M2 package checks map to the existing live rows without closing them:

| M2 evidence | Deferred live rows |
|---|---|
| Node 22 service bundle and adapter | DSM-002, DSM-006, DSM-007 |
| package identity and paths | DSM-003, DSM-009, DSM-010 |
| PostgreSQL/pgvector payload boundary | DSM-004, DSM-005 |
| port, proxy, launcher resources | DSM-011 |
| lifecycle and reboot simulation | DSM-012, DSM-013 |
| backup/upgrade continuity | DSM-016 |

## Gate state

The local application, database, and package gates pass. M2 becomes
`testbed-complete` only after the consolidated local gate passes, the exact
implementation commit succeeds in all GitHub jobs, the proof closure succeeds
again, and annotated tag `m02-complete` points to the final certification commit.
