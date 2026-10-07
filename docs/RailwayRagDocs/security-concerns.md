# Security Review: API and Admin Access

**Date:** 2026-08-08
**Scope:** Authentication and authorization of the web app's HTTP API surface —
the public `/api/v1` API and the admin/control-panel routes under `/api/*`.
**Out of scope (assumed trusted/secure per request):** Railway account, Supabase
account, the Supabase project itself, and the maintenance service's internal
network position.
**Method:** Static review of route handlers and the shared auth helpers in
`apps/web/src/lib`. No code was changed.

## Summary

The public `/api/v1` API is well protected: every route goes through
`withApiV1` / `withDocumentApiV1`, which authenticate a Bearer API key, enforce
scopes, and audit usage. Admin **identity** management (`/api/admin/users`) is
also gated by `requireAdmin`.

The serious problem is the rest of the **admin control-panel API** — the routes
the React admin UI calls under `/api/*` (not `/api/v1`). There is **no
`middleware.ts`**, and these routes do not call `requireAdmin`. They call
`requireSupabase()` only, which checks that Supabase is configured and the schema
is compatible — it performs **no identity check of any kind**. Because the `web`
service is a public Railway endpoint (the Bubble integration reaches it over the
public internet with Bearer keys), every one of these routes is reachable by an
unauthenticated attacker.

The most severe consequences: an unauthenticated caller can **steal every API
key in plaintext**, **mint a new API key with all scopes**, **create a
delegated-admin user**, and **overwrite the OpenAI/Ollama keys and the Supabase
service-role key stored in Vault**. These are not theoretical — the routes return
the secrets directly.

| #   | Finding                                                                                | Severity | Confirmed |
| --- | -------------------------------------------------------------------------------------- | -------- | --------- |
| 1   | Unauthenticated API key management, incl. plaintext reveal                             | Critical | Yes       |
| 2   | Unauthenticated provider-credential and Supabase-connection management                 | Critical | Yes       |
| 3   | Unauthenticated API-test-user creation → delegated-admin backdoor                      | Critical | Yes       |
| 4   | Systemic missing auth on admin control-panel routes                                    | Critical | Yes       |
| 5   | `setup/supabase` bootstraps defaults and copies service-role key to Vault with no auth | High     | Yes       |
| 6   | `restores` startable with no identity check                                            | High     | Yes       |
| 7   | `ADMIN_AUTH_ENABLED=false` silently disables every `requireAdmin`/usage gate           | Medium   | Yes       |
| 8   | API-key encryption secret falls back to `ADMIN_SESSION_SECRET`                         | Medium   | Yes       |
| 9   | Session cookie `Secure` flag tied to `NODE_ENV` rather than an explicit setting        | Low      | Yes       |

---

## What is done well

- **Public v1 API auth is correct.** `withApiV1` (`apps/web/src/lib/api-v1.ts:54`)
  authenticates `Authorization: Bearer <key>` by SHA-256 hash lookup, rejects
  revoked keys, enforces per-route scopes (`api-v1.ts:121`), and audits every
  call. `withDocumentApiV1` (`library-api.ts:262`) wraps it and adds
  silo/library authorization.
- **Admin passwords** use scrypt with a per-user salt and `timingSafeEqual`
  (`admin-auth.ts:62`, `:81`).
- **Admin sessions** are HMAC-SHA-256 signed with expiry and role validation
  (`admin-session.ts:110`), stored in an `HttpOnly` cookie.
- **Setup token** is single-use (recorded in `admin_setup_tokens` on first
  consumption, `admin-auth.ts:159`) and compared in constant time.
- **Admin user management** has guardrails: cannot deactivate self, cannot
  deactivate the last active admin (`admin-users.ts:117`).
- **API keys at rest** are AES-256-GCM encrypted (`api-keys.ts:76`); summaries
  never return the hash or ciphertext.

The gaps below are not in these mechanisms — they are in **which routes use
them**.

---

## Finding 1 — Unauthenticated API key management, including plaintext reveal

**Severity: Critical**

The three route files under `/api/api-keys` never call `requireAdmin` (or any
identity check). `requireSupabase()` is the only gate.

- `GET /api/api-keys` — lists every key including `key_hash`, `key_ciphertext`,
  `key_preview`, and scopes (`apps/web/src/app/api/api-keys/route.ts:25`).
- `POST /api/api-keys` — creates a new API key with **arbitrary scopes chosen by
  the caller**, including `libraries:grant` (which is excluded from the default
  set but selectable, `api-keys.ts:14`, `route.ts:66`). The plaintext key is
  returned in the response (`route.ts:110`).
