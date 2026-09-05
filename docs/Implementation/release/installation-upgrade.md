# Installation and Upgrade — 1.0.0-rc.1

## Before installation

1. Use only `noderag-1.0.0-rc.1-x86_64.spk` from the private GitHub prerelease.
2. Compare its SHA-256 with the attached `.sha256` file before opening Package Center.
3. Confirm x86_64, DSM 7.2-64570 or newer, `Node.js_v22`, port 8787 availability, adequate RAM,
   and enough package plus data-volume space for the corpus, model, and one full rebuild.
4. Select a package-data volume and separate backup destination. Do not place backups inside any
   active database, document, model, cache, upload, or temporary root.
5. Keep the NAS behind its normal trusted-LAN controls. PostgreSQL must never be exposed over TCP.

## Clean installation

1. In Package Center, choose Manual Install and select the verified SPK.
2. Review the package identity and data-retention notice, then install.
3. Wait for Package Center to report Running. Do not attempt to initialize PostgreSQL manually.
4. Open NodeRag from the package UI. The first-run flow uses a short-lived setup token created by
   the package; it must not require SSH or a shell.
5. Create the first administrator and default silo, sign in, select/probe storage, import the
   checksum-pinned embedding model, run calibration, test Ollama if used, register sources, and
   complete setup.
6. Verify `/health`, `/ready`, one fixture of every supported format, all three search modes, the
   jobs view, and an independently verified backup before accepting the installation.

## Same-candidate reinstall

Uninstall retains data unless the destructive wizard choice is explicitly selected. A retained
reinstall must reuse the cluster, root key, database password, configuration, and documents. If it
does not, stop and preserve Package Center plus component logs; do not delete package data.

## Upgrade

1. Record the running version, migration head, SPK checksum, PostgreSQL major, model digest, and
   active build.
2. Create a full encrypted backup and wait for both `state=succeeded` and
   `verificationState=verified`. Preserve its passphrase separately.
3. Ensure at least one logical database size of free space for a same-major upgrade and twice that
   size for a PostgreSQL-major transition.
4. Install the newer verified SPK through Package Center. The pre-upgrade hook records state and
   stops services in dependency order.
5. The post-upgrade hook starts PostgreSQL, verifies the expected forward-only migration head,
   starts embedder/API/worker, and removes its marker only after health succeeds.
6. Verify authentication, silo grants, a known locator, vector/keyword/hybrid search, jobs,
   gateways, scheduled sources, backup destinations, Ollama, and audit history.
7. Retain the old package/cluster or safety backup until the acceptance period ends.

If migration, health, search, authentication, or restore verification fails, stop activation and
follow the rollback procedure in the recovery guide. Never edit a migration that has shipped.
