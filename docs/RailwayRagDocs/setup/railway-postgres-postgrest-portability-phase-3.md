# PostgreSQL/PostgREST Portability Phase 3: Railway PostgreSQL

Status: complete on 2026-08-28.

Phase 3 adds the installation-local PostgreSQL service as a private, durable,
sleep-capable Railway template component. It also connects first-start
provisioning to the Phase 2 Settings/Maintenance schema engine and proves the
complete database lifecycle against a real PostgreSQL 16/pgvector container.

PostgREST is deliberately not part of this phase. Until Phase 4 verifies a
matching local PostgREST destination, the new database remains a candidate and
cannot become an active runtime route.

## Railway service contract

The template now contains seven services. `postgres-sql` builds
`Dockerfile.postgres`, whose `pgvector/pgvector:pg16` base is pinned by image
digest. The service has:

- no public networking or TCP proxy;
- a 5 GB persistent volume mounted at `/var/lib/postgresql/data`;
- `PGDATA` below that mount so the cluster survives image replacement;
- PostgreSQL data checksums and UTF-8 enabled when an empty volume is first
  initialized;
- Railway Serverless sleep enabled; and
- an image-level `pg_isready` health check.

Railway generates `RAILWAY_POSTGRES_PASSWORD` once at environment scope.
`postgres.POSTGRES_PASSWORD` and
`maintenance.RAILWAY_POSTGRES_PASSWORD` reference that value; neither contains
a copied literal. Maintenance receives the database, owner, port, and private
host through service references. The host must end in `.railway.internal`, and
bootstrap rejects any public host.

The PostgreSQL volume is not a portable backup. Transfer and disaster-recovery
artifacts still go to independently configured S3 storage.

## First-start reconciliation

Maintenance starts its HTTP service first and performs PostgreSQL
reconciliation asynchronously. This keeps its health endpoint available while
the new database initializes. Reconciliation then:

1. validates that the six local PostgreSQL bootstrap variables are either all
   present or all absent;
2. retries the private connection while PostgreSQL starts;
3. reads the server version, public table count, extension availability, data
   checksum state, and recovery/read-only state;
4. asks Settings to encrypt and register the owner connection as the fixed
   local Railway database candidate;
5. creates or resumes the fixed provisioning operation; and
6. executes the immutable Railway schema track through the Phase 2 engine.

Settings persists the final database installation identity, migration ledger,
schema fingerprint, PostgreSQL version, extensions, and readiness evidence. No
bootstrap response or log contains the connection string or password.

The automatic path is intentionally narrow. A blank unregistered volume may be
provisioned. A populated database that Settings has never registered is
refused with an attach-existing instruction; bootstrap will not guess that it
owns or may modify those records. Repeated startup with the same credential and
release is idempotent. A changed password requires the audited credential
rotation path.

## Backup and restore compatibility

The Maintenance image now installs PostgreSQL client 17 from PostgreSQL's PGDG
repository. A PostgreSQL 17 client can dump the template's PostgreSQL 16 server
and current PostgreSQL 17 remote services.

Before a logical dump, Maintenance compares the `pg_dump` major version with
the source server. The dump sidecar records both versions. Restore preflight
also checks that:

- `pg_restore` is at least as new as the client that produced the archive; and
- the target server is not older than the source server.

Restore arguments fail on the first SQL error, use one transaction, and omit
source ownership and privileges. Credentials remain in libpq environment
variables and never appear in the process argument list.

This phase provides compatible database tooling and a full container
acceptance test. The operator-facing S3 database-transfer state machine remains
Phase 5; Phase 3 does not permit a transfer without S3 or add target cleanup.

## Acceptance gate

Run:

```text
pnpm test:railway-postgres
```

The disposable test builds the digest-pinned database image, initializes a new
persistent volume, runs the actual Settings bootstrap and Maintenance schema
operation, and verifies:

- all 108 ordered Railway migrations and all 113 application tables;
- the singleton installation identity and current migration head;
- a real pgvector distance operation;
- a custom-format logical dump and restore into a second database; and
- source and restored records after a PostgreSQL container restart using the
  same volume.

The test owns uniquely named temporary containers, images, volumes, and the
temporary Settings database and removes only those resources on success or
failure. The normal package tests, platform contract, generated template, and
documentation gates remain required as well.

## Phase 4 entry point

Phase 4 adds the private PostgREST service, its scoped roles/JWT configuration,
schema reload and readiness behavior, and relational/RPC contract tests. Only
after direct PostgreSQL and PostgREST report the same installation identity can
the local pair be activated as a runtime route.
