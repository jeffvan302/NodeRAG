# Railway Connection And Service Reconciliation

## Purpose

RAG Railway can inspect and repair its own Railway service layout from the
administrator website. This is an upgrade path for installations that predate
the maintenance, scheduler, or embeddings services. It is also the routine way
to verify that all services still use the checked-in template after an update.

The canonical desired state remains
`platform/railway-template.v1.json`. The generated runtime copy in
`packages/rag-core/src/railway-template.generated.ts` is checked in and verified
by `pnpm docs:check` so the website and maintenance service cannot quietly use a
different service plan.

## Administrator Workflow

1. An administrator opens **Configuration -> Railway connection**. During a
   first installation, or while an existing installation is not operational
   (for example after a deploy that left maintenance absent and the schema
   needing an upgrade), a verified setup session has the same narrow
   authority.
2. **Connect Railway** starts OAuth with PKCE. Consent is limited to a
   user-selected project at `project:member` scope. A project or workspace token
   is available as a manual fallback; account-wide tokens are not offered.
3. **Review services** reads the current project and builds an exact plan. The
   plan lists service creation, source/config attachment, shared-variable
   promotion, eligible secret sealing, volume creation, and deployments.
4. The administrator explicitly approves that plan. The controller reads
   Railway again and compares a SHA-256 plan digest before making changes. Any
   change after preview invalidates the approval.
5. The controller applies additions and updates. Unexpected services are listed
   and left unchanged. Reconciliation never deletes a service it did not decide
   to recreate (see _Recreating a service_).
6. Web waits for the maintenance service running the same release, asks it to
   apply the database migration, and transfers the credential over the private
   signed service channel into the Settings Vault.
7. If **Keep access for future service upgrades** was not selected, the OAuth
   client and temporary credential are discarded. If selected, the Settings
   Vault retains the encrypted credential and the top banner continues to offer
   a review/revoke path.

## Apply Runs As A Tracked Job

Applying changes is slow for reasons that cannot be removed: Railway builds take
minutes, and the maintenance service cannot answer until its build finishes.
`POST /api/railway/apply` therefore does not hold the connection open for the
duration. In the web bootstrap path it validates the approval, starts the work,
and returns `202` with a job record. `GET /api/railway/apply?jobId=...` reports
that job's steps as they run.

Each unit of work announces itself before it starts and reports how it ended, so
the `/railway` screen can show which step is running. That distinction is the
point: a step that reports `running` and then nothing for four minutes is a
Railway build, which is normal, while a step that never reports at all is code
that never reached it. Before this existed, both looked like a button that did
nothing, and the request eventually returned `504`.

Two consequences follow from the job living in web's memory rather than in
Postgres:

- A reconciliation that redeploys web ends the job with it. `GET` then answers
  `404 railway_job_unknown`, which reports that the record is gone rather than
  that the work failed. Railway holds the real state; the next **Review
  services** reads it back.
- A second `POST` with the same request key returns the job already running
  instead of starting a rival one. Two reconciliations racing can delete a
  service the other is mid-way through deploying.

The maintenance-controlled path is unchanged: maintenance already tracks its own
operations, so that request answers directly and there is no job to follow.

Web's own redeploy is deferred to the very end of the job. Web is last in the
deployment order and is also the process running the reconciliation, so
deploying it in place would end the job after the services were created but
before maintenance was waited for and the schema upgrade queued — an apply that
looked successful and quietly left the database alone. The deferred deploy runs
after the credential handoff, once restarting web costs nothing.

## Recreating A Service

A service that cannot be repaired in place can be deleted and rebuilt from the
template. This is a last resort and is reached only after a redeploy has already
failed to bring maintenance online.

Repair in place is preferred for a concrete reason: these services hold values an
operator typed by hand — `SUPABASE_DB_PASSWORD` moved onto maintenance in exactly
that way — and deleting a service throws them away with it. So recreation reads
the service's variables back from Railway first and writes them onto the
replacement, and it refuses outright to touch a service with a volume attached,
because that is a data-loss question rather than a reconciliation one.

Recreation runs at most once per apply. If the replacement does not come online
either, the problem is the build rather than the service record, and destroying
it a second time would not help; the job fails with
`maintenance_deployment_timeout` and points at the maintenance build log.

## Authority Boundary

