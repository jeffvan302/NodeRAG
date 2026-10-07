# PostgreSQL/PostgREST Portability Phase 2: Provider-Neutral Schema Engine

Status: complete on 2026-08-28.

Phase 2 moves schema-package ownership and per-destination upgrade state into
the encrypted Settings control plane. Maintenance is now a replaceable
executor: it receives one short-lived envelope, verifies that it understands
the package, inspects one target, executes only the selected provider tracks,
and reports every transition back to Settings.

## Release package and provider tracks

The release descriptor now emits immutable schema-package format 2. It retains
the original 107 checked-in migrations and SHA-256 ledger while assigning them
to explicit tracks:

- `core` contains provider-neutral application, RAG, vector, policy, and RPC
  schema;
- `supabase_resources` contains the historical Supabase Storage and Vault
  resource migrations;
- `supabase_data_api` is reserved for Supabase Data API integration; and
- `railway_postgrest` contains Railway role, compatibility, secret-projection,
  and final grant migrations.

The global package order is immutable. A target selects a stable ordered view
of that package rather than renumbering migrations. Supabase selects the core
and Supabase tracks and retains its 107 existing migration checksums. Railway
selects the core and Railway tracks, producing 108 ordered steps because it
adds the compatibility prelude, Settings-only legacy-secret projection, and
final PostgREST grant step while omitting the two Supabase resource steps.

The release package includes a compatibility manifest for Railway PostgreSQL,
Supabase PostgreSQL, and compatible external PostgreSQL. Each profile declares
its minimum PostgreSQL version, extensions, roles, functions, role-management
authority, and whether Supabase Storage or Vault resources are required.

## Settings control plane

Settings remains the durable source of truth for:

- content-addressed release schema packages;
- the selected database destination and encrypted owner credential;
- each destination's observed head, schema fingerprint, and applied checksum
  ledger;
- approved data-plane upgrade operations and attempts;
- the issued envelope identity and package binding; and
- append-only inspection, plan, progress, verification, and result events.

Maintenance requests a private execution envelope using its engine version and
supported package-format list. Settings refuses an unsupported or older engine,
an unapproved operation, a missing/mismatched credential, a package without the
target provider manifest, or a populated target without a verified backup.

An envelope is valid for ten minutes and binds one operation attempt to one
database destination, one credential fingerprint, one immutable package, one
provider track set, and the expected source/target schema evidence. Repeated
requests for the same running attempt reproduce the same envelope. A retry
requires the operation state machine to start a new attempt.

Maintenance reports strictly increasing sequence numbers. Settings rejects a
report for another envelope, destination, package, checksum, or attempt. A
successful final report independently persists the destination's complete
ledger and fingerprint before marking its schema current. Maintenance can be
replaced between reports because the operation, checkpoints, package, and
target state do not live only in its process or in the moving database.

## Maintenance execution engine

The Phase 2 engine performs these steps:

1. Request and revalidate the Settings envelope.
2. Inspect PostgreSQL version, extensions, roles, public functions, Supabase
   resource presence, schema fingerprint, and the target checksum ledger.
3. Classify the target as blank, known behind, current, known ahead, drifted,
   or unrecognized.
4. Construct only the missing ordered prefix for the selected provider.
5. Refuse automatic work for ahead, drifted, unrecognized, incompatible, or
   insufficiently backed-up targets.
6. Take the schema advisory lock and commit each transactional migration with
   its history/checksum evidence.
7. Synchronize earlier checksums once the target ledger exists.
8. Re-inspect and require current schema, matching checksums, roles, functions,
   RLS/resources, and capabilities before reporting success.

Ordinary web and worker requests never receive the database owner credential
and never invoke this engine. Phase 1's maintenance barrier continues to make
runtime database calls return an explicit maintenance response.

## Railway compatibility and secret boundary

The Railway track defines `anon`, `authenticated`, `service_role`, and
`authenticator` roles for the later private PostgREST service. The final step
grants the service role access to application tables, sequences, and RPCs,
revokes relational/RPC access from the untrusted roles, and establishes the
same defaults for future objects. Application RLS remains enabled.

Historical migrations referred to Supabase Storage catalog tables and Vault
functions. The Railway compatibility layer supplies only the relational shapes
needed to replay that immutable history. It stores no object bytes and no
usable secret value. Legacy provider-secret functions return no secret or fail
with a Settings-owned message. Current web and worker secret reads already use
the encrypted Settings service; Supabase Vault remains a legacy import source
only.

Storage-resource verification is conditional. A Supabase database must prove
its Storage and Vault resources; a Railway database is verified against its
PostgreSQL/PostgREST capabilities and independently configured object
destination.

## Acceptance coverage

Automated tests cover package-format and engine negotiation, provider-track
selection, checksum drift, ordered known-head play-forward, conditional
resources, envelope binding/expiry/tamper detection, Settings report ordering,
per-destination final state, and Maintenance's complete transition stream.

The checked-in fixture catalog includes blank, representative Phase 0-era, and
current heads for both Railway and Supabase plans. In addition, the complete
Railway track was applied from empty to disposable PostgreSQL 16 with pgvector:
all 108 selected migrations succeeded, 113 public tables were created, all 113
had RLS enabled, all four PostgREST roles existed, and the compatibility Vault
table contained no secret-value column.

The persistent Railway database is now implemented in
[Phase 3](railway-postgres-postgrest-portability-phase-3.md). The private
PostgREST service remains Phase 4.
