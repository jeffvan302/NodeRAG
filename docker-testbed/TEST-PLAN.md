# Docker Testbed Plan

## Purpose

The NodeRag testbed is the primary execution environment for Milestones 0–14.
It must make every platform-independent behavior repeatable from a clean Git
checkout while keeping production secrets, documents, models, backups, and
runtime state out of the repository.

Completing a milestone in this environment means **testbed-complete**. It does
not mean **DSM-certified**. The final DSM certification is performed only after
the testbed release candidate passes all milestone suites.

## Milestone 0 baseline

Milestone 0 establishes:

1. a recorded WSL, Docker Engine, and Docker Compose inventory;
2. a recorded native-WSL or Windows-CLI-interop Docker transport and an immutable PostgreSQL 17 plus pgvector image selection;
3. loopback-only database exposure;
4. a generated local secret that is never committed or printed and is protected by mode `0600` or a current-user-only Windows ACL;
5. a persistent database volume and isolated Compose network;
6. health-gated startup and a real `halfvec` similarity probe;
7. safe start, verify, stop, and explicitly destructive reset commands;
8. fixture, runtime, artifact, and secret hygiene rules;
9. a clean-checkout verification path suitable for GitHub Actions;
10. `m00` checklist and proof artifacts.

## Planned expansion

| Milestone range | Testbed capability added                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| M1–M2           | Node 22 compatibility runner, pnpm workspace, migrations, local/DSM adapter contracts, static SPK validation |
| M3–M5           | RLS and partition tests, durable jobs, local watched folders, purge and crash recovery                       |
| M6–M7           | Format fixture corpus, memory ceilings, deterministic vision fake, optional live Ollama profile              |
| M8–M9           | REST, MCP, gateway, browser, accessibility, and end-to-end test services                                     |
| M10             | SPK assembly, archive inspection, lifecycle-script simulation, storage-probe simulation                      |
| M11–M12         | Rebuild concurrency, model-manifest changes, evaluation corpus, load and resource tests                      |
| M13             | Backup/restore, upgrade, disk-full, process-kill, corrupt-artifact, and network-failure rehearsals           |
| M14             | Clean-room release-candidate build, full regression, soak, SBOM, checksums, and proof bundle                 |

## Post-candidate Research checkpoint

The Research workspace is intentionally validated on WSL/Linux Docker before any new Synology package
is built. The checkpoint must prove personal collection creation, a clear no-selection error, `0`-key
save/remove behavior, confirmation before removal, visible result flags, PDF and Markdown navigation,
and references spanning two knowledge spaces. Backend integration must additionally prove owner
isolation, current silo-read enforcement, CSRF/idempotency enforcement, and search-only API-key denial.

Run the normal quality suite, PostgreSQL integration suite, and browser suite. Do not invoke
`package:thin`, `package:candidate`, or update the SPK revision for this checkpoint. The existing
Synology artifact remains unchanged until the user explicitly authorizes a later DSM build.

## Milestone 1 feasibility gate

Milestone 1 exercises the architecture-invalidating assumptions before a
workspace or product service is created. Its clean-checkout suite verifies the
Node 22 Linux compatibility image, the pinned q8 model, normalized 1,024-value
embeddings, an 8 GB two-session memory case, Argon2id, synthetic extraction
fixtures, storage safety, DSM contracts, PostgreSQL 17, and `halfvec(1024)`.

The workstation-only full gate additionally compares q8, q4f16, and fp16 over
256/512/1,024 tokens and one through twelve physical threads, and cross-builds
PostgreSQL plus pgvector from pinned spksrc recipes. These performance and build
results remain provisional until the final live DSM certification.

Only add a service when a milestone owns it. Optional or expensive services must
use Compose profiles so the base database remains quick to start. All service
dependencies must use explicit health checks or successful one-shot completion
conditions; container creation alone is not readiness.

## Required test layers

- unit and property tests without external services;
- PostgreSQL/pgvector integration tests against disposable databases;
- authorization and cross-silo isolation tests;
- OpenAPI, runtime-schema, pagination, idempotency, and SSE contract tests;
- extraction tests using synthetic or approved fixtures;
- browser and accessibility tests;
- deterministic vision tests, with live Ollama tests marked and optional;
- worker, database, network, disk, artifact, lease, and process fault tests;
- backup, blank restore, upgrade, rollback, and rebuild tests;
- reproducible package and release-artifact tests.

## Evidence

Every milestone proof must record:

- Git commit and remote workflow identity;
- WSL, Docker Engine, Compose, image, Node, PostgreSQL, and pgvector versions;
- immutable image digests;
- commands and exit status for each applicable test layer;
- fixture catalog revision and confirmation that it contains no private data;
- resource measurements and known differences from DSM;
- unresolved DSM items appended to the deferred certification register;
- `environment: docker-testbed` and `certification: testbed-complete`.

No testbed result may be relabeled as live DSM evidence. Performance values are
development baselines until repeated on the target NAS.

## Final DSM certification handoff

After M14, the testbed produces an immutable release-candidate SPK, checksum,
manifests, expected health identity, seed fixture bundle, acceptance script, and
operator checklist. The final live-device activity must then verify at least:

- DSM version, NAS architecture, CPU features, RAM, storage, ACLs, and ports;
- Synology Node runtime and native-module compatibility;
- bundled PostgreSQL/pgvector startup as the package-created user;
- install, first-run setup, ingest, search, restart, reboot, upgrade, restore,
  retained uninstall, destructive uninstall, and reinstall;
- ONNX correctness and performance, Ollama reachability, and resource impact;
- a 24-hour production-like soak.

Only that final pass authorizes `DSM-certified`, the `v1.0.0` tag, and the
private GitHub release.
