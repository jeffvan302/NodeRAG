# NodeRag WSL/Docker Testbed

## Milestone 10 production-package simulation

From WSL/Linux with Docker available, `pnpm package:candidate` builds the pinned DSM x64 PostgreSQL/pgvector runtime and production SPK candidate. `pnpm package:candidate:verify` inspects it and launches the exact archive as UID/GID 1000 with a read-only root, dropped capabilities, `no-new-privileges`, a disposable `/volume1`, and no external database container. The run covers first initialization, private PostgreSQL socket/TCP refusal, pgvector, setup, five formats, watched ingest/search, restarts, same-major upgrade, retained uninstall/reinstall, and destructive uninstall.

Generated PostgreSQL and SPK outputs stay under `spk/generated`, `spk/work`, and `spk/artifacts`; Git ignores them. Docker evidence is testbed-only and must not be recorded as live DSM evidence.

## Milestone 13 recovery and upgrade rehearsal

`bash docker-testbed/scripts/verify-m13.sh --docker` builds the pinned Node 22
test runner, exercises encrypted full and portable archives against PostgreSQL
17, verifies wrong-password/tamper/fault behavior, and performs a logical
PostgreSQL 16.15 to 17 restore with typed JSON/array and stable-ID checks. The
PostgreSQL 16 source is digest-pinned and disposable; the rehearsal retains the
source until the restored database has passed verification, then proves the
source remains usable after the target is removed as the rollback case.

## Milestone 14 release-candidate soak

After building the production candidate, validate the soak harness with its
fixed, non-certifying 90-second profile:

```bash
bash docker-testbed/scripts/m14-soak.sh validate
```

Only `bash docker-testbed/scripts/m14-soak.sh start` runs the default 86,400-second
certification profile. Use it only for an immutable, committed candidate that
has passed CI. Inspect progress with the `status` or `logs` actions. Testbed
evidence is written under ignored `docker-testbed/artifacts/m14/` and must not
be represented as live DSM certification.

This directory is the repository-owned development and test environment for
NodeRag Milestones 0 through 14. It is not the production deployment model:
the released product remains one Synology DSM package, and Docker is never
required on the NAS.

The initial testbed supplies PostgreSQL 17 with pgvector. Later milestones add
the NodeRag server, worker, UI, deterministic vision fake, test runner, fault
injection, backup/restore rehearsal, and release-candidate validation without
changing the production architecture.

## Prerequisites

- Windows with WSL 2;
- Docker Desktop using the WSL 2 backend;
- Docker Compose v2 available through native Docker Desktop WSL integration or
  through Docker Desktop's `docker.exe` on the WSL interop path;
- Git configured to retain LF line endings for shell scripts.

Keep the repository inside the WSL Linux filesystem for the best file-system
performance when doing implementation work. Opening the Windows checkout from
WSL is supported for this small bootstrap stack, but it may be slower once the
repository contains Node modules and large fixture sets.

The scripts prefer the native WSL Docker socket. If Docker Desktop has not
exposed that socket but `docker.exe` is reachable through WSL interop, they
convert the project paths and use the Windows CLI against the same Linux Docker
Desktop engine. The selected transport is printed by the bootstrap command and
must be recorded in the M0 proof.

## First run

From WSL, at the repository root:

```bash
bash docker-testbed/scripts/up.sh
```

The bootstrap script creates a random local database password under
`docker-testbed/.secrets/`. That directory is ignored by Git, and the secret is
never printed. Native Linux requires mode `0600`; a repository on a Windows
mount is instead restricted to the current Windows identity with an explicit
NTFS ACL because DrvFS may report permissive POSIX modes. PostgreSQL is
published only on the loopback interface, using host port `55432` by default.

To validate an already-running testbed:

```bash
bash docker-testbed/scripts/verify.sh
bash docker-testbed/scripts/verify-persistence.sh
```

Milestone 1 adds a non-root Node 22 feasibility container, pinned Qwen ONNX
artifacts, format fixtures, DSM contract simulation, and provisional resource
measurements. Run the core milestone suite with:

```bash
bash docker-testbed/scripts/verify-m01.sh
```

The full q8/q4f16/fp16 benchmark downloads about 2.4 GB of pinned model files
into the ignored `runtime/` directory and evaluates 256, 512, and 1,024 tokens
with every thread count from one through twelve:

```bash
bash docker-testbed/scripts/verify-m01.sh --full
```

The production PostgreSQL and pgvector recipes can be cross-built with the
pinned spksrc builder and a Docker named volume, avoiding unsupported Windows
bind-mount semantics:

```bash
bash docker-testbed/scripts/crossbuild-m01-spksrc.sh
```

Generated measurements and cross-build logs are written under the ignored
`docker-testbed/artifacts/m01/` path. Model binaries and build trees are never
committed.

To inspect status or the latest logs:

```bash
bash docker-testbed/scripts/status.sh
bash docker-testbed/scripts/logs.sh
```

To stop it while retaining the database:

```bash
bash docker-testbed/scripts/down.sh
```

To deliberately remove the disposable database volume:

```bash
bash docker-testbed/scripts/reset.sh --confirm-destroy-test-data
```

## Configuration

Copy `.env.example` to `.env` only when a local override is needed. Do not put
passwords, provider tokens, production paths, or private document data in that
file. The generated PostgreSQL password remains a Compose secret file.

The PostgreSQL 17 pgvector image is pinned to the immutable digest accepted in
Milestone 0. Any image update must be deliberate: resolve and review the new
digest, run the complete testbed suite, and update the source, license,
PostgreSQL version, pgvector version, architecture, and digest evidence together.

## Boundaries

The testbed can prove application, database, extraction, authorization,
retrieval, UI, recovery, and packaging behavior. It cannot prove Synology's
package manager, package-created user, DSM ACLs, runtime ABI, volume behavior,
reboot sequencing, or real NAS performance. Those items remain in the final DSM
certification note in the staged implementation plan.

See [TEST-PLAN.md](TEST-PLAN.md) for the milestone expansion and evidence rules.
