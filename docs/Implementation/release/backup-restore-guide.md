# Backup and Restore Guide — 1.0.0-rc.1

The complete recovery invariants and API state machines are documented in
`docs/Implementation/m13-recovery-operations.md`. This release checklist is the required operator
sequence for the candidate.

## Full backup

1. Register and probe a backup location outside every active NodeRag root.
2. Confirm free space of at least 1.5× the logical database, or 2.5× when models are included.
3. Choose a passphrase of at least 12 characters and store it outside NodeRag.
4. Submit a full backup with a unique idempotency key.
5. Wait through queued, running, and verifying to `succeeded`; also require
   `verificationState=verified`.
6. Preserve every numbered encrypted volume and its sidecar together. The sidecar aids discovery;
   the authenticated inner manifest is authoritative.
7. Copy the set into the approved external retention system and perform a restore rehearsal.

## Scheduled backup

Create schedules disabled, verify UTC cadence, destination, product, secret fingerprint, next run,
and retention, then enable them. A schedule occurrence is successful only after independent archive
verification. After restore or host relocation, schedules remain disabled until reviewed.

## Blank full restore

1. Install the exact compatible version and initialize a blank target. Seed administration rows
   are permitted; user documents are not.
2. Place the complete archive outside the target data root and register it.
3. Submit restore with the original passphrase and exact phrase `RESTORE THIS INSTALLATION`.
4. Observe inspecting, ready, staging, verifying, activating, and succeeded states.
5. Sign in with an administrator from the archive and verify identity, grants, a known document,
   Markdown hash, locators, all search modes, model/build identity, and audit history.
6. Reconfigure and test device paths, sources, schedules, gateways, backups, and Ollama before
   enabling them. Retain old state and the archive until acceptance.

## Failure and rollback

Wrong passphrase, changed/missing volume, sidecar disagreement, incompatibility, insufficient space,
nonblank target, staging mismatch, or activation failure must leave the active target unmodified.
Preserve staging and bounded error evidence. For upgrade failure, restore the retained old cluster
or verified safety backup; never force a partial target into service.
