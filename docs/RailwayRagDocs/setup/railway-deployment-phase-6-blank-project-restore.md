# Railway Deployment Phase 6: Blank-Project Restore

Last reviewed: 2026-08-06.

Phase 6 makes an archive usable. A backup nobody has restored is an untested
artifact, so this phase adds the operation that turns one into a running
installation: inspect an archive, prove it belongs here, refuse if it does not,
and otherwise write it back exactly as it was.

**Status.** Implemented. The gate is a restore of installation A's archive into
a blank installation B, which needs two live installations and has not been run
yet.

## What A Restore Is

An archive carries rows and stored objects from a different installation. A
restore puts them here without renaming anything: the same primary keys, the
same relationships, the same bucket paths.

Identity is preserved rather than regenerated, and that is a decision worth
stating. Every relation in the archive is expressed as an id. A restore that
assigned new ones would have to rewrite each reference to them, and would
silently break any id an outside system had recorded — a Bubble application
holding document ids, an integration holding a library id. Preserving them keeps
those references true.

## The Order

Everything that can refuse the restore runs before anything is written.

1. **Inspect.** Read the archive's sidecar manifest, not the archive.
2. **Check compatibility.** Format version, migration head, and every table the
   archive carries against the schema here.
3. **Check blankness.** Count the rows in every table that must be empty.
4. **Take the barrier.** `maintenance_mode` becomes `restore_requested`, then
   `quiesced`.
5. **Import.** One pass over the archive, rows then objects, in the order tar
   wrote them.
6. **Reconcile.** Compare what arrived against what the manifest promised.
7. **Release the barrier**, from a `finally` block, on every path.

Once step 5 begins there is no undo, which is why steps 1 to 3 exist. The last
safe moment to say no is before the barrier goes up.

### Inspection reads the sidecar

The manifest inside the archive is written last, because it commits to
everything before it. Answering "what is in this backup?" from the archive would
therefore mean downloading and decompressing all of it. The copy written beside
the volumes is a few kilobytes and says the same thing, plus the finished
archive's digest.

That is what makes inspection safe to offer as a button. It reads, it costs
almost nothing, and nothing about pressing it commits an operator to anything.

## What "Blank" Means

Not "every table is empty". A freshly migrated installation seeds a default
tenant, project and silo, a model configuration, and around fifty runtime
settings. An installation that satisfied "every table empty" would be one the
migrations had never run against.

What must be empty is anything a person made: documents and everything derived
from them, libraries, conversations, extraction work, usage history, API keys.
Configuration is allowed to hold its seeded defaults and is replaced by the
archive's, because configuration is data the archive is carrying.

`admin_users` is deliberately not on the list. Reaching the restore screen means
being signed in as an administrator, so an installation that could satisfy that
rule could not have asked for the restore.

## What Does Not Travel

| Not restored | Why |
| --- | --- |
| `platform_installations` | Identifies this installation, and holds the barrier the restore is running under. |
| `platform_migration_checksums` | This installation pinned its own when it migrated. That record is the truthful one. |
| `supabase_connection_events` | Connection changes made against the source project, which never happened here. |
| `platform_maintenance_operations` | An audit log of operations performed elsewhere, including the backup itself. |

Each is a fact about an installation rather than data an installation holds.
Importing them would replace this installation's history with somebody else's.

### Credentials

The export removes them, so the import has to produce something for the columns
that are `not null`. What it writes is a value prefixed `restore-unusable$`: no
password verifies against it, no key hashes to it, and anyone reading the column
can see what happened without consulting this document.

This is not the placeholder the export deliberately avoids. An exported
placeholder would restore as a value that merely looks wrong. These are
generated at restore time, in the installation that needs them, and are the
honest record that the credential did not travel.

On top of that:

- Restored administrators arrive **inactive**. An account that could not be used
  but looked available would send someone hunting for a login fault.
- Restored API keys arrive **revoked**, with their metadata intact so an operator
  can see which integrations need reissuing.
- Model provider configurations arrive complete but keyless: the secrets live in
  the source project's vault and are never exported. The restore says so in its
  findings rather than leaving it to be discovered at the first ingestion.

### Getting back in

Leaving accounts unusable is only half an answer, so both have a way forward.

**Administrators.** Configuration → Administrators lists every account, marks
the ones that arrived in a restore, and can set a password and reactivate in one
step. Two rules are enforced on the server, not in the browser: nobody can
deactivate their own account, and the last active administrator cannot be
deactivated at all. Either would leave an installation whose only way in is
rotating `ADMIN_SETUP_TOKEN` on Railway and re-running setup.

