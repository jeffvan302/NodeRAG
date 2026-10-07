# PostgreSQL/PostgREST Portability Phase 6: Independent Data API Cutover

Status: complete on 2026-08-28.

Phase 6 makes PostgREST an independently selectable data-plane capability. An
operator can switch Railway PostgREST and a provider PostgREST endpoint over
the same remote PostgreSQL database without a database dump, S3 transfer,
restore, maintenance barrier, or data interruption.

## Candidate and compatibility rules

Settings stores endpoint credentials as immutable encrypted secrets and returns
only safe destination metadata to the website. Saving a candidate never changes
the active route. The same placement matrix is enforced by the UI and Settings:

- local PostgreSQL permits local Railway PostgREST only;
- remote PostgreSQL permits local Railway PostgREST;
- Supabase PostgREST requires its linked Supabase PostgreSQL destination; and
- every candidate must reference the active database before it can be analyzed.

The Configuration page now has a top-level **Database** area with separate
PostgREST, PostgreSQL, and Transfer Database rows. Supabase no longer appears as
a generic model-provider access point or standalone connection panel. The page
also distinguishes Provision, Attach Existing, Move Database, Move Both, Switch
PostgREST, and Decommission as separate actions with different safety rules.

## Read-only analysis

Maintenance compares the active and candidate endpoints concurrently. Each
endpoint must pass four read-only probes:

1. an authenticated query of the installation singleton;
2. the protected `get_platform_readiness` RPC;
3. the same installation query without credentials, which must be rejected;
4. the OpenAPI contract for the installation table and readiness RPC.

Volatile readiness timestamps are removed before comparison. Maintenance then
compares normalized query and RPC hashes, row counts, protected authorization
behavior, the selected OpenAPI surface, installation identity, migration head,
and migration-checksum count. The authenticated query and RPC are also the
shadow-read pair. Any difference blocks the operation.

Settings stores the result as an immutable ten-minute analysis. Its fingerprint
binds the active route revision, permanent database identity, destination ID,
provider, URL, credential fingerprint, database link, observed identity, schema
head, checksum count, and exposed schemas. Endpoint edits or a route change
invalidate the analysis.

## Approval and online activation

Even though the switch is non-destructive, route activation requires recent
administrator re-authentication, the exact analysis-bound confirmation phrase,
and `activate_route` approval. Maintenance obtains a short-lived execution
envelope and repeats every endpoint comparison immediately before activation.

On success, Settings performs one local transaction that:

- records fresh target identity, version, schemas, and health evidence;
- marks the candidate endpoint active;
- advances the active route by exactly one revision while changing only the
  Data API destination ID;
- leaves the database destination, object destination, and open maintenance
  barrier unchanged;
- keeps the former endpoint as an available inactive candidate; and
- completes the audited `switch_data_api` operation and event.

A failure leaves the prior route authoritative. No backup or transfer artifact
is created, and the database is never taken offline. Reversing direction uses
the same workflow and the same database identity proof.

## Interfaces and checks

Settings exposes redacted configuration state, inactive candidate save,
candidate envelopes, immutable cutover creation, approval, queue, execution
envelope, and report contracts. Maintenance exposes signed analyze and run
actions. The website delegates to those services and never probes endpoints or
changes route records directly.

Run:

```text
pnpm --filter @bubble-rag/rag-core test
pnpm --filter @bubble-rag/settings test
pnpm --filter @bubble-rag/maintenance test
pnpm --filter @bubble-rag/web test
pnpm platform:check
```

Tests cover endpoint parity and mismatch blocking, approval-bound activation,
an unchanged database/object binding, an open maintenance barrier, a single
route revision, and the absence of transfer artifacts.

## Phase 7 entry point

Phase 7 can now make local service activity route-aware. When Supabase
PostgREST is active, the Railway PostgREST service is an unused candidate and
must receive no keep-alive; when Railway PostgREST is selected, its wake and
idle lifecycle follows the active lease.