- `PUT /api/api-keys/[id]` — renames or re-scopes any key
  (`api-keys/[id]/route.ts:28`).
- `DELETE /api/api-keys/[id]` — revokes any key (`api-keys/[id]/route.ts:69`).
- `GET /api/api-keys/[id]/reveal` — **decrypts and returns the raw plaintext API
  key** (`api-keys/[id]/reveal/route.ts:56`).

**Impact.** An unauthenticated attacker who can reach the web origin can:

1. Call `GET /api/api-keys` to enumerate every key id.
2. Call `GET /api/api-keys/{id}/reveal` to recover each **plaintext** API key.
3. Use those keys against the fully-authenticated `/api/v1` API — full access to
   documents, RAG search, Ask, extraction, generated files, and usage logs for
   every silo/project the key has scope to.

Step 2 alone collapses the entire v1 API's authentication: the keys are the
credentials for the public API, and they are handed out unauthenticated. Step 3
(additionally minting a key with `libraries:grant`) grants authority the default
keys do not even have.

**Contrast.** The far less sensitive `/api/admin/users` list correctly calls
`requireAdmin` (`admin/users/route.ts:11`). The API key routes — which hold the
credentials for the whole public API — do not.

**Recommended solution(s)**

1. **Require admin on every handler** in `api-keys/route.ts`,
   `api-keys/[id]/route.ts`, and `api-keys/[id]/reveal/route.ts` — the same
   `requireAdmin` call `admin/users/route.ts:11` already uses. This is the
   minimum fix and closes the enumeration, mint, re-scope, revoke, and reveal
   paths.
2. **Step up for reveal.** Reveal returns a live credential, so gate it beyond a
   plain admin session: require recent re-authentication (password re-entry
   within the last N minutes) before returning plaintext, and write an audit
   row naming the acting admin and the key revealed. Better still, **remove
   reveal entirely** and replace it with a rotate-and-show-once flow: a new
   plaintext is returned only at creation time, and "I lost it" is solved by
   revoking + minting, not by decrypting the stored copy.
3. **Reduce list exposure.** Drop `key_hash` and `key_ciphertext` from the
   `GET /api/api-keys` select (`route.ts:43`) — the UI already has `key_prefix`
   and `key_preview` via the summary, and the hash/ciphertext add nothing for
   display while raising the value of a leaked list response.