Before this screen existed, that rotation *was* the procedure. It still works
and is still the answer if every administrator is locked out at once.

**API keys.** There is deliberately no way to un-revoke one. The secret was
never exported, so clearing `revoked_at` would produce a key that authenticates
nothing while looking live — worse than the state it replaced. Revoked keys are
listed instead, under **Retired keys** on the dashboard, marked `restored` when
they came from an archive. The operation is to create a replacement with the
same name and permissions and hand it to whatever was using the old one.

That list is the reason the metadata is kept at all. An earlier version of this
work revoked restored keys and then hid them, because the keys endpoint filtered
revoked rows out — which made the sentence above this one false.

## The Import

One pass. Tar is sequential, and the exporter writes tables in the dependency
order the contract fixes, so rows arrive in an order that satisfies foreign
keys. The importer also asks Postgres to disable triggers for its own session,
which removes the dependency on that order entirely — and when the connection is
not allowed to, it says so in the findings and proceeds, rather than failing on
a constraint halfway through.

Rows are written in batches, and a batch that fails is retried row by row so the
report can name the rows that were rejected instead of the range they were in.

Two details that are easy to get wrong and were:

- **Arrays.** `["a","b"]` read out of a `text[]` column and out of a `jsonb`
  column look identical in the archive. The column's type decides which is which,
  because guessing from the value gets one of them wrong every time.
- **Content types.** The archive records each object's media type in the storage
  manifest, which tar places *after* the objects. Rather than download the whole
  archive twice for a header value, the type is derived from the file extension
  on the way in, and anything the manifest later disagrees with is reported.

Objects are buffered one at a time. The export streams without ever holding a
whole object; the import cannot match that, because Supabase's upload endpoint
wants a body it can measure. Peak memory is therefore the largest single stored
object — the same bound the original upload had.

## After The Import

A restored queue is the sharp edge. Jobs that were queued or running when the
backup was taken arrive marked as claimed by a worker in another installation,
and nothing here would ever finish them. They are returned to the queue and the
count is reported.

Re-embedding is offered and **off by default**. Embeddings travel in the archive
and the model configuration that produced them travels with them, so they are
usually correct on arrival. The case for re-embedding is a deliberate model
change after restoring, not the restore itself.

## Consent

The roadmap asks for a destructive-action confirmation. The phrase
`RESTORE THIS INSTALLATION` has to be typed exactly, and the button that starts a
restore does not appear until the archive has been inspected and the result
shown.

A confirmation given without seeing what is being agreed to is not consent, it is
a click. Every restore records the phrase that was typed, whether the target was
blank at that moment, and every finding, in `restore_jobs` and
`restore_job_findings`.

## One Phase 5 Repair

Verification could not read an encrypted archive. It concatenated the volumes and
handed them straight to the verifier with no decryption step, so an encrypted
archive would have been reported as unreadable — indistinguishable from a corrupt
one. Verification now takes the passphrase the same way a restore does. The
salt, IV and key fingerprint were already in `volumes.json`; they are not secret,
and are useless without the passphrase.

## Verification

```powershell
pnpm test
pnpm docs:check
```

Thirty-one tests cover this phase. The restore tests cover preflight refusal on a non-blank target, a
mismatched schema, a missing archive and a missing key; id-preserving import;
array and JSON handling by column type; regenerated credentials and the inactive
administrator that follows; skipped tables; object restoration and digest
mismatch; queue recovery; and volume concatenation order. Archive fixtures are
built with the real writer, so what the importer reads is what the exporter
produces. The administrator tests cover the two lock-out guardrails, that a
summary never carries a hash, and that a restored account comes back in one
step.

## Not Yet Complete

- **The gate itself.** A backup from installation A restored into a blank
  installation B, with matching table counts and object hashes, followed by
  ingestion, download, RAG, Ask, Extraction, Task, library and API smoke tests.
  This needs two installations and is the next thing to run.
- **Restoring an archive an installation did not take.** The Backups screen lists
  from this installation's own `backup_jobs` table, so an archive from elsewhere
  has to be restored by pasting its backup id. That is deliberate for now: the
  bucket is the only place the two installations meet.
- **Scheduled backups, retention, drills and the logical-dump mode.** Phase 7.
