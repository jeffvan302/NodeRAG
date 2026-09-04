# Milestone 13 Checklist — Recovery, Upgrade, Fault, and Security Hardening

Status: local qualification complete; remote certification pending

## Backup products and policy

- [x] Every `noderag` base/partition-parent table is classified by the versioned fail-closed policy; newly added unclassified tables or redaction columns fail verification.
- [x] Dynamic chunk partitions inherit the classified `chunk` policy and do not masquerade as unrelated schema additions.
- [x] Full recovery archives contain a real custom-format logical dump, typed table streams, managed originals/Markdown, optional model files, and logical secrets.
- [x] Portable archives exclude principals, users, API keys, sessions, audit history, secrets, gateways, source placement, jobs, schedules, and other installation-local state.
- [x] Portable rows remove every explicitly classified identity/device column and fail on credential-shaped fields or values that were not classified.
- [x] Passphrases must contain at least 12 characters and are absent from command arguments, logs, archive sidecars, manifests, and plaintext storage.
- [x] Scheduled backup passphrases are encrypted by the installation vault; API responses expose only a fingerprint.
- [x] Backup destinations must be absolute, outside active data roots, writable, and large enough for the preflight estimate.

## Archive integrity and restore

- [x] Sidecar and inner manifest schemas are versioned and packaged.
- [x] Entries record path, byte count, SHA-256, data class, and logical owner; the sidecar records independent volume and whole-archive digests.
- [x] Archive production and verification stream data rather than buffering the appliance backup in memory.
- [x] Volume splitting, independent reassembly, wrong-passphrase rejection, byte tamper rejection, sidecar/manifest drift, traversal, source-stream failure, and partial-output cleanup pass.
- [x] Backup is successful only after a second independent decrypt/parse/hash pass.
- [x] Restore validates confirmation, archive location, password, version, schema head, PostgreSQL major, model dimensions, and 20% filesystem headroom before staging.
- [x] Blankness means no user documents; seeded settings, a temporary administrator, and an empty default silo do not incorrectly block disaster recovery.
- [x] Restore stages typed rows and files, preserves stable IDs, rejects excluded required references, and activates only after independent verification.
- [x] Existing installation-local references are detached or cleared before archived identities and provenance replace the temporary installation state.
- [x] Logical secrets are decrypted only inside the encrypted stream and re-encrypted under the destination installation key.
- [x] Sessions, setup tokens, live jobs/leases, gateways, schedules, source schedules, and external-provider activation are reset or disabled.
- [x] PostgreSQL row activation, installation-local safety resets, verification evidence, and the restore success marker commit atomically.
- [x] Failed restore rolls staged database/files back and retains diagnostic staging; successful restore retains replaced files until explicit cleanup.
- [x] A full archive restores through the runtime entry point into an initialized corpus-empty PostgreSQL installation.
- [x] The restored administrator authenticates, RLS-scoped keyword search returns the restored chunk, and the secret decrypts under the new key but has different ciphertext.
- [x] A portable archive imports through the runtime into an administrator-selected empty silo, maps source silo ownership, merges managed files without replacing other silos, preserves collision-free document IDs, and queues chunk/embedding rebuilding under the destination build.
- [x] Portable import leaves the current administrator and installation-local settings active, rejects document/file collisions, and never restores source identities, secrets, schedules, gateways, or device placement.
- [x] The administrator restore API accepts only a verified product-matching backup, product-specific typed confirmation, and a passphrase; idempotency replay cannot launch the operation twice.

## Upgrade and interruption recovery

- [x] Same-major planning requires one logical database copy of free space.
- [x] PostgreSQL-major planning requires twice the logical database size.
- [x] Upgrade rehearsal creates a safety backup before migration/restore, verifies the expected migration head before activation, retains the previous state, and releases maintenance in all paths.
- [x] Verification failure invokes rollback and persists `rolled_back` with a bounded failure code.
- [x] The digest-pinned PostgreSQL 16.15 source is custom-dumped and restored into PostgreSQL 17 with stable IDs, JSON, and arrays intact.
- [x] The PostgreSQL 16 source remains usable after the failed/removed target case, proving the retained-source rollback path.
- [x] Startup recovery marks interrupted backup/restore/upgrade operations failed and repairs an abandoned maintenance barrier.
- [x] Mutation drain timeout fails closed and releases the barrier.

## Security, supply chain, automation, and claims

- [x] Audit records reject direct update/delete while permitting only controlled retention, restore, and nested foreign-key nullification paths.
- [x] The 18-case fault/security matrix is versioned and every evidence path exists.
- [x] The SPDX 2.3 SBOM and exact locked-runtime `THIRD-PARTY.md` are reproducibly generated from the lockfile.
- [x] Migration `000011_recovery_hardening` is forward-only, checksummed, and the expected head.
- [x] OpenAPI M13 and the thin package contain the recovery contracts, SBOM, notices, and new migration.
- [x] Complete local quality, integration, Docker, package, license, secret, and repository gates pass on the final implementation tree.
- [ ] The GitHub implementation workflow passes all four jobs.
- [ ] The proof-only and evidence-closure commits pass the same workflow.
- [ ] Annotated tag `m13-complete` resolves remotely to the certified evidence commit.
- [x] Docker/WSL results are never represented as installed Synology evidence.
- [x] DSM-024 registers the exact-candidate installed backup/restore/upgrade repeat after M14.

## Claims boundary

This checklist certifies Linux/amd64 application, PostgreSQL, archive, upgrade, and package-simulation behavior only. DSM package management, ACLs, reboot ordering, installed runtime behavior, Hyper Backup interaction, NAS capacity/performance, and the final installed recovery sequence remain release-blocking live-device evidence under DSM-016 and DSM-024.
