# M03 — Database, Identity, Authorization, Readiness, and Audit Checklist

Status: testbed-complete

Environment: Docker testbed and Linux package simulation

Recorded: 2026-09-04

## Schema and migration discipline

- [x] Forward-only migration `000002_identity_foundation` is listed after M02 with its exact SHA-256 and is the expected migration head.
- [x] The migration creates silo, principal, application-user, API-key, grant, session, encrypted-secret, model-manifest, settings, build, silo-build-state, source, document, page, image, chunk, job, job-event, cache, gateway, audit, idempotency, and setup-state records.
- [x] Source rows own scheduling, last-success, last-failure, failure-count, disabled, presence, and missing-state metadata.
- [x] Documents preserve original and normalized hashes, Markdown hash, source-relative locator, presence, missing timestamp, normalization version, and extraction status.
- [x] Pages and images preserve page basis, offsets, dimensions, hashes, and locators needed by later extraction milestones.
- [x] Build profiles preserve snapshot window, rules version, model manifest, query prefix, dimensions, status, and activation provenance.
- [x] Active chunks use `halfvec(1024)` while reusable embedding-cache rows use generic `halfvec` plus an explicit dimension column.
- [x] The active Qwen3-Embedding-0.6B manifest and settings reference are seeded without downloading or pretending to bundle model assets.
- [x] PostgreSQL 17 with pgvector 0.8.6 applies both migrations twice without drift.

## Silo lifecycle and row isolation

- [x] Silo creation, exact initial grants, chunk partition creation, HNSW index, GIN index, document locator index, and direct-partition RLS are one transaction.
- [x] Silo purge is disabled by default until M05 and requires an explicit test-only flag.
- [x] The test-authorized purge drops the chunk partition and silo records transactionally.
- [x] `SiloScope` has a private constructor and can only be produced by checked resolution methods.
- [x] `read`, `upload`, and `delete` are independent booleans; no capability implies another.
- [x] Gateway scope and caller-requested scope only intersect an existing grant set and cannot widen it.
- [x] Zero grants resolve to zero silo IDs.
- [x] RLS is enabled and forced on source, document, page, image, the partitioned chunk parent, and direct silo partitions.
- [x] Cross-silo identifier guesses return not-found or empty behavior selected by the route contract.

## Passwords, users, and first-run setup

- [x] Passwords use Argon2id v19 with 64 MiB memory, two iterations, one lane, a random 16-byte salt, and a 32-byte result.
- [x] Unknown-account and disabled-account attempts consume the password-verification cost and return the same invalid-credentials result.
- [x] Repeated failures persist counters and increasing delays; a locked account is rejected before verification.
- [x] The global `login_enabled` switch disables password login without disabling health or setup-state inspection.
- [x] Password change verifies the current value, replaces the hash, clears login failures, records an audit event, and revokes every active session in the same transaction.
- [x] The live password route requires session authentication, trusted Origin, CSRF, operational readiness, and an idempotency key.
- [x] The one-time setup token is stored only as SHA-256, cannot be reused, and creates the first administrator plus default silo atomically.
- [x] Setup readiness moves through durable named states and becomes `operational` only after successful bootstrap.

## Sessions, API keys, and encrypted secrets

- [x] Session and CSRF values have 32 bytes of random input and are encoded for transport.
- [x] Only the session SHA-256 is stored; the bearer value never appears in the schema.
- [x] Sessions enforce sliding and absolute expiry, user-disabled state, explicit revocation, password-change revocation, SameSite cookie policy, CSRF, and Origin.
- [x] API keys contain an identifying prefix plus approximately 256 bits of random material and are revealed once.
- [x] Only API-key SHA-256, display prefix, constraints, and usage metadata are stored.
- [x] Expiry, revocation, IPv4/IPv6 CIDR, per-minute limit, last-used timestamp, and use count are enforced.
- [x] Search-only API keys cannot perform full-document, original-file, upload, reindex, delete, user, key, secret, or server-administration operations.
- [x] Provider secrets use AES-256-GCM with authenticated associated data under a validated 32-byte package-local root key.
- [x] Secret responses expose only existence and a short HMAC-keyed fingerprint; plaintext, ciphertext, authentication tags, and root material are excluded.
- [x] Thin-package installation creates the root key with mode 0600 and lifecycle simulation proves it persists unchanged across reinstall/upgrade setup.

## Readiness, durable work, idempotency, and audit

- [x] Readiness distinguishes `unconfigured`, `configuring`, `operational`, `maintenance`, `upgrade-required`, `recovery-required`, and `unavailable`.
- [x] Health is always readable; setup is limited to allowed pre-operational states; application mutations and worker claims fail closed outside `operational`.
- [x] Job claims use a transaction and `FOR UPDATE SKIP LOCKED`, persist attempts and leases, and append durable job events.
- [x] Idempotency is keyed by principal, operation, caller key, and SHA-256 request digest.
- [x] A completed duplicate replays its stored status/headers/body and a different digest for the same key returns conflict.
- [x] Audit events never store raw search queries; normalized query text is represented only by SHA-256.
- [x] Credential-like keys are removed recursively from audit detail before insertion.
- [x] Audit age cleanup is indexed and deletes in bounded batches.

## Route and contract controls

- [x] `platform/route-authorization.v1.json` contains 74 unique planned route entries with scope, action, route class, CSRF, idempotency, search-only, and empty/not-found policy.
- [x] Central authorization maps protected routes to authenticated, server-admin, exact silo capability, and search-only decisions.
- [x] Every planned protected route is tested unauthenticated and as a zero-grant principal.
- [x] The complete eight-case read/upload/delete capability matrix is tested.
- [x] Search-only denial is tested against every disallowed action class.
- [x] `platform/openapi.m03.json` describes the implemented M03 setup and identity surface and is available only to an authenticated caller.
- [x] Structured-log redaction includes authorization, cookies, request/response bodies, passwords, hashes, setup/session/CSRF/API tokens, ciphertext, authentication tags, secret roots, and database URLs.

## Quality and delivery

- [x] Frozen dependency install and peer-dependency validation pass.
- [x] Migration checksum, strict TypeScript, ESLint, Prettier, dependency-boundary, unit, production-build, bundle-smoke, license, secret-scan, and repository-hygiene gates pass together.
- [x] Seven unit files with 14 tests pass.
- [x] Two PostgreSQL integration files with 17 tests pass against a real pgvector container.
- [x] The thin SPK builds twice with the same SHA-256 and passes static and non-root lifecycle verification.
- [x] The implementation commit is pushed to `main` and all four M03 GitHub Actions jobs succeed.
- [x] `m03-proof.json` records the implementation workflow, exact artifacts, and successful jobs.
- [x] The proof-closure commit and final certification commit each pass their own M03 workflow.
- [x] Annotated tag `m03-complete` resolves to the final certification commit on the remote.

M04 is authorized only after every item above is complete. `testbed-complete`
does not close any live DSM register row.
