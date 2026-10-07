# Railway Deployment Phase 5: Portable Backup And Verification

Last reviewed: 2026-08-06.

Phase 5 adds a portable application export: every record and every stored file,
written to an S3-compatible destination you control, with a verifier that proves
the archive is complete and carries no plaintext secret.

**Status.** Implemented. The two deploy tests that prove a restore are Phase 6,
and until one has run, no archive should be treated as a proven restore point.

> **Encryption update (2026-08-28).** Railway now generates
> `BACKUP_ENCRYPTION_KEY` for Maintenance. Manual backups without a per-request
> key and all scheduled or database-transfer archives use that recovery
> credential. Maintenance fails closed when neither key is available, so the
> archive—including original and derived document objects—is never uploaded in
> plaintext. See [Backup And Restore Data
> Classification](../system/backup-restore-data-classification.md).

> **Data-plane update (2026-08-28).** A version 4 template starts with Railway
> PostgreSQL/PostgREST and independent Supabase Storage. Portable exports read
> the active route, not a hard-coded Supabase database. Database transfers still
> require a separate healthy S3 destination before any connection can change;
> configuring document object storage does not satisfy that transfer gate.

## What A Backup Contains

A portable archive holds the application's own records as versioned JSON Lines
plus every object in the storage buckets those records refer to. It does not
hold a Postgres dump; that is the disaster-recovery mode, deferred to Phase 7
per the roadmap's own sequencing.

```text
manifest.json
checksums.sha256
release/application-version.json
release/migrations.json
database/application-data/*.jsonl
storage/<bucket>/**
storage/storage-manifest.jsonl
reports/backup-summary.json
```

The archive is a tar stream through zstd. Nothing is assembled in memory and
nothing touches the container filesystem: a Railway disk is ephemeral and an
installation's storage can exceed the service's memory, so either approach would
fail on exactly the installations most in need of a backup.

## The Maintenance Barrier

Postgres and Storage share no transaction. A backup that simply reads both can
capture a document row whose file was written afterwards, or a file whose row is
absent. The barrier removes the problem rather than reconciling it.

1. `maintenance_mode` becomes `backup_requested`.
2. Workers stop claiming, because readiness now reports `maintenance` and
   `can_process_platform_jobs` already refuses that state. This needed no new
   code.
3. The public API refuses mutating requests with `503 maintenance_in_progress`.
   Reads are unaffected: a backup should not take the API down.
4. The export waits for jobs claimed before the barrier to finish.
5. `maintenance_mode` becomes `quiesced` and a high-water mark is taken from the
   **database's** clock, not the exporter's. A timestamp taken in the
   maintenance process could sit either side of a commit that happened moments
   earlier, and every consistency claim rests on this value.
6. Rows and objects are exported as of that instant.
7. The barrier is released from a `finally` block on every path.

That last point matters more than it reads. An installation left quiesced by a
failed backup is a worse outcome than the failed backup: no ingestion, and an
admin interface reporting maintenance with nothing running.

A drain that times out does not abort the backup. It proceeds and records a
warning in the manifest naming how many jobs were still running, because a
usable archive with a stated caveat beats no archive.

## Where Archives Go

**S3, and only S3.** A copy written back into the Supabase project being backed
up disappears with that project, which is the failure a backup exists to
survive. The `backups` bucket and the `supabase_storage` destination were both
removed once that became clear.

Backblaze B2 is the default because it is the cheapest widely available
S3-compatible storage, but nothing depends on it. The endpoint defaults to
`https://s3.us-east-005.backblazeb2.com`; change the region, or the whole host,
for Amazon, Cloudflare R2, Wasabi or MinIO.

| Variable                      | Purpose                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `BACKUP_S3_ENDPOINT`          | Defaults to the Backblaze us-east-005 endpoint.                                              |
| `BACKUP_S3_BUCKET`            | Required. Must already exist.                                                                |
| `BACKUP_S3_ACCESS_KEY_ID`     | Required. On Backblaze an application keyID, not the master key, which is not S3 compatible. |
| `BACKUP_S3_SECRET_ACCESS_KEY` | Required. Shown once when the application key is created.                                    |
| `BACKUP_S3_REGION`            | Optional. Derived from the endpoint for Backblaze and Amazon.                                |
| `BACKUP_S3_PREFIX`            | Optional. Defaults to `bubble-rag`.                                                          |
| `BACKUP_S3_FORCE_PATH_STYLE`  | Optional. `true` for MinIO and similar.                                                      |
| `BACKUP_S3_PART_BYTES`        | Optional. Defaults to 16 MB, floored at the 5 MB S3 minimum.                                 |
| `BACKUP_VOLUME_BYTES`         | Optional. Defaults to 5 GB per volume.                                                       |

These are the fallback. **The destination is normally configured under
Configuration → Storage**, which stores it in `storage_access_configs` and puts
the secret access key in Vault through the same function the model providers
use. That is what keeps it out of a portable archive: the vault tables are
already excluded by the redaction policy, so no new rule was needed.

Maintenance prefers the database and falls back to the environment, so an
installation can be given a destination before anyone can log in, and an
existing deployment keeps working after an upgrade without re-entering
anything. The destination report names which of the two is in use, because a
leftover environment variable that silently wins would be hard to spot.

Storage is its own section rather than part of Backup: an S3 endpoint is a
general capability and backups are its first consumer, not its only intended
one.

