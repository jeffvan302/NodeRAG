# Milestone 3 — Database, Identity, Authorization, Readiness, and Audit Record

Status: local gates passed; remote certification pending

Recorded: 2026-09-04

Evidence environment: Windows/WSL 2, Docker Desktop, and GitHub Actions; not DSM

Certification ceiling: `testbed-complete`

## Outcome

Milestone 3 establishes the security and durability boundary that every content
feature will use. The repository now has the complete initial relational shape,
transactional silo partitions, exact three-capability authorization, forced
row-level security, one-time first-run bootstrap, password and bearer identity,
encrypted provider-secret storage, readiness gates, durable job claims,
idempotency, privacy-preserving audit records, and machine-readable API policy.

The implementation deliberately stops before content ingestion. M04 can build a
Markdown vertical slice without inventing new identity, silo, build-provenance,
source-presence, or purge fields. Destructive production silo purge remains
disabled until M05 proves locator and cleanup behavior. No result in this record
claims that Synology DSM has executed the package.

## Migration and durable data model

`000002_identity_foundation.sql` is a forward-only migration with SHA-256
`ce6c98fea8603e0823544255408f4d5bd4a50ee360430f55e2ffc92327753cc3`.
It advances the recorded head to `000002_identity_foundation` and creates the
following durable domains under the `noderag` schema:

| Domain            | Tables and contract                                                              |
| ----------------- | -------------------------------------------------------------------------------- |
| Tenancy           | `silo` and independent `silo_grant` rows for read, upload, and delete            |
| Principals        | `principal`, `app_user`, `api_key`, and hashed `session` records                 |
| Secrets           | AES-GCM `encrypted_secret` envelopes; root key remains outside PostgreSQL        |
| Models/builds     | `model_manifest`, `settings`, `build`, and `silo_build_state`                    |
| Sources/content   | `source`, `document`, `document_page`, `document_image`, and partitioned `chunk` |
| Durable work      | `job` and append-only `job_event` rows with lease/attempt fields                 |
| Reuse caches      | generic-dimension `embedding_cache` and `vision_cache`                           |
| External access   | `gateway` scope and encrypted configuration reference                            |
| Controls/evidence | `audit_log`, `idempotency_record`, and singleton `setup_state`                   |

Source scheduling and health stay on the source because different sources in a
silo can have different clocks and failures. Documents preserve source-relative
locators, original/normalized/Markdown hashes, normalization version, presence,
missing time, and extraction state. Pages and images preserve one-based page
identity, zero-based offset ranges, dimensions, content hashes, and binary
locators. Those fields are created before ingestion so later migrations cannot
silently redefine already-indexed provenance.

Build rows preserve snapshot time, rules version, model-manifest reference,
query prefix, dimensions, state, and activation provenance. The active settings
row refers to the pinned Qwen3-Embedding-0.6B model manifest without presenting
the model as bundled. The reusable embedding cache uses unindexed generic
`halfvec` with explicit dimensions. Active chunks use typed `halfvec(1024)` so
their HNSW index has a fixed operator-compatible dimension.

## Silo creation, partitioning, and isolation

`createSilo` performs one transaction for the silo row, the creator's three
initial grants, a range partition named from the validated numeric silo ID, its
HNSW vector index, GIN search index, document locator index, and direct-partition
RLS. A partial failure rolls back the whole unit. Identifiers are produced only
from database integers and are never accepted as caller SQL fragments.

`purgeSilo` exists so the destruction design is tested early, but rejects every
normal call. Only an explicit test flag can exercise the transaction that drops
the chunk partition and silo data. M05 owns production enablement after source,
file, cache, and audit cleanup are proven.

`SiloScope` has a private constructor. Callers obtain it only through database
resolution of an exact action. The permission mapping is:

| Action class                            | Required grant |
| --------------------------------------- | -------------- |
| list/search/view Markdown/view original | `read`         |
| create upload or source/retry/reindex   | `upload`       |
| delete document/source/silo content     | `delete`       |

All eight possible read/upload/delete combinations have executable tests.
Gateway and request scopes are set intersections over the already-authorized
IDs, so neither can grant access. A principal with no grants resolves to an
empty set. Server-administration checks are separate from silo capabilities.

RLS is enabled and forced for source, document, page, image, the chunk parent,
and each directly addressed chunk partition. The transaction helper sets the
authorized silo-ID session variable locally and clears it at transaction end.
Integration tests prove permitted reads, cross-silo denial, parent-table
isolation, and direct-partition isolation.

## Password and session identity

`hash-wasm` 4.12.0 provides a portable, bundled Argon2id implementation without
a native addon ABI dependency. Password verifiers use Argon2id v19, 64 MiB,
two iterations, one lane, a random 16-byte salt, and a 32-byte result. Unknown
and disabled accounts consume comparable verification work and share the same
external invalid-credentials response. Failure counters and increasing lockout
times are durable. The singleton setting can disable all password login.

Password change verifies the current password under a row lock, writes the new
verifier, clears failure state, revokes every active session, and records the
audit event in one transaction. The HTTP route adds authenticated browser
session, trusted Origin, CSRF, operational-readiness, and `Idempotency-Key`
requirements. Its password request is represented in the idempotency table only
by SHA-256; plaintext never leaves process memory.

Session and CSRF values are derived from independent 32-byte random values.
Only session SHA-256 is stored. Validation enforces revocation, disabled-user
state, idle/sliding expiry, and an absolute expiry ceiling. Successful activity
extends only the sliding boundary. Cookies are HttpOnly, SameSite=Strict,
path-scoped, and Secure when configured. Browser mutations must present both a
matching CSRF value and the exact configured Origin.

