# Deferred DSM Certification Register

Status: active until final DSM certification
Environment represented by current milestone evidence: Docker testbed
Rule: no row in this register may be closed using WSL, Docker Desktop, static
package inspection, or lifecycle simulation alone.

| ID | Live-only assertion | Owner | Live procedure | Required result | Release severity |
|---|---|---|---|---|---|
| DSM-001 | Target inventory and CPU baseline | Release operator | Record DSM build, NAS model, architecture, CPU flags, physical/logical cores, installed RAM, available RAM, volumes, filesystems, encryption, free space, and installed Package Center dependencies. | Inventory matches the release manifest and provides at least the supported resource floor. | Blocking |
| DSM-002 | Synology Node 22 runtime and native ABI | Package engineer | Install the declared Synology Node.js package, run the packaged Node binary and native modules as the package identity, and record Node, N-API, libc, libstdc++, and dynamic-linker details. | Node 22 and every required native module load without an ABI or linker error. | Blocking |
| DSM-003 | Package identity and privilege boundary | Security reviewer | Install through Package Center, identify the package-created account, inspect ownership/ACLs, attempt writes outside approved package/share roots, and attempt privileged operations. | Services run as the package identity, approved paths work, and disallowed writes/privileges fail. | Blocking |
| DSM-004 | Bundled PostgreSQL 17 lifecycle | Database owner | Start, stop, restart, reboot, upgrade, and recover the bundled database as the package identity using final lifecycle scripts. | Database reaches health without root, retains data, and shuts down cleanly. | Blocking |
| DSM-005 | Cross-built pgvector runtime | Database owner | Load the packaged `vector` extension into bundled PostgreSQL and execute the release `halfvec(1024)` insertion and distance probe. | Extension loads and the exact probe passes with no missing library. | Blocking |
| DSM-006 | ONNX runtime and Qwen correctness | ML/runtime owner | Load the pinned q8 release candidate from the package path, produce the golden query/document embeddings, and compare dimension, finiteness, norm, and repeatability. | 1,024 finite normalized values are produced within the golden tolerance. | Blocking |
| DSM-007 | ONNX memory and concurrency | ML/runtime owner | Run the selected long-input worker session plus the short-query session under the final service manager limits. | Both sessions complete without OOM, swapping instability, or service starvation. | Blocking |
| DSM-008 | Argon2id calibration | Security reviewer | Calibrate hash/verify timings on the NAS while representative NodeRag services are active. | Selected parameters meet the security floor and the accepted interactive latency budget without memory pressure. | Blocking |
| DSM-009 | Volume, filesystem, and ACL behavior | Storage owner | Run the storage probe on each supported `/volumeN` class, ext4/btrfs option, package home, shared folder, and relevant encrypted share. | Canonical paths, permissions, ACLs, fsync, rename, cleanup, and unsafe-path rejection behave as specified. | Blocking |
| DSM-010 | Data-share acquisition and retention | Package engineer | Install with the final data-share resource, inspect the created share and ACLs, then test retained and destructive uninstall modes. | Share provisioning and both retention modes match documented operator choices. | Blocking |
| DSM-011 | Port and web integration | Package engineer | Install final port/resource files, verify conflict handling, DSM reverse proxy/Web Station integration, TLS routing, and removal on uninstall. | Only declared ports/routes are created; conflicts are actionable; cleanup is complete. | Blocking |
| DSM-012 | Package Center lifecycle | Release operator | Exercise install, first start, status, stop, restart, package repair, upgrade, retained uninstall, destructive uninstall, and reinstall in Package Center. | Every transition reports correct state and preserves or removes data exactly as selected. | Blocking |
| DSM-013 | Reboot ordering and recovery | Release operator | Reboot during idle, queued work, and interrupted ingest/rebuild states; verify database and worker recovery after DSM is ready. | No corruption, duplicate terminal work, lost durable state, or boot loop occurs. | Blocking |
| DSM-014 | Ollama route and structured vision | Integration owner | From the package identity, reach the approved Ollama host with final authentication and a pinned vision model; submit the table fixture and validate the schema. | Required only when vision is enabled: route, authentication, schema, timeout, and content-boundary policy pass. | Conditional blocking |
| DSM-015 | Performance, thermals, and DSM service impact | Performance owner | Repeat the accepted embedding/load matrix and representative ingest/search workload while recording RSS, CPU, pressure, temperature, disk latency, and DSM service responsiveness. | Capacity limits are documented and no supported load causes unsafe thermals or unacceptable DSM impact. | Blocking |
| DSM-016 | Backup, restore, and upgrade continuity | Release operator | Create a release backup, restore to a blank supported volume, upgrade from the supported predecessor, and validate rollback/repair instructions. | Data, manifests, model state, migrations, and health identity are consistent after each path. | Blocking |
| DSM-017 | Production-like soak | Release operator | Run the final candidate for at least 24 hours with scheduled ingest, search, restart, and representative background NAS activity. | No crash, leak, stuck job, corruption, thermal issue, or material DSM-service regression. | Blocking |

## Closure requirements

Each row must be linked to a dated evidence artifact containing the NAS identity,
release-candidate checksum, commands or operator actions, raw result location,
reviewer, and disposition. The final certification proof must list every row as
passed or explicitly mark the release blocked. Only that proof may authorize the
`DSM-certified` state and `v1.0.0` release tag.
