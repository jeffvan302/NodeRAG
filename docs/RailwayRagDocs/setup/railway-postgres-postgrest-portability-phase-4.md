# PostgreSQL/PostgREST Portability Phase 4: Railway PostgREST

Status: complete on 2026-08-28.

Phase 4 adds a private, sleep-capable PostgREST service in front of the Phase 3
Railway PostgreSQL database. It proves that the platform's shared runtime client
can execute relational and RPC operations through local PostgREST without using
the Supabase Data API. The local pair remains a candidate; Phase 4 does not
silently replace an active route or object-storage destination.

## Railway service contract

The template is version 3 and contains eight services. `postgrest` builds
`Dockerfile.postgrest`, which copies the PostgREST 14.16 binary from a
digest-pinned official image into the repository-owned Node supervisor image.
The service:

- has no public networking or persistent volume;
- connects only to the private Railway PostgreSQL service;
- listens on port 3000 through the supervisor while the PostgREST API and admin
  server remain loopback-only on ports 3001 and 3002;
- uses `/health/live` for process diagnostics and `/health/ready` for the
  Railway deployment gate;
- enables Railway Serverless sleep; and
- retries Settings/PostgreSQL startup while the other sleeping services wake.

Railway generates `POSTGREST_AUTHENTICATOR_PASSWORD` and
`POSTGREST_JWT_SECRET` once at environment scope. Only the supervisor receives
the authenticator password. PostgREST and Maintenance receive the JWT root.
Settings receives neither root.

## Authentication and exposed schemas

The Phase 2 Railway provider migrations own the `authenticator`, `service_role`,
`authenticated`, and `anon` roles and the application grants. On startup the
supervisor uses the PostgreSQL owner connection only to enable the fixed
`authenticator` login, rotate its generated password, and confirm its
`service_role` membership. PostgREST then uses the authenticator connection.

Maintenance derives a stable HS256 token with only these claims:

```json
{ "iss": "bubble-rag-postgrest", "role": "service_role" }
```

The signed token is encrypted in Settings as the data-API credential. The JWT
root is never transmitted as a bearer token or persisted in Settings. No
anonymous database role is configured, and the Railway migrations revoke
application relational/RPC access from `anon` and `authenticated`.

The narrow Settings configuration endpoint returns only the registered local
database ID, safe host, required migration head, database identity, expected
checksum count, schema state, explicit exposed-schema list, and configuration
revision. The default exposed list is `public`. System, Supabase-internal,
storage, vault, auth, and extension schemas are rejected.

## Startup and registration

Maintenance reconciliation is ordered:

1. provision or verify Railway PostgreSQL through the Phase 3 flow;
2. ask the supervisor to reload the PostgREST schema cache;
3. call `get_platform_readiness` through the signed service-role token;
4. require the PostgREST response to match Settings' database identity,
   migration head, and provider checksum count; and
5. register or confirm the fixed Railway PostgREST candidate.

A changed endpoint, token, PostgREST version, identity, or exposed-schema list
is not overwritten by bootstrap. It requires the later audited rotation or
cutover operation. A partial PostgREST Settings record is also refused.

PostgREST listens for `NOTIFY pgrst, 'reload schema'`. The Maintenance schema
engine sends that notification after ledger synchronization, and the
supervisor exposes an authenticated `POST /-/reload` operation. When the
exposed-schema configuration changes, the supervisor restarts the child with
the new explicit list; otherwise it requests an in-process schema-cache reload.

## Readiness and failure behavior

`/health/live` reports whether the supervised child is running. It does not
claim database readiness. `/health/ready` delegates to PostgREST's admin
`/ready` endpoint, which remains unavailable until the connection pool and
schema cache are usable. API requests receive `503` while the child is starting
or unavailable.

Startup retries Settings and database-role configuration for one minute. Once
PostgREST starts, its own pool recovery continues handling a temporarily
sleeping database. Reload waits through the asynchronous schema-cache handoff
before reporting success.

## Acceptance gate

Run:

```text
pnpm test:railway-postgrest
```

The disposable test builds both pinned images, provisions the complete Railway
schema through the actual Settings/Maintenance engine, starts the real
supervisor/PostgREST container, and verifies:

- supervised liveness/readiness and a real PostgreSQL connection;
- denial of anonymous and tampered-token requests;
- signed `service_role` JWT access;
- matching installation identity, migration head, and all 108 provider
  checksums;
- relational and RPC calls through `createDataPlaneClients`; and
- creation, grant, notification, and discovery of a new relation through live
  schema-cache reload.

The test uses uniquely named temporary containers, images, network, volume, and
Settings database, and removes only those resources on success or failure.

PostgREST configuration follows the official environment-variable,
authentication, schema, listener, and admin-server contracts:

- <https://docs.postgrest.org/en/latest/references/configuration.html>
- <https://postgrest.org/en/stable/references/auth.html>
- <https://postgrest.org/en/stable/references/api/schemas.html>
- <https://postgrest.org/en/stable/references/listener.html>
- <https://docs.postgrest.org/en/latest/references/admin_server.html>

## Phase 5 entry point

Phase 5 may now use a verified local database/API candidate in the S3-required
database transfer state machine. It remains responsible for the maintenance
barrier, source backup, target analysis and approval, restore, verification,
atomic route activation, retry checkpoints, and separately confirmed old-source
cleanup.
