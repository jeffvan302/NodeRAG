# Milestone 13 Recovery Operations

This runbook covers the testbed-qualified recovery behavior. Use only synthetic or explicitly approved data until the final DSM certification. Never describe a Docker result as proof of Package Center, DSM ACL, reboot, or live NAS behavior.

## 1. Recovery invariants

1. A written archive is not a successful backup until the independent reader decrypts, reassembles, parses, and hashes it.
2. The sidecar is useful for discovery, but it is not trusted over the encrypted inner manifest.
3. A backup destination must be outside every active NodeRag data root.
4. A full restore is allowed only when the target has no user documents. Seeded settings, a temporary administrator, and empty silos are expected on a newly initialized target.
5. Restore never activates partially staged database rows or files.
6. PostgreSQL activation, installation-local safety resets, verification evidence, and the restore success marker commit in one transaction.
7. Restored secrets are never copied as ciphertext; plaintext exists only transiently inside the encrypted recovery stream and is encrypted again with the destination root key.
8. Restored sessions, setup tokens, active leases, device paths, schedules, gateways, and external providers do not become active automatically.
9. Old files, old database state, safety dumps, and old major-version clusters remain available until verification and explicit cleanup.

## 2. Archive products

The full product is an appliance-owner disaster-recovery archive. It contains the custom-format logical database dump, typed table streams, managed originals and canonical Markdown, identity/security history, model/build provenance, logical provider secrets, and optional model files.

The portable product is a narrowly classified corpus archive. It excludes identity, authentication, audit, gateway, lease/job, schedule, secret, and device-placement state. Portable row scanning fails if an undeclared credential-shaped key or value survives the redaction policy. Portable import maps archived corpus rows into an explicitly selected empty destination silo owned by the invoking administrator; it does not overwrite the appliance identity or global installation settings.

Both products use chunk-framed AES-256-GCM encryption with a scrypt-derived key, independently checksummed volumes, and a versioned inner manifest. The passphrase is not recoverable by NodeRag.

## 3. Create a one-off backup

1. Create and probe an administrator-selected storage location with purpose `backup`.
2. Confirm that its path is not inside the active documents, models, cache, PostgreSQL, upload, or temporary roots.
3. Estimate database and optional model size. Keep at least the preflight amount free; the runtime currently uses 1.5× logical database size, or 2.5× when models are included.
4. Submit `POST /v1/admin/backups` with a unique `Idempotency-Key`, a `destinationId`, product, passphrase of 12 or more characters, and `includeModels`.
5. Preserve the passphrase in the operator's approved password manager. It is intentionally absent from NodeRag records and cannot be reconstructed.
6. Poll `GET /v1/admin/backups`. Expected progression is `queued` → `running` → `verifying` → `succeeded`, with `verificationState=verified`.
7. Copy every `.nrag.NNNN` volume and its `.sidecar.json` together. Missing or reordered volumes fail verification.
8. Protect the completed backup using the selected external retention system. Hyper Backup behavior itself is verified only on DSM.

Example request body (replace every value):

```json
{
  "action": "run",
  "destinationId": 1,
  "product": "full",
  "passphrase": "obtain-from-approved-password-manager",
  "includeModels": false
}
```

## 4. Schedule backups

1. Submit the same endpoint with `action=schedule`, a unique name, UTC cadence fields, retention count, and an administrator-selected destination.
2. Create schedules disabled, verify the reported next-run time and secret fingerprint, then enable them deliberately.
3. The worker claims due schedules with row locking so competing workers cannot run the same occurrence.
4. If vault decryption, destination validation, backup, or independent verification fails, the occurrence and schedule record fail closed. Never treat the existence of volume files as success.
5. After a host move or restore, schedules remain disabled until the destination and UTC timing are reviewed.

## 5. Restore a full archive

1. Initialize the destination NodeRag database and data root with the same release/migration head and PostgreSQL major as the archive.
2. Do not ingest documents. Empty setup/admin/silo rows are allowed; any user document makes the target nonblank and blocks restore.
3. Place the archive outside the destination data root and verify every volume plus sidecar is present.
4. Register or retain the verified backup record on the target, then submit `POST /v1/admin/restores` with the backup ID, passphrase, exact confirmation `RESTORE THIS INSTALLATION`, and a new idempotency key.
5. The API returns `202` before the destructive work. The current authenticated session will be invalidated if activation succeeds.
6. Poll `GET /v1/admin/restores`. Expected progression is `queued` → `inspecting` → `ready` → `staging` → `verifying` → `activating` → `succeeded`.
7. On success, sign in with an administrator from the archive—not the temporary target administrator.
8. Verify silo grants, a known document and Markdown hash, page/locator integrity, keyword/vector search, model/build identity, and expected audit history.
9. Reconfigure and test filesystem locations, source schedules, gateways, scheduled backups, Ollama URL/credentials, and vision before enabling any of them.
10. Retain the old file tree and recovery archive until the administrator explicitly accepts the restored installation.

