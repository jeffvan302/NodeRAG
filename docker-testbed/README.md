# NodeRag WSL/Docker Testbed

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
