# Milestone 10 Checklist — Production SPK and Simulated Lifecycle

Status: testbed-complete

## Runtime and archive

- [x] PostgreSQL 17.11 and pgvector 0.8.6 are built from the pinned spksrc commit and DSM 7.2 x64 toolchain image.
- [x] The runtime archive is deterministic, checksummed, pruned of headers/static libraries/manuals, and records its exact provenance.
- [x] CI may reuse the runtime only when the recipe key, archive checksum, builder image, spksrc commit, toolchain, architecture, PostgreSQL version, and pgvector version all match; a miss falls back to the pinned cross-build.
- [x] Linux x64 ONNX Runtime and canvas native modules are packaged; non-Linux ONNX binaries and development source folders are removed.
- [x] The candidate contains no package-manager install command or runtime download of executable dependencies.
- [x] INFO, icons, notices, privilege/resource metadata, port metadata, DSM UI metadata, install wizard, and uninstall wizard pass static inspection.

## Identity, prerequisites, and private database

- [x] Services use DSM `run-as: package` with the dedicated `noderag` identity and data-share grant.
- [x] Architecture, DSM 7.2, Node.js 22, physical RAM, free disk, and port guards are fixture-tested in the simulator.
- [x] First initialization exposes the UI plus health/readiness/setup status while PostgreSQL is absent; no authenticated content/admin surface is registered.
- [x] First configured start generates a private database password, runs `initdb`, creates the `noderag` database, loads pgvector, and applies the migration checksum manifest through `000008_package_lifecycle`.
- [x] PostgreSQL uses a mode-0700 Unix socket under package data and `listen_addresses=''`; the simulator proves TCP 5432 refuses connections.
- [x] PGDATA, WAL, socket, private configuration, credentials, and runtime are package-controlled by default.

## Storage, models, gateways, and operations

- [x] The storage probe resolves canonical paths and, under DSM policy, requires `/volumeN`, ext4/btrfs, write/fsync/rename/read, and projected capacity plus rebuild reserve. It preserves existing DSM ACL roots, creates a dedicated managed child, requests private mode on package-created directories, and reports projected-mode differences as warnings.
- [x] Encrypted-share requirements and Synology Drive/indexing warnings are represented by explicit configured roots.
- [x] Relocation uses a single-writer lock, verified full SHA-256 manifest, atomic activation/rollback, and retains the old tree.
- [x] Durable relocation/model-artifact schema records were added in a forward-only migration.
- [x] Manual model import is restricted to configured roots and uses `.partial`, SHA-256 verification, and atomic rename.
- [x] Model download accepts only HTTPS allowlisted hosts, resumes with Range when possible, verifies SHA-256, atomically renames, and falls back across ordered mirrors.
- [x] Model APIs return name, byte count, and digest without returning a private filesystem path.
- [x] Operator-created gateway listeners default disabled; non-loopback plaintext binding requires an explicit override and emits a structured warning recommending DSM TLS reverse proxying.
- [x] Log rotation is bounded and recent admin-visible errors expose only allowlisted structured fields, never raw lines, request bodies, or secrets.

## Lifecycle simulation

- [x] Candidate runs as UID/GID 1000 with a read-only container root, all capabilities dropped, and `no-new-privileges`.
- [x] Install/post-install is idempotent and preserves the root key and database credential.
- [x] Ordered bootstrap, database, embedder, API, and worker startup reaches health and package status.
- [x] Setup, five-format ingest, watched-source crawl, search, locators, SSE replay, and purge pass against the bundled database.
- [x] Process restart, package restart, reboot-style restart, same-major upgrade, retained uninstall, reinstall, and explicit destructive uninstall pass.
- [x] Stale PID/socket cleanup and bounded graceful/forced shutdown are implemented.
- [x] The old package data is retained by default; deletion requires `wizard_delete_data=true` or the simulator-only compatibility control.
- [x] GitHub M10 workflow is green on the implementation commit.
- [x] Proof-closure and test-stabilization commit is green on GitHub.
- [x] The final certification commit passes all four jobs before annotated tag `m10-complete` is created and verified remotely.

## Claims boundary

This checklist certifies the Docker package-user simulator only. It does not certify Package Center, DSM ACLs, Synology runtime ABI, real `/volumeN` filesystem reporting, DSM reverse proxy/UI registration, real reboot ordering, or NAS performance. Those remain in the deferred DSM register and final post-M14 certification.
