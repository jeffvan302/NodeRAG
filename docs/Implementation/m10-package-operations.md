# Milestone 10 Package Operations

## Candidate build

Run the candidate build from a Linux environment with Docker available:

```text
pnpm package:candidate
pnpm package:candidate:verify
```

The first command builds or reuses the pinned spksrc volume, assembles the deterministic PostgreSQL/pgvector runtime, builds the application/UI, and writes `spk/artifacts/noderag-1.0.0-rc.1-x86_64.spk`. The verifier performs archive inspection and runs the package-user lifecycle simulation. The SPK and generated runtime are build outputs and are intentionally ignored by Git.

## Startup sequence

On a first installation the lifecycle scripts perform these transitions:

1. `postinst` creates mode-0700 package directories, a 32-byte root key, a random database password, and a checksum-verified PostgreSQL runtime.
2. `preflight` validates x86_64, DSM 7.2+, Node.js 22, physical RAM, free package storage, and port 8787.
3. A temporary database-free API serves health/readiness/setup status while the cluster is initialized.
4. `initdb` creates PGDATA and WAL under package data. PostgreSQL listens only on its mode-0700 Unix socket.
5. The lifecycle creates the `noderag` database. Application startup loads pgvector and forward-only migrations through the manifest head.
6. If a verified model is present—or the simulator test embedder is explicitly selected—the embedder starts, followed by the full API and worker.
7. Setup issues a filesystem token, then atomically creates the first administrator/default silo and removes the consumed token.

Shutdown is the reverse dependency order: worker, API, temporary API if present, embedder, then PostgreSQL. Every wait is bounded; stale PID files are accepted only when the live command line matches the expected component.

## Storage policy

Production package startup selects `NODERAG_STORAGE_POLICY=dsm`. A managed bulk-data target must resolve below `/volumeN`, report ext4 or btrfs, retain mode 0700/0750, pass write/fsync/rename/read, and have projected capacity plus rebuild reserve. Administrators may declare encrypted roots, require encryption, and identify Synology Drive or indexing roots so the probe returns actionable warnings.

Relocation is intentionally two-phase: copy to a temporary sibling while a single-writer guard is held, compare a complete path/size/SHA-256 manifest, then activate. If activation fails, the source is restored. The old source tree remains with a dated `retained` suffix until a separate explicit cleanup. PostgreSQL tablespace movement additionally requires the package maintenance/stop boundary; it must not be attempted by copying a live cluster.

## Model acquisition

Manual import accepts a local source only below an administrator-configured import root. Network download accepts only HTTPS URLs whose host is explicitly allowlisted. Downloads retain `.partial` state and issue a Range request, try ordered mirrors, verify the expected SHA-256, then rename atomically. A failed checksum never replaces the active file. API results exclude source and destination paths.

## Logs and diagnosis

The supervisor rotates each component log at 5 MiB by default and retains five generations. `/v1/admin/health` may show recent structured failures, but it returns only service, timestamp, level, event, code, error class, and request ID. Raw log messages, bodies, tokens, and filesystem paths are not returned.

For DSM troubleshooting, collect the component logs, Package Center lifecycle output, package status, PG socket permissions, and the SPK checksum. Do not edit PGDATA, delete a `.partial`, remove retained relocation data, or expose PostgreSQL over TCP as a repair shortcut.

## Uninstall and upgrade

Uninstall retains all package state by default. The destructive wizard option must explicitly set `wizard_delete_data=true`; the deletion script rejects paths outside the exact approved package-data locations. A retained reinstall reuses the existing cluster and secrets.

Before a same-major upgrade, the script validates the on-disk PostgreSQL major, records an upgrade marker, and performs an ordered stop. Post-upgrade starts the complete service and removes the marker only after start returns. PostgreSQL-major migration is not implicit; a future major change requires the logical dump/new-cluster/verification procedure in Milestone 13.

## Evidence boundary

Docker proves Linux executability, non-root ownership, archives, service ordering, private sockets, durability, and scripted lifecycle behavior. It cannot prove real Package Center variables, DSM package-account/ACL creation, Synology Node ABI, Web Station/reverse proxy registration, actual ext4/btrfs/encrypted-share behavior, DSM reboot ordering, or NAS resource/thermal limits. Repeat those checks with the exact tagged M14 candidate during final DSM certification.