The presence of a setup token does not authorize infrastructure work by
itself. Setup authority requires all of the following:

- a valid, signed setup-session cookie created from the current
  `ADMIN_SETUP_TOKEN`;
- a reachable administrator table; and
- either an administrator count of zero (first installation), or a platform
  readiness state that is not `operational` (recovery).

The recovery exception exists because a deploy that changes the schema can
break normal administrator login at exactly the moment maintenance must be
reconciled. It closes automatically: readiness is rechecked on every protected
request, and once the schema is operational the setup session is rejected and
a real administrator session is required again. During the first-installation
case the exception still closes as soon as the first administrator is created.

The OAuth flow records which authority started it. The callback repeats the
authorization check and must receive the same authority that began the flow.
Creating the first administrator therefore closes the setup exception even when
an OAuth browser round trip is already in progress; the connection can then be
started again by the signed-in administrator.

All normal requests require an administrator session. API-tester sessions never
qualify.

## Credential Lifecycle

### Web bootstrap

The web service may hold a Railway credential only while maintenance is absent
or unable to take ownership. It is encrypted into a short-lived HTTP-only
cookie with an AES-256-GCM key derived from `ADMIN_SESSION_SECRET`. Credential
values are never returned by an API response and are never available to browser
JavaScript.

### Settings Vault ownership

The local Settings Vault stores retained OAuth, workspace-token, or
project-token material together with its non-secret Railway project,
environment, workspace, and user identity metadata. The vault encrypts the
complete record with AES-256-GCM under the installation root derived from
`ADMIN_SESSION_SECRET`; neither the credential nor its indexes are plaintext in
the SQLite database. Maintenance receives the credential only through the
authenticated private settings-service API when it must inspect or change the
Railway project.

Releases that previously stored a second encrypted envelope in Supabase migrate
that row lazily. Maintenance writes and verifies `connections/railway` in the
Settings Vault first, then deletes the installation row from the legacy
`railway_connections` table. If deletion is temporarily unavailable, the vault
record remains usable and cleanup retries on the next access.

OAuth access tokens last for a short period. Maintenance uses the retained
refresh token when needed and atomically replaces the vault record with the
newest rotated token returned by Railway. The browser never receives the
retained credential.

Disconnect removes the local encrypted envelope. A dynamically registered
OAuth client is also deleted through its management URI, which revokes its
authorization. Manually created project or workspace tokens must also be
revoked from Railway token settings if they are no longer needed.

## Shared Secrets And Service Creation

Before a service is created, reconciliation examines the environment-level
shared variables and the existing service-local values:

- one existing value can be promoted into the shared environment;
- conflicting values stop the plan without changes;
- generated installation roots are created only when no value exists;
- generated or promoted secret values are sealed before references are attached;
- an existing centralized value that Railway already redacts is preserved and
  never replaced merely to seal it; the plan warns that an administrator can
  seal it once from Railway's Shared Variables page;
- new services receive references such as `${{ shared.SUPABASE_URL }}`, never
  copied plaintext values;
- shared secrets remain bound only to the services listed in the template.

This preserves existing database passwords, service-role keys, internal tokens,
and backup credentials during an upgrade. It also keeps a single source of truth
when a secret changes later.

## Audit And Backup Classification

Every maintenance-run inspection, reconciliation, credential handoff, and
disconnect is recorded in `railway_infrastructure_operations`. The record
contains the target, approved plan, result, administrator authority, timestamps,
and any error, but no plaintext credential.

Railway credential custody and infrastructure history use different backup
boundaries:

| Value                                                        | Manual settings backup | Scheduled data-plane backup | Reason                                                                                  |
| ------------------------------------------------------------ | ---------------------: | --------------------------: | --------------------------------------------------------------------------------------- |
| Railway project/environment identity                         |                    Yes |                          No | It is settings-vault state used to reconnect the same Railway installation              |
| Railway OAuth/token credential                               |                    Yes |                          No | The `.brsettings` container is password-encrypted and restores under the new vault root |
| Infrastructure audit history                                 |                     No |                          No | It describes changes made to the source Railway project                                 |
| Embedding, chunk, model, library, project, and document data |                     No |                         Yes | These values belong to the separate scheduled data-plane archive                        |

