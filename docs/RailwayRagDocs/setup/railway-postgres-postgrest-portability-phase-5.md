# PostgreSQL/PostgREST Portability Phase 5: Database Transfer

Status: complete on 2026-08-28.

Phase 5 implements the guarded database move and existing-database attachment
engines. Settings remains outside the moving PostgreSQL database and owns every
operation, immutable analysis, approval, checkpoint, event, retained
credential, maintenance barrier, and active-route revision. Maintenance holds
short-lived credentials only while it inspects or executes an approved job.

## Transfer prerequisites

A transfer is not created merely because a bucket can be listed. Maintenance
writes a random object, reads it back, compares its SHA-256 digest, and deletes
it. Settings accepts only a fresh proof containing all three successful
capabilities. Transfer analysis also requires:

- different permanent source and target database identities;
- an active, open source route;
- a target PostgREST endpoint linked to the target database;
- an installed release schema package and ownership manifest; and
- `BACKUP_ENCRYPTION_KEY`, generated once for the Railway installation.

Manual and scheduled off-platform backups now use the same generated recovery
credential when the request does not supply its own. A backup or transfer fails
closed rather than writing an unencrypted archive when no recovery credential
is available.

## Immutable analysis and approval

Maintenance inspects both migration ledgers, PostgreSQL capabilities, permanent
database identities, application-owned tables, estimated rows, and the release
schema fingerprint. Settings stores the result as an immutable analysis with a
ten-minute expiry and a fingerprint over the exact target facts.

Approvals are also immutable and bind:

- the operation and analysis IDs;
- the complete analysis hash;
- the target fingerprint;
- the exact destructive actions;
- a fresh administrator re-authentication; and
- the generated confirmation phrase.

A populated target requires `replace_target_application_data`; a behind target
requires `apply_schema_migrations`; every move requires `activate_route`.
Changing the target, route, identity, analysis, action list, or expiry makes the
approval unusable.

## Execution order

Maintenance reports monotonic, replay-safe sequence numbers. Settings rejects
gaps and rejects the same sequence with different content. The executed order
is:

1. enter maintenance mode and return `503 database_offline_for_maintenance`
   from database-backed web routes;
2. drain active application connections and close the source write barrier;
3. create, encrypt, upload, read back, decrypt, and hash the source safety
   archive;
4. play a behind source forward in release order and create a newly verified
   current-shape archive when the schema changed;
5. create and independently verify an encrypted target safety archive when the
   target contains application data;
6. clear only tables marked `clear_data` by the immutable application ownership
   manifest—never provider schemas or preserved control tables;
7. play the target schema forward and record the release checksum ledger;
8. restore the PostgreSQL custom-format, data-only archive with stable IDs;
9. repair owned sequences and verify migration checksums, identities, exact row
   counts, validated relationships, embedding counts, representative vector
   search, and the target PostgREST readiness identity; and
10. submit the bound transfer manifest for atomic route activation.

The transfer archive stores no credentials. Its manifest binds the encrypted
S3 reference and hashes to the operation, analysis, target fingerprint, source
barrier time, source and target identities, release package, ownership policy,
and restore checkpoints.

## Failure, cancellation, and retry

Any failure before activation leaves the active binding on the source. Settings
releases the maintenance barrier, records whether the source reopened after a
backup, and preserves both destination records and credentials. Cancellation
uses the same pre-activation release path.

Reports are idempotent. A failed restore can be retried only when Maintenance
proves all of the following:

- the failed attempt number is exact;
- the durable target marker belongs to this operation;
- the analyzed target fingerprint is unchanged;
- no outside writes were detected; and
- the source WAL position still matches the retained current-shape backup,
  proving that no source commit occurred even if the source route briefly
  reopened after the failed attempt; and
- the target WAL position still matches the failure checkpoint and the exact
  operation marker remains the only transfer marker on that database.

Otherwise Settings refuses continuation and requires a new analysis and
backup. Full schema-and-data disaster recovery remains a separate restore mode;
it is never used as an implicit transfer retry.

## Atomic activation and retained-source cleanup

Settings accepts activation only from a running operation in the `activating`
stage while that operation owns the active maintenance barrier. In one local
Settings transaction it:

- stores the immutable transfer artifact;
- records the verified target ledger and database identity;
- marks the target database and PostgREST endpoint active;
- advances the route revision exactly once;
- releases maintenance mode; and
- marks the old database and API as `retained_source`.

The old source is never erased as part of activation. Cleanup creates a new
`decommission` operation with its own target fingerprint, administrator
re-authentication, confirmation phrase, and `clean_source` approval. Maintenance
re-reads, decrypts, and hash-verifies the retained S3 recovery artifact, checks
the permanent source identity, and only then clears application-owned data. It
checkpoints that destructive boundary, deletes the source transfer set and any
target-safety set owned by the same operation, and verifies both S3 prefixes are
empty, including historical versions and delete markers in versioned buckets.
The transfer probe therefore requires version-list and version-delete
permissions before a transfer can start. Ordinary scheduled and manual backups
are outside those operation-owned prefixes and are preserved. Success marks the source decommissioned; failure
leaves it `cleanup_pending`, with credentials retained so a retry can resume S3
deletion without requiring the now-cleared source archive to remain readable.
Railway volume deletion remains part of Phase 9 live decommissioning.

## Attach existing database

Attachment is deliberately separate from transfer. It does not require S3,
does not clear target data, and does not create or restore a transfer archive.
Maintenance recognizes the existing database identity and migration ledger,
then plays it forward if necessary. If any missing migration requires a
verified backup, attachment first creates and verifies an encrypted target
safety archive; without S3 or a recovery credential that high-risk attachment
is refused. After database and PostgREST identity verification, Settings uses
the same atomic route barrier and revision rules to activate the existing data
in place.

## Release contracts and checks

The Phase 5 release head is
`20260828000100_database_transfer_markers`. The migration adds the durable,
maintenance-only retry marker. The ownership manifest preserves installation,
migration, maintenance, and runtime control tables and marks transfer markers
`never_touch`.

Run:

```text
pnpm --filter @bubble-rag/rag-core test
pnpm --filter @bubble-rag/settings test
pnpm --filter @bubble-rag/maintenance test
pnpm platform:check
```

These checks cover S3 write/read/delete proof, mandatory backup binding,
ownership-filtered inventory and dump arguments, immutable approvals, ordered
reports, failure route reopening, release checksums, and provider-neutral schema
play-forward. The full live Railway/Supabase direction and fault matrix remains
the explicit Phase 9 certification gate before production decommissioning.

The implementation follows the official S3 client and PostgreSQL dump/restore
contracts:

- <https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html>
- <https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/>
- <https://www.postgresql.org/docs/current/app-pgdump.html>
- <https://www.postgresql.org/docs/current/app-pgrestore.html>

## Phase 6 entry point

Phase 6 can now expose separate UI actions for attaching an existing database,
moving PostgreSQL, changing only PostgREST, moving both components, viewing
transfer status, cancellation, retry, and separately approved retained-source
cleanup. It must use these Settings/Maintenance operations rather than editing
active connection records directly.