4. **Middleware backstop.** Block `/api/api-keys/*` unless a valid admin session
   cookie is present, so a missed per-route guard cannot expose the keys (see
   Finding 4's middleware recommendation).

---

## Finding 2 — Unauthenticated provider-credential and Supabase-connection management

**Severity: Critical**

### `provider-access`

`apps/web/src/app/api/provider-access/route.ts` has no identity check on either
verb:

- `GET` (`:29`) reports which provider secrets are configured.
- `PUT` (`:47`) writes provider secrets into Supabase Vault, including the
  **OpenAI API key**, the **Ollama API key**, the **Supabase DB password**, the
  **Supabase database URL**, and the **Supabase service-role key**
  (`saveProviderSecrets`, `:246`).

An unauthenticated caller can overwrite any of these with attacker-controlled
values — e.g. point OpenAI calls at a billing-account they control, or replace
the stored Supabase service-role key.

### `supabase-connection`

`apps/web/src/app/api/supabase-connection/route.ts` has no identity check on any
verb:

- `POST` (`:192`) accepts a caller-supplied `supabaseUrl`, `serviceRoleKey`, and
  `databaseUrl` and runs validation/probe flows against them.
- `PUT` (`:323`) **starts a connection promotion** via
  `startConnectionPromotion` (`:376`), which redeploys the platform onto the
  caller-supplied Supabase credentials. The only gate is that the maintenance
  service reports rotation as available — which is the normal production state.

**Impact.** An unauthenticated caller can repoint the entire platform at a
Supabase project they control (capturing all subsequent database traffic and
service-role access), or simply destroy the current connection by promoting
invalid values. `supabase-connection/finalize` is likewise unguarded.

**Recommended solution(s)**

1. **Require admin** on `provider-access` (GET and PUT) and on
   `supabase-connection`, `supabase-connection/finalize` (GET, POST, PUT).
   These hold the platform's most destructive levers and its stored secrets, so
   they belong behind the same guard as admin user management.
2. **Step up for promotion.** `supabase-connection` PUT redeploys the whole
   platform onto caller-supplied credentials (`route.ts:323`). Treat it like a
   restore: require a valid admin session **and** a recent re-authentication or
   explicit typed confirmation tied to the acting admin identity — not just the
   maintenance rotation being "available." Record the actor (`parsed.actor`
   already exists in the schema; ensure it is populated from the session, not
   trusted from the request body).
3. **Never echo submitted secrets.** Confirm the PUT responses return only the
   fingerprint/status shapes the GET already returns, never the submitted
   `serviceRoleKey`/`databaseUrl`/`apiKey` values. (The GET already
   fingerprint-only — keep it that way.)
4. **Gate the test/probe endpoints.** `provider-access/test` and the Ollama
   `test`/`context-size` routes accept caller-supplied URLs and issue outbound
   calls; require admin so they cannot be used as an unauthenticated
   server-side-request oracle or to burn provider quota.

---

## Finding 3 — Unauthenticated API-test-user creation → delegated-admin backdoor

**Severity: Critical**

`apps/web/src/app/api/api-test-users/route.ts` has no identity check:

- `POST` (`:48`) creates an API test user with a caller-chosen `username`,
  `password`, `apiKeyId`, and **`isAdmin: true`** (`:23`).
- `GET` (`:26`) lists all API test users.

The login route accepts API test users by username
(`apps/web/src/app/api/admin/login/route.ts:104`), and when `is_admin` is true it
issues a **`delegated_admin`** session (`:134`).

**Impact.** An unauthenticated attacker can:

1. `POST /api/api-test-users` with `isAdmin: true` and a password they know.
2. `POST /api/admin/login` with that username/password to receive a valid
   `delegated_admin` session cookie.
3. Use that session wherever `delegated_admin` is trusted — notably the API test
   proxy (`/api/apitest/v1/[...path]`), which, for admin/delegated-admin roles,
   lets the caller select **any** API key via the `x-api-test-key-id` header
   (`api-test-session.ts:135`) and proxies the decrypted key as a Bearer token.

This is a persistent, unauthenticated backdoor to admin-equivalent API access.
`api-test-users/[id]` (update/delete) is also unguarded, so the attacker can
also manage these accounts.

**Recommended solution(s)**

1. **Require admin** on `api-test-users` (GET, POST) and `api-test-users/[id]`
   (PATCH/DELETE). Creating accounts that can sign in must not be open.
2. **Do not trust `isAdmin` from the request body.** Today `ApiTestUserCreateSchema`
   lets the caller set `isAdmin: true` (`route.ts:23`). Either drop the field
   from the public create schema entirely, or only honor it when the caller is
   already a full `admin` (which `requireAdmin` establishes) and add a separate,
   audited grant action for elevating a test user to delegated admin.
3. **Narrow the delegated-admin capability.** In `requireApiTestSession`, only a
   full `admin` should be allowed to select an arbitrary API key via
   `x-api-test-key-id` (`api-test-session.ts:135`); a `delegated_admin` should
   be pinned to its own bound `apiKeyId`, the way an `api_tester` is
   (`api-test-session.ts:131`). This turns the delegated-admin backdoor into a
   least-privilege account even if one is created.
4. **Audit** creation, deletion, and any `isAdmin` elevation of API test users
   with the acting admin id.

---

## Finding 4 — Systemic missing auth on admin control-panel routes

**Severity: Critical**

This is the root cause behind Findings 1–3 and 5–6. A precise scan (route files
that call `requireSupabase` but contain **no** `requireAdmin`,
`requireApiTestSession`, `requireApiUsageAccess`, `withApiV1`,
`withDocumentApiV1`, `verifySetupSession`, or internal-service-token check)
returns the following unauthenticated routes — after excluding the legitimately
public/self-gating ones (`admin/login`, `admin/setup/*` which validate the
`ADMIN_SETUP_TOKEN` internally):

```
api-keys/route.ts                              api-keys/[id]/route.ts
api-keys/[id]/reveal/route.ts                  api-test-users/route.ts
api-test-users/[id]/route.ts                   ask/route.ts
backups/route.ts                               backups/[id]/route.ts
context-management/route.ts                    documents/route.ts
documents/[id]/cancel/route.ts                 documents/[id]/download/route.ts
documents/[id]/process/route.ts                documents/[id]/route.ts
documents/[id]/status/route.ts                 documents/[id]/text/route.ts
extract/route.ts                               extraction-tool/route.ts
extractions/[id]/route.ts                      generated-file-browser/route.ts
generated-files/route.ts                       generated-files/temporary/route.ts
generated-files/[id]/download/route.ts         generated-files/[id]/route.ts
libraries/bindings/route.ts                    libraries/documents/route.ts
libraries/projects/route.ts                    libraries/route.ts
model-runs/[kind]/[id]/rerun/route.ts          model-runs/[kind]/[id]/route.ts
model-tasks/route.ts                           platform-settings/route.ts
provider-access/route.ts                       provider-access/test/route.ts
providers/ollama/context-size/route.ts         providers/ollama/keys/route.ts
providers/ollama/keys/[keyId]/route.ts         providers/ollama/route.ts
providers/ollama/test/route.ts                 rag-browser/route.ts
rag-settings/route.ts                          restores/route.ts
setup/supabase/route.ts                        silos/route.ts
silos/[siloId]/projects/route.ts               silos/[siloId]/projects/[projectId]/documents/route.ts
silos/[siloId]/projects/[projectId]/route.ts   silos/[siloId]/route.ts
storage-access/route.ts                        supabase-connection/finalize/route.ts
supabase-connection/route.ts                   task-runs/route.ts
task-runs/[runId]/cancel/route.ts              task-runs/[runId]/route.ts
tasks/route.ts                                 tasks/[taskId]/items/route.ts
tasks/[taskId]/route.ts                        tasks/[taskId]/run/route.ts
tools/generated-file-id/route.ts               tools/get-document-image/route.ts
tools/list-files/route.ts                      tools/rag-search/route.ts
tools/render-pdf-page/route.ts                 work-queues/route.ts
```

`requireSupabase()` (`apps/web/src/lib/http.ts:42`) only verifies Supabase is
configured and the schema is compatible. It is a **readiness** check, not an
**authorization** check.

**Impact.** Unauthenticated access to the full admin control plane: ingest,
download, and delete documents; browse RAG vectors and generated files; manage
silos, projects, libraries, tasks, and model tasks; read/modify platform runtime
settings; manage Ollama keys; run extractions and Ask; and inspect work queues.
Several of these (document downloads, `rag-browser`, `generated-file-browser`,
`tools/get-document-image`, `usage-logs`-adjacent data) also expose the
ingested document content itself.

**Note on the v1 API.** The routes under `/api/v1/*` are **not** affected — they
go through `withApiV1`/`withDocumentApiV1`. The split is consistent: the
public API is secured; the admin panel that manages it is not.

**Recommended solution(s)**

1. **Add a Next.js `middleware.ts`** as the durable backstop. Match `/api/*`
   (excluding `/api/v1`, `/api/apitest`, and an explicit public allow-list:
   `health`, `v1/health`, `versions`, `admin/login`, `admin/logout`,
   `admin/me`, `admin/setup/*`, `setup/status`, `setup/session`), and reject
   any request without a valid admin session cookie (`verifyAdminSession`).
   This catches every route missed per-route, including ones added later.
2. **Add `requireAdmin` per-route as defense-in-depth**, so each handler still
   returns a correct 401 on its own and a missed middleware matcher does not
   leave a hole. Use the existing guard verbatim — it already handles the
   `authEnabled` off switch and role check.
3. **Add a lint/test rule** that every route file under `/api/*` (outside
   `/api/v1`, `/api/apitest`, and the allow-list) calls `requireAdmin`,
   `requireApiTestSession`, or `requireApiUsageAccess`. A grep-based CI check
   mirroring the scan in this report would prevent regressions.
4. **Re-run the scan in this report after the fix** to confirm the unguarded
   list is empty (minus the intended public set).

---

## Finding 5 — `setup/supabase` bootstraps defaults and copies the service-role key to Vault with no auth

**Severity: High**

`apps/web/src/app/api/setup/supabase/route.ts` has no identity check on either
verb, despite the inline comment on line 56 claiming "This authenticated route
only refreshes application defaults." It is not authenticated.

- `GET` (`:28`) reports which provider secrets are configured.
- `POST` (`:55`) calls `bootstrap_bubble_rag_defaults` and, when env values are
  present, **copies the Supabase service-role key, OpenAI key, and Ollama key
  from the environment into Supabase Vault** (`:98`–`:168`).

**Impact.** An unauthenticated caller can trigger default re-seeding and, more
importantly, force the platform's env-held service-role key into Vault on demand.
The misleading comment suggests this was intended to be gated; it is not.

**Recommended solution(s)**

1. **Require admin** on `setup/supabase` GET and POST. The POST copies the
   Supabase service-role key, OpenAI key, and Ollama key from the environment
   into Vault (`route.ts:98`–`:168`); that is a credential write and must be
   gated.
2. **Fix the misleading comment** on line 56 ("This authenticated route only
   refreshes application defaults") — it currently asserts a property the code
   does not have, which is exactly the kind of comment that lets the gap
   survive review.
3. **Consider gating by setup session during initial bootstrap.** If this route
   is meant to run before the first admin exists, gate it with
   `verifySetupSession` (the same gate `setup/admin/route.ts:22` and
   `setup/initialize/route.ts:20` use) instead of an admin session, and switch
   to admin-only once bootstrap is complete.

---

## Finding 6 — `restores` startable with no identity check

**Severity: High**

`apps/web/src/app/api/restores/route.ts` has no identity check on any verb:

- `GET` (`:39`) lists recent restore jobs.
- `PUT` (`:74`) inspects an arbitrary archive (with caller-supplied encryption
  key).
- `POST` (`:98`) **starts a restore** that writes another installation's data
  into this one.

The only barriers are the static confirmation phrase
(`RESTORE_CONFIRMATION_PHRASE`, `:105`) and the maintenance preflight — neither
of which establishes **who** is requesting the restore. The confirmation phrase
is a fixed string discoverable in the codebase (`@bubble-rag/rag-core`), so it is
not a credential.

**Impact.** An unauthenticated caller can trigger a destructive restore that
overwrites the installation's data, or enumerate restore history.

**Recommended solution(s)**

1. **Require admin** on `restores` GET, PUT, and POST. A restore writes another
   installation's data into this one; it must be initiated by an authenticated
   administrator, not by whoever knows the static phrase.
2. **Stop treating the confirmation phrase as the auth barrier.**
   `RESTORE_CONFIRMATION_PHRASE` is a fixed string shipped in `@bubble-rag/rag-core`,
   so it is not a secret. Keep it as a UX confirmation (the user must type it to
   prove intent), but make the **identity** check the real gate. Populate
   `requested_by` from the admin session (`guard.actingAdminId`), not from the
   request body.
3. **Step up for destructive restores.** Like the connection promotion in
   Finding 2, require a recent re-authentication before starting a restore, and
   audit the start with the acting admin id, backup id, and target.
4. **Gate the inspect (PUT) path too** — it accepts a caller-supplied
   `encryptionKey` and archive id and exercises the maintenance probe; it
   should not be open either.

---

## Finding 7 — `ADMIN_AUTH_ENABLED=false` silently disables every admin/usage gate

**Severity: Medium**

**Remediated 2026-08-26.** `ADMIN_AUTH_ENABLED` now controls only issuance of
new browser sessions. It no longer changes route authorization, and a missing
or false value fails closed for login. Regression coverage verifies that an
unauthenticated usage-log request remains rejected while login is disabled.

`requireAdmin` returns success with no session when `authEnabled` is false
(`apps/web/src/lib/admin-guard.ts:26`). `requireApiUsageAccess` does the same
(`api-usage-access.ts:33`). The flag is read from `ADMIN_AUTH_ENABLED`
(`admin-config.ts:5`); `.env.example` defaults it to `true`.

**Impact.** If this is unset or set false in any deployment, the routes that
_do_ call `requireAdmin`/`requireApiUsageAccess` become open too. This does not
affect Findings 1–6 (those routes never call the guard at all), but it is a
configuration footgun that would widen the blast radius to the identity
management routes as well. Consider failing closed if the flag is absent, or
making the guard non-disableable in production.

---

## Finding 8 — API-key encryption secret falls back to `ADMIN_SESSION_SECRET`

**Severity: Medium**

`getApiKeyEncryptionSecret()` (`apps/web/src/lib/api-keys.ts:67`) uses
`API_KEY_ENCRYPTION_SECRET` if set, otherwise falls back to
`ADMIN_SESSION_SECRET`, and returns `""` if neither is at least 32 characters.
Callers refuse to operate when the secret is empty (e.g. `route.ts:75`,
`reveal/route.ts:23`), so the empty-string case is guarded.

**Impact.** Two concerns:

1. **Key coupling.** Compromise of `ADMIN_SESSION_SECRET` also yields every
   encrypted API key (the reveal endpoint decrypts with the same secret). A
   dedicated `API_KEY_ENCRYPTION_SECRET` that is _not_ the session secret would
   isolate these failure modes.
2. **Silent fallback.** If `API_KEY_ENCRYPTION_SECRET` is accidentally unset,
   keys are encrypted with the session secret with no warning. Rotating the
   session secret later would silently make all stored ciphertext undecryptable.

---

## Finding 9 — Session cookie `Secure` flag tied to `NODE_ENV`

**Severity: Low**

Admin and API-test session cookies set `secure: process.env.NODE_ENV ===
"production"` (`admin-session.ts:38`, `:87`). On Railway `NODE_ENV=production`,
so the flag is set in normal deployments.

**Impact.** If a deployment ever runs with `NODE_ENV` unset or set to something
other than `production` while still being reachable over a public URL, the
session cookie would be transmitted over plain HTTP. Tying the flag to an
explicit "this is a public HTTPS deployment" setting (or to `NODE_ENV` plus a
hard override) would be more robust. (The setup-session cookie has the same
dependency, `setup-session.ts:99`.)

---

## Recommendations (no code changed)

These are directional only, per the request not to modify code.

1. **Add an identity check to every admin/control-panel route.** The cleanest
   fix is a single `requireAdmin` (or a new `requireControlPanel` wrapper) call
   at the top of each handler in the Finding 4 list — the same pattern
   `admin/users/route.ts` already uses. A Next.js `middleware.ts` that blocks
   `/api/*` (except the explicit public allow-list: `health`, `v1/health`,
   `versions`, `admin/login`, `admin/logout`, `admin/me`, `admin/setup/*`,
   `setup/status`, `setup/session`) for requests without a valid admin session
   would be a strong second layer and would catch any route missed per-route.
2. **Treat the API key routes as especially sensitive.** Reveal in particular
   should require admin and ideally a re-authentication / recent-step-up, and
   should be audited.
3. **Gate `provider-access`, `supabase-connection`, `setup/supabase`, and
   `restores` behind admin** (Findings 2, 5, 6) — these handle credentials and
   destructive platform state.
4. **Remove or gate `api-test-users` creation** (Finding 3). At minimum,
   `isAdmin: true` must not be settable by an unauthenticated caller.
5. **Rotate secrets assumed exposed.** If any of this has run on a public
   Railway URL, treat all API keys and the OpenAI/Ollama/Supabase credentials as
   potentially compromised and rotate them.
6. **Decouple `API_KEY_ENCRYPTION_SECRET`** from `ADMIN_SESSION_SECRET`
   (Finding 8) and fail loudly rather than silently falling back.
7. **Make `ADMIN_AUTH_ENABLED` fail closed** in production (Finding 7).
8. **Drive the cookie `Secure` flag from an explicit setting**, not `NODE_ENV`
   (Finding 9).

---

## Recommended audit logging for security review

This section is about the _log_ layer that supports a security review and
incident response: what is already logged well, and what entries / entry types
should be added so a reviewer can answer "who did what, from where, and was it
allowed." It is directional only — no code or migrations are proposed here.

### Positive features already in place

The codebase already has several audit surfaces done right, and they are worth
keeping and building on:

- **Full public-API audit (`api_usage_logs`).** Every `/api/v1` call is recorded
  with method, path, required scope, status code, `error_code`, latency,
  redacted query string, idempotency flags, and request/response bodies
  (`20260719000300_public_api_support.sql:29`, bodies in
  `20260730000100_api_usage_log_payloads.sql`). The capture is wired centrally
  in `withApiV1` (`api-v1.ts:525`) so it cannot be skipped per-route, and it
  runs even on errors and replayed idempotent responses (`api-v1.ts:187`,
  `:226`).
- **Connection-change audit done to a high standard
  (`supabase_connection_events`).** Records actor, action, outcome, previous
  and proposed project refs, and secret _fingerprints_ — never a secret. A
  CHECK constraint rejects any fingerprint over 12 hex chars
  (`20260804000600_supabase_connection_audit.sql:49`) so the application
  structurally cannot persist material derived too directly from a credential.
  This is the model shape to copy for any new audit table.
- **Setup token is single-use and recorded.** `admin_setup_tokens` stores the
  token hash, consuming admin id, and email at consumption
  (`20260719000100_admin_auth.sql:14`), and `validateSetupToken` rejects a
  reused token (`admin-auth.ts:182`).
- **API keys at rest are encrypted, not hashed-and-logged.** The stored key is
  AES-256-GCM ciphertext (`api-keys.ts:76`); only `key_prefix`/`key_preview`
  appear in summaries (`api-keys.ts:113`), so the audit/summary surface never
  holds the credential itself.
- **Usage-log redaction on input.** Query parameters are redacted before
  storage (`redactedApiUsageQuery`, `api-v1.ts:566`), and streaming responses
  are marked uncaptured rather than buffered (`api-v1.ts:540`).
- **Audit writes are time-bounded.** `auditApiUsage` wraps its insert in a
  3-second timeout (`api-v1.ts:578`) so logging cannot stall the response.

### The gap

There is **no audit log for admin identity events or privileged control-plane
actions**. Today a reviewer cannot answer: who revealed an API key, who changed
the provider config, who started a restore, or whether someone failed to log in
repeatedly. `admin_users.last_login_at` records only a successful-login
timestamp; `admin_setup_tokens` records only successful consumption. Once the
Findings 1–6 routes are gated, you want a trail of _who_ exercised them.

### Recommended new entry type: a unified security audit log

Add an append-only `security_audit_events` table mirroring the
`supabase_connection_events` shape (actor, action, outcome, fingerprints-not-
secrets, a length constraint on any secret-derived field). Suggested columns:

| column                                | purpose                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `id`, `tenant_id`, `created_at`       | identity                                                                             |
| `actor_id` (nullable)                 | admin id / api key id / api test user id                                             |
| `actor_type`                          | `admin` \| `delegated_admin` \| `api_tester` \| `api_key` \| `anonymous` \| `system` |
| `actor_label`                         | email / username / key name for reading — not a secret                               |
| `action`                              | e.g. `admin.login.failed`, `api_key.reveal`                                          |
| `target_type`, `target_id` (nullable) | the resource acted on                                                                |
| `outcome`                             | `success` \| `failure` \| `denied`                                                   |
| `reason_code` (nullable)              | e.g. `invalid_password`, `insufficient_scope`, `admin_authorization_required`        |
| `request_id` (nullable)               | correlates with `api_usage_logs`                                                     |
| `source_ip`, `user_agent` (nullable)  | missing today — needed for abuse attribution                                         |
| `http_method`, `http_path` (nullable) | route context                                                                        |
| `metadata` (jsonb)                    | action-specific; fingerprints ok, never values                                       |

Make it **append-only** (revoke `update`/`delete` from the service role, or a
trigger) and RLS service-role-only.

### Entry types to capture

Grouped and tied to the findings:

**Admin identity** (nothing today)

- `admin.login.success` / `admin.login.failed` — store the normalized
  identifier, never the password. Detects brute force / credential stuffing.
- `admin.logout`
- `admin.session.invalid` — a _present_ cookie that failed `verifyAdminSession`
  (tampered/expired) — token-theft or forging signal.
- `admin.setup_token.verify.success` / `.failed`, `admin.setup_token.consumed`
  — today only consumption is recorded, not guesses.

**Privileged control-plane** (so the gated Findings 1–6 leave a trail)

- `api_key.create` (with scopes), **`api_key.reveal`** (log actor + key id + IP
  every time — this is the plaintext-decryption path), `api_key.update` (scope
  change), `api_key.revoke`
- `provider_secret.set` / `.cleared` (provider + key_label; fingerprint, never
  value)
- `restore.start`, `restore.inspect`
- `platform_settings.update` (which setting keys changed, not necessarily
  sensitive values)
- `model_task.update`
- `api_test_user.create` / `.elevate` / `.delete` — **flag `isAdmin=true`
  grants specifically** (Finding 3)
- `admin.user.deactivate`, `admin.user.password_reset`
- `supabase_connection.*` can stay in its own table, but consider mirroring into
  this one for a single timeline.

**Authorization denials** (probing signal)

- `auth.denied.admin` — `requireAdmin` rejected (route + required scope)
- `auth.denied.scope` — `insufficient_scope` (v1 already records this as
  `error_code`; the admin panel does not)
- `auth.denied.api_key` — invalid/revoked key presented

### Hygiene fixes to the existing log

- **Add `source_ip` and `user_agent` to `api_usage_logs`.** Today an abuse
  pattern in the public API cannot be attributed to an origin; both are needed
  for any rate-limiting or IP-based review.
- **Reconsider full `request_body`/`response_body` capture.** Extraction
  responses and document text sit in plaintext in `api_usage_logs`. Recommend
  redacting sensitive payloads, splitting bodies into a shorter-retention side
  table, or at minimum documenting what is stored and the retention window. Do
  not add bodies to the new audit log.
- **Make audit tables append-only at the DB level.** Today the service role can
  `update`/`delete` from every audit table, so an attacker who reaches the
  service role — or a bug — can rewrite history.

### Detection you can build once the log exists

- Failed-login rate per `actor_label` / `source_ip` → alert and lockout.
- `api_key.reveal` from a new actor or IP, or above N/day → alert.
- `auth.denied.*` spike per `source_ip` → probing alert.
- Any `provider_secret.set`, `supabase_connection.promote`, `restore.start`,
  `api_test_user.elevate` → page-worthy alert.

### Log volume and retention

The volume concern is real, but it lives in the **existing** `api_usage_logs`
table — not in the new `security_audit_events` log, which is low-volume by
design (admin actions, logins, denials) and captures no request/response bodies.

**Why `api_usage_logs` is the concern.**

- **One row per `/api/v1` call, and each row is large.** `auditApiUsage` writes a
  row on every public-API request (`api-v1.ts:554`) that includes the full
  `request_body` **and** `response_body`. For Ask, extraction, and
  document-text responses those bodies can be tens–hundreds of KB each — so it
  is high row count × large row size.
- **No live-DB retention.** The only deletion of `api_usage_logs` is the
  all-or-nothing admin "CLEAR API LOGS" action (`usage-logs/route.ts:150` —
  `delete ... eq tenant_id`, the whole tenant's rows at once). The
  `historyRetention` contract in `platform/secret-redaction.v1.json:97` — 90
  days for `api_usage_logs`/`model_usage_logs`/`usage_events`/
  `api_webhook_deliveries`, 30 days for `ask_run_events`/compression snapshots —
  is a **backup-archive** policy ("without making portable archives
  unbounded"). It bounds what goes into a portable backup; it does **not** prune
  the live table. The live log tables therefore grow without bound between
  manual full wipes.
- **The write is on the hot path.** `auditApiUsage` is `await`ed before the
  response returns (`api-v1.ts:226`, with a 3 s timeout), and a separate
  `last_used_at` update is awaited too (`api-v1.ts:243`). A bloated or slow
  `api_usage_logs` table directly degrades the API it audits; the 3 s timeout
  prevents a total stall but a multi-second added-latency spike is still bad.
- **All-or-nothing clear destroys forensics.** Operators get a binary: keep
  everything forever, or wipe the whole audit history and lose incident
  evidence. There is no "keep recent, age out the rest."
- **Sensitive data at rest, indefinitely.** Because bodies are captured,
  unbounded retention means document text and extraction outputs sit in
  plaintext forever — a breach-impact amplifier, not only a cost issue.

**One caveat for the new audit log.** `auth.denied.*` entries are
_attacker-driven_: an unauthenticated probe generates a denial row per request,
so per-request denial logging is itself an amplification vector — an attacker
can flood the audit table by spraying 401s. Mitigation: **rate-bucket**
denials (one summary row per `(source_ip, action, minute)` once over a
threshold) rather than one row per probe.

**Recommendations (no code changed)**

1. **Turn the archive retention policy into a live-prune policy.** Add a
   batched, scheduled prune (maintenance service or a cron) that deletes log
   rows older than N days per table, reusing the `historyRetention` defaults
   already in the contract (90/30). Batch with a `limit` and loop to avoid
   vacuum storms, e.g. `delete ... where created_at < now() - interval '90
days' limit 10000` until none remain.
2. **Make retention operator-tunable and on by default** via platform settings,
   so the choice is not "grow forever or nuke everything." Reuse the existing
   `platform_runtime_settings`/`backup_schedules`-style controls so a value is
   expected, not optional.
3. **Move the audit write off the response hot path.** Make the
   `api_usage_logs` insert and the `last_used_at` update fire-and-forget (or
   queue them) so DB slowdowns do not stall the API. Keep the 3 s timeout as a
   fallback only.
4. **Cap/redact bodies.** Truncate `request_body`/`response_body` to a max
   length; drop bodies for known-large or sensitive endpoints (keeping
   method/path/status/`error_code`/latency); or split bodies into a side table
   with shorter retention. This reduces both row size and the sensitive-data-at-
   rest surface.
5. **Rate-bucket denial/auth-failure entries** in the new audit log so probing
   cannot weaponize the log table (see caveat above).
6. **Index for age-based deletes.** The existing `(tenant_id, created_at desc)`
   index supports a tenant-scoped prune; confirm the batched delete uses it and
   runs with a `limit` to avoid a single large transaction.
