# Update And Deploy Batch Command

Last reviewed: 2026-08-03.

The repository-root `update-and-deploy.bat` command provides one guarded
release flow for GitHub, Supabase, Railway, and system tests. Double-click the
file for an interactive production release, or run it from PowerShell to pass
options.

## What It Does

1. Confirms `git`, GitHub CLI, Railway CLI, Node.js, and a pnpm runner are
   installed and logged in. The script accepts `pnpm`, falls back to
   a temporary `corepack pnpm` shim, and finally falls back to a temporary
   shim for the repository-pinned pnpm version through `npx`. Temporary shims
   are removed when the command exits.
2. Requires `main` for production or `dev` for staging and stops when the local
   branch is behind GitHub.
3. Runs the same local gates as GitHub CI: frozen dependency install,
   documentation coverage, type checking, tests, and the complete build.
4. Shows every uncommitted path. It stages nothing unless you type `ALL`, pass
   `-StageAll`, or explicitly choose already staged files.
5. Rejects common secret file types, checks the staged diff, creates a commit,
   and pushes the target branch to GitHub.
6. Runs and waits for the environment's Supabase GitHub Actions workflow. This
   applies all pending migrations; production also deploys the
   `gte-small-embedding` Edge Function.
7. Waits for GitHub-triggered Railway deployments of `web` and `worker`. If an
   affected service does not receive the expected GitHub build, it deploys a
   clean archive of the committed source. When a commit does not affect a
   service, it verifies and retains that service's latest healthy deployment
   instead of consuming a redundant build. Worker/shared-runtime changes also
   include `embeddings`.
8. Waits for the GitHub Tests workflow.
9. Checks the public API health endpoint and runs the deployed embedding smoke
   command from the Railway web service. The embedding check retries with
   bounded waits when the dedicated service is waking from a cold start.
10. Optionally runs the comprehensive authenticated Bubble REST smoke suite.

The command stops immediately when a test, migration, deployment, or smoke
check fails. It prints the failed GitHub run URL or recent Railway deployment
logs when available.

## Prerequisites

Install and authenticate these tools once:

```powershell
git --version
gh auth login
railway login
pnpm --version
# If pnpm is not directly available:
corepack pnpm --version
```

Railway CLI must be linked to the `RAG Railway` project. During the rename
transition, the release helper also accepts the legacy `BubbleAPI` project name.
The normal production link can be checked with:

```powershell
railway status
```

GitHub must contain the Supabase environment secrets documented in
[database construction](../database/database-construction.md). The batch file
does not read or store Supabase credentials locally. Before running a
Supabase workflow, it verifies that the three required secret names are
available at either repository or matching GitHub environment scope.

## Interactive Production Release

Double-click:

```text
update-and-deploy.bat
```

When changes are present:

1. Review the printed `git status` list.
2. Type `ALL` to include every listed file, or stage selected files yourself
   before starting and type `STAGED`.
3. Enter a concise commit message.
4. Type `COMMIT` after reviewing the staged diff summary.
5. Type the exact phrase `DEPLOY PRODUCTION` before any production push or
   deployment begins.

The window pauses at the end so a double-clicked run remains readable.

To retain all interactive review steps but skip only the final
`DEPLOY PRODUCTION` phrase, add `--Commit`:

```powershell
.\update-and-deploy.bat --Commit
```

`--Commit` confirms the production deployment. It does not skip validation,
automatically stage files, choose a commit message, or bypass the staged diff
review.

## PowerShell Examples

Release all current changes to production:

```powershell
.\update-and-deploy.bat -StageAll -CommitMessage "Describe the update"
```

Release and skip the final production confirmation phrase:

```powershell
.\update-and-deploy.bat -StageAll -CommitMessage "Describe the update" --Commit
```

Validate the code without committing or deploying:

```powershell
.\update-and-deploy.bat -ValidateOnly
```

Preview release commands without changing GitHub, Supabase, or Railway:

```powershell
.\update-and-deploy.bat -DryRun -SkipLocalTests
```

Non-interactive production release for already staged files:

```powershell
$env:BUBBLE_RAG_NO_PAUSE = "1"
.\update-and-deploy.bat `
  -UseStaged `
  -CommitMessage "Describe the update" `
  -NonInteractive `
  -ConfirmProduction
```

Deploy staging from the `dev` branch:

```powershell
.\update-and-deploy.bat `
  -Environment staging `
  -ApiBase "https://your-staging-domain.example/api/v1" `
  -StageAll `
  -CommitMessage "Test the staging update"
```

Force the embeddings service into the Railway service set even when no shared
worker path changed:

```powershell
.\update-and-deploy.bat -IncludeEmbeddings
```

## Full Authenticated API Smoke Test

The default post-deployment tests verify public health and the private Railway
embedding path. The full Bubble API smoke suite creates temporary project,
document, extraction, Task, and generated-file records, then cleans up what it
created. It requires a sufficiently scoped Railway API key.

Set the key only in the current terminal session and request the full suite:

```powershell
$env:BUBBLE_RAG_API_KEY = "brk_your_test_key"
.\update-and-deploy.bat -FullApiSmoke
Remove-Item Env:BUBBLE_RAG_API_KEY
```

The key is passed through the process environment. It is never written by the
batch file, printed, committed, or added to Railway/Supabase configuration.

## Useful Options

| Option                                 | Effect                                                          |
| -------------------------------------- | --------------------------------------------------------------- |
| `-Environment production` or `staging` | Selects branch, Supabase workflow, and Railway environment.     |
| `-StageAll`                            | Stages all current changes without asking for `ALL`.            |
| `-UseStaged`                           | Commits only files already staged with Git.                     |
| `-CommitMessage "..."`                 | Supplies the Git commit message.                                |
| `--Commit`                             | Skips only the final `DEPLOY PRODUCTION` confirmation phrase.   |
| `-ConfirmProduction`                   | PowerShell-style equivalent of `--Commit`.                      |
| `-ValidateOnly`                        | Runs preflight and local gates, then stops.                     |
| `-DryRun`                              | Prints mutating commands without executing them.                |
| `-IncludeEmbeddings`                   | Always includes the Railway embeddings service.                 |
| `-FullApiSmoke`                        | Runs the authenticated Bubble API smoke suite after deployment. |
| `-SkipInstall`                         | Skips `pnpm install --frozen-lockfile`.                         |
| `-SkipLocalTests`                      | Skips local docs/type/test/build gates.                         |
| `-SkipSupabase`                        | Does not invoke the Supabase workflow.                          |
| `-SkipRailway`                         | Does not verify or deploy Railway services.                     |
| `-SkipGitHubTests`                     | Does not wait for the pushed commit's GitHub Tests run.         |
| `-SkipEmbeddingSmoke`                  | Does not wake/test the Railway embedding service.               |
| `-SkipSmokeTests`                      | Skips all post-deployment smoke checks.                         |
| `-NonInteractive`                      | Disables prompts; use `--Commit` or `-ConfirmProduction`.       |

Skip options are intended for diagnosis or a deliberately partial release.
The normal release should retain all validation and deployment phases.

## Failure And Recovery

- A local test failure happens before commit or push. Fix the failure and run
  the batch file again.
- A Supabase workflow failure leaves the Git commit on GitHub but stops Railway
  monitoring and smoke tests. Open the printed workflow URL, fix the migration
  or missing GitHub environment secret, then rerun.
- A Railway failure prints recent deployment logs. The successful Supabase
  migration is not rolled back automatically; fix forward with a new migration
  when schema correction is required.
- An API or embedding smoke failure means deployment completed but acceptance
  did not. Diagnose the reported service before uploading production data.
- Re-running with no new changes safely reapplies the idempotent Supabase
  migration workflow, verifies affected commit deployments, and retains
  healthy deployments for services that commit did not change.

## When A Release Adds A Service

Merging `dev` into `main` redeploys the services that already exist. It does not
create ones the release introduces — Railway only builds what is already in the
project — so a release that adds a service leaves that service absent, and a
release that adds a service *and* moves a variable onto it leaves the variable
homeless too. `SUPABASE_DB_PASSWORD` moving from web to maintenance is the case
that has actually happened.

The recovery path is the `/railway` screen, and it is reachable without the
database: sign in with `ADMIN_SETUP_TOKEN`, connect Railway, review the plan,
supply any values the plan asks for, and approve. Web creates the missing
services, waits for maintenance to build, and then queues the schema upgrade
itself. Apply reports each step as it runs, so a long wait can be told apart from
a stall. See
[Railway connection and service reconciliation](./railway-connection-and-service-reconciliation.md).
