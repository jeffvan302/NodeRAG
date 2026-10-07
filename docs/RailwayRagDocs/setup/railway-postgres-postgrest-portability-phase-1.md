# PostgreSQL/PostgREST Portability Phase 1: Runtime Separation

Status: complete on 2026-08-28.

Phase 1 separates the three capabilities that the original Supabase client
implicitly obtained from one project URL and service-role key:

- direct PostgreSQL identity and schema evidence;
- PostgREST relational queries and RPCs; and
- object operations through Supabase Storage.

The existing Supabase profile remains supported. Its verified connection is
materialized in Settings as separate database, Data API, and object destination
records and then bound by active route revision 1. A later credential rotation
may update the same verified destination identities. Selecting a different
database still requires the explicit attachment or transfer workflow; it cannot
become active through a normal connection edit.

## Runtime contract

Settings exposes one private, authenticated runtime snapshot. The snapshot
contains:

- the complete active route and monotonic revision;
- the selected database destination without its direct connection secret;
- the selected PostgREST destination and its scoped runtime credential; and
- the independently selected object destination and its scoped credential.

The snapshot is parsed and fingerprint-checked as one unit. Web and worker do
not read the route, destinations, and credentials through separate requests,
so they cannot accidentally combine values from two route revisions.

No runtime snapshot is issued while the maintenance barrier is closed. Web
returns `database_offline_for_maintenance` with HTTP 503 for database API
requests during that interval. Worker waits or stops before claiming additional
work.

## Client boundary

The shared client factory creates:

1. a standalone PostgREST client for `.from()`, `.rpc()`, and `.schema()`;
2. a Supabase Storage client created only from the object destination; and
3. a transitional facade that preserves the existing call-site surface while
   routing those capabilities to the two independent clients.

Every PostgREST and object request carries the active route revision in the
`x-data-plane-route-revision` header. Worker writes the full route snapshot into
the progress metadata of processing and template-ingestion jobs when they are
claimed. Its process remains bound to the same client snapshot for the entire
job and compares the Settings runtime fingerprint before another claim. A
route change therefore causes a restart boundary instead of redirecting half
of a job.

## Verification and upgrade behavior

A Supabase route is activated only after all of the following read-only checks
pass:

- project URL, service credential, and PostgreSQL URL identify the same
  Supabase project;
- the Data API and Storage endpoints accept the credential;
- Maintenance reaches PostgreSQL in a read-only session and reads the singleton
  installation identity, migration head, checksum count, server version, and
  advisory-lock state;
- PostgREST returns the protected readiness record; and
- direct PostgreSQL and PostgREST report the same installation identity,
  migration head, and checksum count at the release-required head.

An old, ahead, unavailable, or mismatched schema is reported as a connection
failure. The web request never sends migration SQL and never invokes an
owner-level migration. Phase 2 gives Maintenance the provider-neutral package
execution path that can resolve a recognized schema mismatch.

## Compatibility path

An installation upgraded from a release before Phase 1 may temporarily read
its legacy encrypted `connections/supabase` record until an active route has
been verified and saved. This is only a bridge that keeps setup and the
existing Supabase profile available. Once the active route exists, runtime
traffic cannot fall back to that record, including during maintenance.

## Acceptance coverage

Automated coverage proves that:

- relational and storage operations reach different configured hosts;
- route-revision headers and job snapshots are present;
- mixed-route runtime snapshots and credential fingerprints are rejected;
- schema mismatch is reported by a single read-only probe without upgrade
  execution;
- Settings bootstrap is atomic, secret-redacted in its response, idempotent,
  and current-schema-only;
- Settings refuses runtime configuration during maintenance; and
- the existing web and worker Supabase query suites pass without behavioral
  changes.

No database schema migration is introduced by Phase 1. The checked-in release
head and its 107 migration checksums remain unchanged.