### Volumes

The archive is split into numbered objects, so total size is not bounded by any
provider's single-object ceiling:

```text
bubble-rag/<backup-id>/bubble-rag-20260806T1200Z.bragbackup.0001
bubble-rag/<backup-id>/bubble-rag-20260806T1200Z.bragbackup.0002
bubble-rag/<backup-id>/manifest.json
bubble-rag/<backup-id>/volumes.json
```

Volumes are a byte split of one continuous stream, like `split(1)`. **An
individual volume is not independently readable.** Restoring concatenates them
in index order, decrypts if needed, then decompresses. `volumes.json` records
the order, each volume's digest, and the digest of the whole concatenation, so a
damaged volume can be identified and re-fetched and the set can be proven
complete.

Peak memory is one upload part, held once, whatever the installation's size.

### Sharing one bucket between installations

Two installations can point at the same bucket and prefix safely. Archives are
keyed by the backup job's id, which each installation generates in its own
database, so they land in separate folders and cannot collide.

They do **not** see each other's backups. The Backups screen lists from that
installation's own `backup_jobs` table, not from the bucket, so an installation
shows only archives it took. Restoring someone else's archive is a Phase 6
concern and will need a bucket and backup id supplied directly rather than
chosen from a list.

Verify and delete confirm the backup belongs to the installation asking before
they reach S3, and answer a foreign id exactly as they answer an unknown one so
ids cannot be probed. That check is in the application, not the storage: one
key pair that can write the bucket can also read and delete everything in it.
For isolation enforced by the provider rather than by our own care, give each
installation an application key restricted to a name prefix and set its key
prefix to match.

## Secrets

The redaction policy is read from `platform/secret-redaction.v1.json` rather
than restated in code, so a column added there takes effect without a code
change.

A protected column is **removed**, not replaced with a placeholder. A
placeholder restores as a real value that merely looks wrong — an empty password
hash, or the literal `REDACTED` as a webhook URL — and something downstream
eventually treats it as data. An absent key forces the restore to supply one,
which is the documented requirement.

Verifying an encrypted archive needs the same passphrase a restore does,
because it reads the archive the same way. That was missing until Phase 6 and
made an encrypted archive indistinguishable from a corrupt one.

Optional encryption uses AES-256-GCM with a key derived by scrypt from a
passphrase supplied on the request. **The key is never stored.** It exists in the
maintenance process for the life of the job and is discarded. What sits beside
the archive is the salt, the IV, and a twelve-character hash of the derived key
so an operator can tell which key an archive needs. An archive whose key is lost
cannot be restored, which is the property that makes it worth having.

The GCM authentication tag makes the archive tamper-evident rather than merely
unreadable: a single flipped byte fails the whole decryption instead of yielding
plausible garbage.

## The Verifier

The phase gate: _the backup verifier proves all expected records and object
bytes are present, and no plaintext secret appears in the default archive._

`verifyBackupArchive` reads a finished archive back from S3 and shares nothing
with the exporter beyond the format constants. A verifier built from the
exporter's own bookkeeping would only prove the exporter agrees with itself.

It checks:

- every entry's digest against `checksums.sha256`
- each table's row count against the manifest
- that every column declared redacted is genuinely absent
- that no value anywhere is shaped like a JWT, a Postgres URL with a password, a
  private key, an OpenAI key, a Supabase access token or an AWS access key
- that every object in the storage manifest is present at its declared digest
- that the in-archive manifest does not claim a digest it could not know

Column names that look like secrets but are not classified produce a warning
rather than a failure, because the policy names the columns known when it was
written and a migration can add one nobody remembered.

### One contract amendment

`backup-manifest.v1` required the archive's own SHA-256 inside the archive,
which is impossible: that manifest is part of the bytes being hashed. The
in-archive copy now carries `null` plus `entriesSha256`, a digest of
`checksums.sha256` which is knowable at write time. The sidecar manifest and
`backup_jobs.archive_sha256` carry the real value. Amending v1 rather than
bumping to v2 was safe because no archive had ever been produced.

## Operating

Backups are admin-only, under **Backups** in the top bar. Create, cancel,
verify and delete, with stage, elapsed time, row and object counts, bytes and
the full error text.

A partial unique index allows one queued or running backup per tenant, so two
operators pressing the button cannot both take the barrier.

The destination is checked before the barrier goes up. Discovering a wrong key
after an hour of quiesced platform would be the worst possible moment to find
out.

## Verification

```powershell
pnpm test
pnpm docs:check
```

Twenty-eight backup tests cover the export and verify round trip, redaction,
excluded tables, plaintext-secret detection in an unclassified column, archive
corruption, volume splitting and byte-exact reassembly, part sizing against the
S3 minimum, region derivation, encryption round trip, tamper detection and
truncation.

## Deferred Beyond Phase 5

At the time this Phase 5 record was written, the following work belonged to
later phases. The security-target note near the top describes the additional
encryption work still required by the current architecture plan.

- **A restore that has actually run.** The restore path is implemented in
  Phase 6, but no archive has been restored into a live installation yet. Until
  one has, an archive is an untested artifact; the roadmap says a backup is not
  accepted until it has been restored.
- **The disaster-recovery mode**, a logical Postgres dump. Phase 7, deliberately
  after restore tests exist.
- **Scheduled backups, retention and drills.** Phase 7.
