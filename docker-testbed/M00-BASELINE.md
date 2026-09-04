# Milestone 0 Environment Baseline

Recorded: 2026-09-04T05:30:53Z

This baseline records the environment used for the first successful NodeRag
testbed run. It contains no secret values or private fixture data.

## Host and WSL

| Item | Recorded value |
|---|---|
| Host OS | Microsoft Windows 11 Pro, version 10.0.26200, build 26200 |
| CPU | AMD Ryzen 9 5900X, 12 physical / 24 logical cores |
| Host RAM | 63.93 GiB total; 31.34 GiB available at capture |
| Workspace disk | `D:`; 697.64 GiB free at capture |
| WSL distribution | Ubuntu 24.04.4 LTS |
| WSL kernel | 6.6.87.2-microsoft-standard-WSL2 |
| WSL architecture | x86_64 |
| Docker transport from WSL | `windows-cli-interop` fallback |

Docker Desktop provides the Linux engine. The native `/var/run/docker.sock` was
not exposed to this WSL distribution at capture time, so the repository scripts
selected `docker.exe` through WSL interop and converted paths with `wslpath`.
This still executes Linux/amd64 containers on the Docker Desktop engine. Native
WSL integration remains preferred and is selected automatically when available.

## Docker

| Item | Recorded value |
|---|---|
| Docker Desktop | 4.89.0 |
| Docker Desktop CLI plugin | 0.4.3 |
| Docker Engine client/server | 29.7.2 / 29.7.2 |
| Docker Compose | 5.5.0 |
| Engine OS/architecture | linux/amd64 |
| Storage driver / cgroup | overlayfs / v2 |
| Engine resources | 24 CPUs; 33,613,312,000 bytes memory |

## Database image

| Item | Recorded value |
|---|---|
| Image | `pgvector/pgvector` |
| Immutable digest | `sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f` |
| Image created | 2026-08-13T21:27:17.760916836Z |
| Image size | 157,781,872 bytes |
| Image OS/architecture | linux/amd64 |
| PostgreSQL | 17.11, Debian 17.11-1.pgdg12+2 |
| pgvector | 0.8.6 |
| Source | <https://github.com/pgvector/pgvector> |
| License | PostgreSQL License |

The Compose default and `.env.example` use the immutable digest. Updating the
image requires a reviewed digest change plus the complete M0 regression suite.

## Validated behavior

- Compose configuration validation passed.
- PostgreSQL reached Docker health state `healthy`.
- `CREATE EXTENSION vector` succeeded.
- A temporary `halfvec(3)` insert and cosine-distance query returned the
  expected zero distance.
- PostgreSQL reported pgvector 0.8.6.
- The published database binding is exactly `127.0.0.1:55432`; a WSL loopback
  connection succeeded.
- A unique database marker survived a PostgreSQL stop/start cycle.
- The reset command refused to delete resources without the exact
  `--confirm-destroy-test-data` argument, returning exit code 2.
- Status and log collection commands succeeded.
- The generated password is ignored and untracked. Because the checkout is on
  a Windows mount that reports permissive POSIX modes, the directory and file
  inheritance were removed and the NTFS ACL grants access only to the current
  Windows identity.
- Shell syntax validation passed for every testbed script.
- `git diff --check` passed after the repository `.gitattributes` rules were
  added.

## Content hashes

| File | SHA-256 |
|---|---|
| `docker-testbed/compose.yaml` | `2d8d221165985901b2f5715cac24e5d03af4882546ae07b6622af3098a39b6a0` |
| `docker-testbed/initdb/001-enable-pgvector.sql` | `8abc27d775f8859438e88a1c00002ba5cb183ede309a1f9728cc996c3d9523fd` |
| `docker-testbed/TEST-PLAN.md` | `7d8d198584f716ee85f97304b5e7036443cd61ba4e5cd1414a617114b47c1db7` |

## Known environment qualification

These results certify the local Docker testbed only. They do not prove DSM
package installation, Synology runtime ABI compatibility, package-user behavior,
DSM ACLs, NAS storage, reboot behavior, or hardware performance. Those checks
remain in the final DSM certification register.
