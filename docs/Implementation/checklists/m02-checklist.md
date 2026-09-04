# M02 — Repository Foundation, Development Stack, CI, and Thin SPK Checklist

Status: implementation CI passed; proof closure pending
Environment: Docker testbed and Linux package simulation
Recorded: 2026-09-04

## Repository and toolchain

- [x] Root ignore policy excludes dependencies, builds, models, private inputs, backups, vectors, secrets, runtime data, uploads, and package artifacts.
- [x] Linux/DSM source line endings are declared and repository scripts have an executable-mode gate.
- [x] The workspace pins Node 22 compatibility and exact pnpm 11.25.0 through Corepack and `packageManager`.
- [x] TypeScript strictness includes `noUncheckedIndexedAccess`, exact optional properties, and no implicit overrides.
- [x] ESLint, Prettier, Vitest, and dependency-cruiser are configured with one-directional package boundaries.
- [x] README, security policy, proprietary license, redistribution policy, and third-party notice process exist.

## Application and database skeleton

- [x] `packages/shared`, `packages/server`, and `packages/ui` build and typecheck.
- [x] Local and DSM platform adapters implement the same path, process, and resource interfaces.
- [x] Fastify exposes health and fail-closed readiness with structured logging, request IDs, and secret/body redaction.
- [x] Preact/Vite builds a static no-SSR page and the bundled Fastify server serves it.
- [x] The worker has a separate executable entry point.
- [x] PostgreSQL 17/pgvector remains the single Docker development database.
- [x] The forward-only migration manifest covers every SQL migration, pins each SHA-256, and declares expected head `000001_foundation`.
- [x] Testcontainers applies the migration twice, verifies the checksum ledger and readiness, and confirms pgvector 0.8.6.

## Thin DSM package simulation

- [x] SynoCommunity spksrc is a shallow submodule pinned to `1f638f9f331d881b2fd5cb45bb24071e9f723400`.
- [x] The thin package contains INFO, privilege/resource/port/web files, install UI, DSM launcher UI, deterministic icons, service bundle, worker bundle, UI, and migration assets.
- [x] The package declares `Node.js_v22`, x86-64, DSM 7.2 minimum, one loopback service port, and `run-as: package`.
- [x] Archive members reject unsafe paths and all metadata JSON/shell files pass static validation.
- [x] A non-root, read-only-root container passes install/start/health/status/stop/restart/reboot simulation and retained/destructive uninstall behavior.
- [x] Live Package Center, package-user ABI, ACL, port, web, lifecycle, reboot, and uninstall cases remain open in the deferred DSM register.

## Quality and delivery

- [x] Exact frozen install, migration, typecheck, lint, format, boundary, unit, build, smoke, license, secret, and repository-hygiene gates pass together.
- [x] PostgreSQL Testcontainers integration passes locally.
- [x] The thin SPK builds twice with the same SHA-256 and passes package simulation locally.
- [x] The implementation commit is pushed to `main` and every M02 GitHub Actions job succeeds.
- [x] `m02-proof.json` records the implementation commit and successful workflow jobs.
- [ ] The proof-closure commit is pushed and its own workflow succeeds.
- [ ] Annotated tag `m02-complete` resolves to the final certification commit.

M03 is authorized only after every item above is complete. `testbed-complete`
does not close a live DSM register row.