The legacy Supabase connection row and infrastructure audit history remain
excluded by `BACKUP_EXCLUDED_TABLES` and
`platform/secret-redaction.v1.json`. The complete encrypted Settings Vault is
exported only through the explicit `.brsettings` backup route.

## Failure And Recovery Rules

- No action is applied when required shared values are missing or existing
  values conflict.
- No action is applied while Railway has unrelated staged environment changes
  that could be committed accidentally during secret sealing.
- A project token must report the same project and environment as the running
  installation.
- Maintenance rejects a handoff targeting a different Railway project or
  environment from its injected runtime identity.
- A failed or timed-out handoff leaves the short-lived bootstrap session intact
  so an administrator can inspect and retry. It does not place a credential in
  application data or logs.
- Unexpected services are never deleted automatically.
- A service with a repo and no branch is never built at all: it reports offline
  with no deployment rather than a failed one. That state is repaired by
  `serviceConnect`, and any service that has never deployed is deployed
  regardless of what else the plan concluded.

## What A Project Token Cannot Do

Railway's environment-scoped mutations name the environment they act on:
`serviceInstanceUpdate`, `serviceInstanceDeployV2`, `variableCollectionUpsert`.
Three do not — `serviceConnect(id)`, `serviceDelete(id)` and `serviceUpdate(id)`
take a service id and nothing else, because they change the service in every
environment at once. A project token is scoped to a single environment, so there
is no scope in which it could authorize them, and Railway answers
`Not Authorized`.

Connecting a GitHub source needs more than scope besides. Railway has to check
that the caller can read the repository, and that permission belongs to a
person's linked GitHub account. A project token is not a person.

So a project token can set variables, change build and deploy settings, create
services and deploy them, but it cannot connect a source, rename a service, or
delete one. **Deleting and recreating a service is not a way around this** —
deletion is refused for the same reason, and attempting it would discard the
variables the service already holds.

The plan lists these as `connect_source`, `rename_service` and `create_service`
actions, and `railwayCredentialCanApply` compares them against the credential
before the first mutation is sent. The review screen reports the conflict and
disables **Apply approved changes**; the apply route refuses outright rather than
failing part-way through a half-applied reconciliation.

Two ways out, either is fine:

- Reconnect with **Connect Railway** (OAuth) or a workspace or account token, and
  apply again.
- Set the branch on the affected services in the Railway dashboard under
  **Settings -> Source**, then apply again with the project token. Everything
  else those services need is environment-scoped.

### What OAuth can and cannot do

OAuth is requested at `project:member`, and Railway maps project scopes onto
project member roles: the access the token receives is what a user with that role
could do in the dashboard. A project Editor can change project settings and
create deployments, so **OAuth can connect a source and repair a missing
branch** — which is the case that matters. Editors explicitly cannot perform
destructive actions, so **OAuth cannot delete a service**. Recreation therefore
refuses for an OAuth credential before deleting anything and names a workspace or
account token instead; repair in place needs none of this.

Raising the request to `workspace:admin` would buy deletion at the cost of
granting admin over every project in the workspace, which is a poor trade for a
path that should almost never run.

## The OAuth Return Leg

### The redirect URI must be https

Railway terminates TLS at its proxy and forwards plain HTTP to the container, so
`new URL(request.url).origin` inside the app reads `http://` even though every
browser reached it over `https://`. The OAuth redirect URI was registered from
that value, and providers refuse to redirect to an insecure redirect URI for
anything but loopback. Consent therefore succeeded, Railway stopped on a page of
its own saying the authentication worked, and the callback was never requested.

The failure leaves no trace in the application, because the application is never
called. The only evidence is in the proxy access log: a
`GET /api/railway/oauth/start` returning 302 with no
`GET /api/railway/oauth/callback` after it. If OAuth ever appears to complete and
change nothing, look there first.

`publicOrigin(request)` in `apps/web/src/lib/public-origin.ts` builds the origin
from `x-forwarded-host` (first hop) and forces `https` for any host that is not
loopback. Both the start and callback routes use it, so the registered redirect
URI, the authorization request, the token exchange and the `postMessage` target
all agree on one origin.

### Returning to the page

The consent screen opens in its own window. `GET /api/railway/oauth/start`
records `presentation: "popup"` in the flow cookie when called with
`mode=popup`, and the callback then answers with a small HTML page that posts
the result to `window.opener` and closes itself, rather than redirecting.

