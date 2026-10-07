# PostgreSQL/PostgREST Portability Phase 8: Template Release

Implemented: 2026-08-28.

Phase 8 packages the portability work as Railway template version 4 and closes
the fresh-install and prior-template upgrade gaps.

## Implementation

- The canonical template contains eight services, including private sleeping
  `postgres-sql` and `postgrest` services and a 5 GB PostgreSQL volume.
- PostgreSQL 16 with pgvector and PostgREST 14.16 are digest-pinned. Release
  metadata is checked against the Dockerfiles.
- All repository-built services and update notifications track `main`.
- The generated variable sheet and TypeScript template module are checked for
  drift in `docs:check`.
- A versioned upgrade contract preserves the original six services and five
  shared variables while adding exactly the local data-plane services and
  variables.
- Local PostgreSQL bootstrap treats a newer migration head as a play-forward
  operation for its registered volume. Credential or provider changes still
  fail closed.
- Settings exposes setup readiness and activation operations. It activates the
  verified local pair only when no route already exists.
- The setup wizard verifies independent Supabase Storage server-side, stores
  its credential in encrypted Settings, activates route revision 1, and then
  allows first-administrator creation.
- An installation with an active remote route receives the local services as
  candidates; startup cannot silently replace that route.
- Release CI runs template-upgrade checks, retained migration fixtures, empty
  PostgreSQL provisioning, and local PostgREST acceptance.

## Fresh-install contract

```text
Railway PostgreSQL -> Railway PostgREST
                  + independently configured Supabase Storage
```

Supabase Storage remains necessary for document objects until another object
provider client is implemented. It does not move relational data to Supabase.
S3-compatible backup storage is separate: object storage serves the application,
while S3 is the mandatory transfer/backup staging destination.

## Upgrade notes

For a version 1 six-service deployment:

1. Apply the template update so Railway adds `postgres-sql`, `postgrest`, their
   volume, and generated credentials.
2. Keep the current remote route active. No backup is needed merely to install
   inactive local services.
3. Let Maintenance register and provision the blank local candidate.
4. Use Attach Existing to reconnect without copying or deleting data.
5. Use Transfer Database only when moving records; it remains blocked until
   encrypted S3 storage passes its probe.

For an active local database, a release with additional migrations updates the
required head and queues an ordered schema-upgrade operation. The retained
ledger and checksums decide what remains to run; older application versions are
not supported as a steady-state target.

## Acceptance boundary

Repository automation proves structure, schema play-forward, empty-volume
provisioning, PostgREST identity/readiness, runtime activation, and
non-destructive upgrade policy. Phase 9 owns live Railway certification: sleep
observation, template update visibility, full ingestion/search/backup, all
transfer directions, failure injection, and separately approved source cleanup.