If confirmation, passphrase, compatibility, capacity, blankness, staging, relationship, hash, secret, or activation checks fail, the restore operation records a bounded error code, the active state is not replaced, and staging is retained for investigation.

### 5.1 Import a portable corpus

1. Create or select a destination silo that contains no documents. Other silos may remain active.
2. Confirm that the archived document IDs do not already exist anywhere in the destination appliance. NodeRag preserves collision-free document IDs and fails rather than silently renumbering file/database relationships.
3. Register the independently verified portable backup, then submit `POST /v1/admin/restores` with `action=import_portable`, the backup ID, `destinationSiloId`, passphrase, exact confirmation `IMPORT PORTABLE CORPUS`, and a new idempotency key.
4. NodeRag stages and verifies every classified table, source-silo relationship, document/page/image relationship, model/build provenance digest, and managed file before activation.
5. Activation maps every imported document/page/image to the selected destination silo, sets the invoking administrator as uploader, clears source placement, merges files by stable document ID, and queues the chunk/embedding worker against the destination silo's active build.
6. Existing principals, settings, gateways, schedules, secrets, sources, jobs in other silos, and files outside the incoming document paths remain unchanged.
7. Poll the restore operation to `succeeded`, drain the queued chunk/embed work, then verify search, locators, downloads, and destination-silo grants.

If a document ID or managed file already exists, use a genuinely empty/collision-free appliance or export a deliberately remapped corpus in a future compatible archive version. Do not rename volume contents or edit the encrypted manifest.

## 6. Upgrade rehearsal and rollback

For a same-PostgreSQL-major NodeRag upgrade, require at least one logical database size free, create and independently verify a safety backup, apply only new forward migrations, verify the exact expected head, activate, and retain the pre-upgrade state.

For a PostgreSQL-major upgrade, require at least twice the logical database size free. Run the old client while the old binaries still exist, create a custom logical dump, initialize the new cluster, restore typed values, apply/verify the target schema, and activate only after search/auth/health checks. Keep the old cluster or dump until explicit acceptance.

If any migration, restore, expected-head, health, or application verification fails:

1. stop activation;
2. invoke the upgrade driver's rollback;
3. mark the rehearsal `rolled_back` with a bounded failure code;
4. return to the retained old cluster/state;
5. keep the safety backup and failed target for diagnosis;
6. correct the forward migration or packaging defect without editing a shipped migration;
7. repeat the entire rehearsal.

## 7. Testbed qualification commands

From the repository root in WSL/Linux:

```bash
pnpm ci:quality
pnpm test:integration
pnpm recovery:m13:matrix
bash docker-testbed/scripts/verify-m13.sh --docker
pnpm package:thin
pnpm package:verify
```

`verify-m13.sh --upgrade-only` runs only the digest-pinned PostgreSQL 16-to-17 logical restore and retained-source rollback. Runtime artifacts, backup volumes, generated SPKs, secrets, and raw logs remain ignored.

## 8. Incident interpretation

| Symptom                                 | Meaning                                           | Safe next action                                                         |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| `backup-passphrase-mismatch`            | Authentication tag did not validate               | Re-enter the original passphrase; do not modify volumes                  |
| `backup-volume-digest-mismatch`         | A volume is missing, changed, or corrupt          | Restore the exact volume set from external retention                     |
| `backup-sidecar-manifest-mismatch`      | Discovery metadata disagrees with encrypted truth | Quarantine the archive and investigate its origin                        |
| `backup-destination-insufficient-space` | Backup preflight headroom is unavailable          | Select a larger external destination                                     |
| `restore-target-insufficient-space`     | Data root lacks payload plus 20% headroom         | Expand or select the correct empty target volume                         |
| `restore-target-not-blank`              | User documents exist on the target                | Use a separate initialized target; never force overwrite                 |
| `restore-migration-head-incompatible`   | Archive and runtime schemas differ                | Install the exact compatible release or use the documented upgrade chain |
| `maintenance-drain-timeout`             | Active mutating jobs did not checkpoint           | Inspect jobs, allow safe checkpointing, and retry                        |
| `upgrade-migration-head-mismatch`       | The candidate did not reach its declared schema   | Roll back and repair the forward migration/package                       |

## 9. Final DSM repeat

After M14, install the exact immutable candidate on the Synology device and execute DSM-016 plus DSM-024. Verify the candidate checksum before installation. The live run must cover Package Center lifecycle, real package identity/ACLs, Hyper Backup destination behavior, reboot during backup/restore/upgrade, blank-volume restore, retained rollback, search/auth afterward, and NAS resource/thermal impact. A failure reopens M13 or the owning earlier milestone and requires a new M14 candidate; it must never be waived into `v1.0.0`.