## API keys and provider secrets

API keys use the `nrag_` namespace, an eight-character display prefix, and 43
base-62 random characters—slightly more than 256 bits of material. Creation is
administrator-only and returns the key once. PostgreSQL retains SHA-256, display
prefix, optional expiry, CIDR list, per-minute limit, search-only flag, last-used
time, use count, revocation time, and the owning principal.

Authentication verifies constant-time digest equality after indexed lookup,
expiry and revocation, IPv4/IPv6 CIDR membership, and an in-process minute
bucket. Search-only keys are additionally narrowed to the small read action set;
they cannot retrieve full Markdown or originals and cannot mutate data or
administration. The rate limiter is intentionally process-local at this stage
because NodeRag has one DSM API process. M10 must revisit the decision if the
production topology changes.

Provider tokens use AES-256-GCM with random nonces and authenticated associated
data bound to the secret owner/name. The package-local 32-byte root key must be
a regular non-symlink file with mode 0600. Browser and API representations emit
only `{exists, fingerprint}` where the fingerprint is a short HMAC keyed by the
root; they do not emit plaintext, ciphertext, nonce, authentication tag, or key
material. Package lifecycle simulation proves the root is created securely and
persists across another installation setup pass.

## Readiness, idempotency, durable jobs, and audit

The durable setup state is one of `unconfigured`, `configuring`, `operational`,
`maintenance`, `upgrade-required`, `recovery-required`, or `unavailable`.
Readiness reports the migration head and state. The policy table always permits
health, permits only the intended setup work before configuration, and fails
closed for application mutations and worker claims unless the state is exactly
`operational`.

Workers claim jobs using a transaction, `FOR UPDATE SKIP LOCKED`, durable leases,
attempt increments, and append-only events. This produces a foundation for M05
without allowing pre-configuration work to escape into the database.

Idempotency rows are unique by principal, operation, and caller key; the request
SHA-256 is part of the validation contract. The first execution stores status,
headers, body, completion, and expiry in the same transaction as an operation
that accepts the transaction client. A matching duplicate replays the response.
Reuse with a different digest produces a conflict. Setup configuration and
logout are explicit inventory exceptions because setup has no principal yet and
logout is naturally repeatable.

Audit events hold action, result, IDs, request ID, source IP, query SHA-256, safe
detail, and time. Query normalization is Unicode NFC, collapsed whitespace,
trimmed, and lowercase before hashing. A recursive sanitizer drops credential,
authorization, cookie, token, secret, password, ciphertext, nonce, tag, query,
and raw-body-like keys. Time indexes and bounded batch deletion support the
configured age retention policy.

## Setup and route contracts

First start issues a setup token whose SHA-256 alone is stored. The public setup
surface can inspect state, verify the token, and consume it once. Consumption
creates the first user principal, server-administrator record, default silo,
partition/indexes, and three exact grants before committing `operational`.

`platform/route-authorization.v1.json` is the source-of-truth inventory for 74
planned HTTP and MCP routes. Every record names method, path, scope, route class,
CSRF requirement, idempotency requirement, search-only allowance, and—where
applicable—exact action plus empty/not-found behavior. Tests reject duplicates
and invalid policy combinations and execute every protected entry against an
unauthenticated caller, zero-grant principal, and search-only principal.

`platform/openapi.m03.json` documents the routes actually present in M03:
setup status/token/configure, login/logout/current-principal/password, silo list,
and the authenticated OpenAPI document. Future route inventory entries remain
authorization commitments, not falsely advertised HTTP implementations.

## Tests and reproducible gates

The unit suite has seven files and 14 tests. The PostgreSQL integration suite
has two files and 17 tests and uses the digest-pinned PostgreSQL 17/pgvector
image. Its identity matrix covers schema/head checks, bootstrap, partitions,
all capability combinations, RLS, passwords, sessions, API keys, secrets,
idempotency, readiness, worker claims, audit retention, purge gating, the whole
route inventory, and actual Fastify routes.

Run the complete local gate with:

```bash
corepack pnpm@11.25.0 install --frozen-lockfile
corepack pnpm@11.25.0 peers check
corepack pnpm@11.25.0 ci:quality
corepack pnpm@11.25.0 repo:check
corepack pnpm@11.25.0 test:integration
corepack pnpm@11.25.0 package:thin
corepack pnpm@11.25.0 package:verify
```

The M03 GitHub workflow separates repository quality, identity integration,
cumulative M01 Linux compatibility, and deterministic thin-package simulation.
The M02 workflow is retained as a manually runnable historical workflow so a
later change cannot silently rewrite prior milestone evidence.

Two independent M03 thin-package builds produced the same 675,840-byte archive
with SHA-256
`812a3846629cbd3d491d7b67ecf17f053d07e338deec83bbe142852edf70a038`.
The bundled server and worker SHA-256 values are respectively
`8ccedfdcf2e3e9e9088eafa0bd6444bdd717d38babdcdda449061b1f4f6cf93a`
and `47205c2b0de3b30faeff0c3fc19044c43058edb68070e6e236b380bb3377ec7f`.

## Deferred DSM mapping

M03 raises the package simulation but does not close DSM rows. Secret-root ACLs,
package-user database access, Node runtime ABI, reverse-proxy cookie/Origin
behavior, persistence across Package Center upgrade, service account isolation,
and recovery behavior remain live-device gates in
`docs/Implementation/dsm-deferred-register.md`.

## Gate state

All local M03 gates and the exact implementation commit's four GitHub jobs pass.
The milestone becomes `testbed-complete` only after the evidence-closure and
certification commits pass the same workflow and annotated tag `m03-complete`
resolves to the certification commit.