A redirect cannot do this from a popup: the popup is a separate browsing
context, so redirecting it to `/railway` renders a second copy of the page inside
the popup while the original tab waits forever. The message carries the result
only — the credential is in an httpOnly cookie on this origin, which the opener
already has and script cannot read — and the target origin is pinned rather than
`*`. If there is no opener, because the popup was blocked and the browser opened
a tab instead, the page navigates itself to `/railway`, which is the original
behaviour.

**The page does not rely on that message.** It polls `/api/railway/status` until
a connection appears. Whether the popup can reach its opener depends on the
browser, on popup-blocker heuristics, and on whether the consent provider returns
through our callback at all rather than ending on a page of its own saying the
authentication worked and to close the window — and all of those look identical
from the page: consent succeeded and the screen never changed. What is reliable
is the server. If the callback ran, the bootstrap cookie exists and the status
route reports the connection, whatever the popup did or did not manage to say.
The message is the fast path; the poll is the guarantee. If the window closes and
no connection appears within fifteen seconds, the page says so and points at the
token field rather than waiting silently.

Every rejection inside the callback returns the same `connection_failed` to the
browser, because none of them can safely say more to an unauthenticated caller.
The reason is written to the log instead —
`railway_oauth_callback_rejected` with one of `flow_cookie_missing`,
`railway_error:*`, `authorization_code_missing`, `state_mismatch`,
`installation_authority_missing`, `authority_changed:*`, or `exchange_failed:*`.
A missing cookie, a rejected code, and an authority change need entirely
different fixes and used to be indistinguishable.

The setup-session cookie is `SameSite=Lax` for this flow's sake. It was `Strict`,
which browsers withhold on a cross-site top-level navigation — so the callback
returning from railway.com saw no setup session, failed its authority check, and
redirected to `connection_failed`. That broke only the recovery path, because a
signed-in administrator's cookie was already `Lax`, and the recovery path is
exactly when the database is unreachable and OAuth is the way back in. `Lax`
still withholds the cookie from cross-site POSTs, subresource loads and iframes;
the only state-changing route it now reaches is the OAuth callback, which is
independently protected by PKCE, a `state` value, and the flow cookie.

## Reading The Branch

The branch is read from `environment.config.services[serviceId].source.branch` —
the branch the service is configured to build. `latestDeployment.meta.branch`
reads the same but means something different: the branch a past deployment came
from. A service that has never deployed has no deployment metadata at all, so
reading the branch from there reports every never-deployed service as having no
branch, including ones whose source is configured correctly. The deployment
metadata is still the only place the deployed commit can be read, so it remains
the fallback.

It is read out of the environment config rather than requested from GraphQL
because `ServiceSource` has no `branch` field. Asking for one made Railway reject
the entire snapshot query, and that query is the first thing every path runs, so a
single bad field broke the OAuth callback, token connection, preview and apply
simultaneously — each with an error that named the field and nothing else.

The rule this leaves behind: **when the shape is a guess, read it from a JSON
blob, not from a selection set.** A field missing from a blob is null; a field
missing from a selection set is a failed request. A regression test asserts that
the snapshot query never names `branch`.

## Implementation Map

- Web UI: `apps/web/src/app/railway/page.tsx`
- Administrator APIs: `apps/web/src/app/api/railway/`
- Apply job tracking: `apps/web/src/lib/railway-apply-job.ts`
- Bootstrap session and OAuth: `apps/web/src/lib/railway-session.ts` and
  `apps/web/src/lib/railway-oauth.ts`
- Shared inspection and reconciliation: `packages/rag-core/src/railway-control.ts`
- Settings Vault credential custody and legacy migration:
  `apps/maintenance/src/railway-credentials.ts`
- Maintenance controller: `apps/maintenance/src/railway-infrastructure.ts`
- Database contract:
  `supabase/migrations/20260810000100_railway_infrastructure_control.sql`

Railway OAuth and API details are documented by Railway in
[Creating an OAuth app](https://docs.railway.com/integrations/oauth/creating-an-app),
[Login and tokens](https://docs.railway.com/integrations/oauth/login-and-tokens),
and [Manage services](https://docs.railway.com/integrations/api/manage-services).
