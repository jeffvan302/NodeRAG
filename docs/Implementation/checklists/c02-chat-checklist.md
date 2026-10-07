# C02 — OpenAI OAuth Administration and Model Catalog Checklist

**Status:** Testbed complete
**Environment:** F-drive worktree; Windows x64 and WSL2 Linux/amd64 Docker testbed
**Recorded:** 2026-09-15

## Supervised app-server boundary

- [x] `@openai/codex` remains pinned exactly to `0.147.0`.
- [x] Newline-delimited JSON-RPC handles fragmented lines, concurrent out-of-order responses, and
      in-order notifications.
- [x] Request IDs, frames, pending calls, timeouts, stderr, and shutdown time are bounded.
- [x] Malformed JSON, malformed frames, invalid/unknown response IDs, stream failure, heartbeat
      failure, and unexpected process exit fail closed.
- [x] Startup performs protocol initialization; shutdown closes stdin, waits briefly, then terminates
      a stuck process.
- [x] App-server runs with analytics disabled, file-backed managed ChatGPT credentials, a forced
      ChatGPT login method, hidden child windows, and a package-private `CODEX_HOME`.
- [x] The C02 method allow-list contains only login/account/rate-limit/catalog operations. Thread,
      turn, shell, filesystem, and arbitrary methods are denied; Chat execution remains disabled.
- [x] The production build includes the pinned Linux x64 app-server package and executable.

## Device-code and credential lifecycle

- [x] Login always calls `account/login/start` with `{type:"chatgptDeviceCode"}`.
- [x] The browser receives only the login ID, copyable user code, approved HTTPS verification URL,
      local expiry, state, and a safe error code.
- [x] Browser-supplied API keys, access tokens, refresh tokens, auth caches, and extra login fields
      are rejected.
- [x] A pending login is reused, may be cancelled by its initiating administrator, and expires after
      15 minutes.
- [x] Completion notifications handle success, denial, mismatched login IDs, and credential-cache
      persistence.
- [x] The managed credential cache has a 512 KiB limit, JSON validation, non-symbolic path checks,
      and owner-only permissions on Unix.
- [x] Successful login and explicit account refresh encrypt the cache through NodeRag's secret vault.
- [x] Encrypted credentials restore into the isolated home before app-server starts after restart.
- [x] Disconnect requires confirmation, logs out, deletes both encrypted and private-file copies,
      clears the selected model, and disables OpenAI capabilities.
- [x] Diagnostic stderr redacts bearer credentials, token/secret fields, JWTs, and API-key patterns.
- [x] Full encrypted recovery preserves the credential but restores the provider disabled and
      requiring revalidation; portable export excludes it.

## Account and live model catalog

- [x] Account status supports non-refreshing reads and an explicit managed refresh during testing.
- [x] The API exposes a bounded account/plan summary without credential material.
- [x] Rate-limit windows are shown when supplied and remain unavailable rather than zero when absent.
- [x] Model discovery requests 100 entries per page, follows at most 10 unique cursors, and filters
      hidden models.
- [x] Live supported/default reasoning efforts and input modalities are persisted and displayed.
- [x] Safe future reasoning-effort identifiers survive catalog ingestion without widening execution.
- [x] Missing input modalities use the documented text-and-image compatibility default.
- [x] Removed selected models fall back to the live default; existing selected models remain selected.
- [x] Context and output token limits remain null/Unknown because login and `model/list` do not
      establish them.

## Administration API and interface

- [x] Status, settings, login, cancel, refresh-models, test, and disconnect endpoints are registered.
- [x] All seven endpoints are server-admin only; search-only credentials receive a non-enumerating
      404.
- [x] Every mutation requires CSRF and an idempotency key.
- [x] Route authorization and generated OpenAPI inventories contain every C02 endpoint.
- [x] Mutations and login completion emit credential-free audit records with stable error categories.
- [x] The provider card includes copyable device code, OpenAI verification link, pending polling,
      navigation recovery, account/plan summary, live model selection, capability health, rate limits,
      and confirmed disconnect.
- [x] The interface states that one shared account supplies authorized users' capacity and billing.
- [x] The interface states that OpenAI generates responses only and Ollama Cloud remains Chat's sole
      internet search/web-fetch provider.
- [x] The browser workflow passes an automated WCAG A/AA scan and responsive fields collapse on
      narrow screens.
- [x] No Chat navigation, conversation, prompt submission, or OpenAI browsing path is enabled.

## Verification

- [x] Protocol/security/OAuth/catalog focused unit checks pass.
- [x] Database-backed provider routes and migration 000020 pass in Linux/amd64 Docker (13 checks),
      including capability-health reset after model changes and provider re-enablement.
- [x] Updated encrypted recovery test, including the OpenAI credential and disabled restored state,
      must pass in Linux/amd64 Docker.
- [x] Pinned app-server initialization/account/catalog smoke passes on Windows x64.
- [x] Source-tree and production-built pinned app-server smoke pass in Linux/amd64 Docker.
- [x] Focused browser sign-in/model/disconnect/accessibility workflow passes.
- [x] Full browser suite passes (22 checks).
- [x] Full unit suite passes (44 files, 177 checks).
- [x] Final migration, OpenAPI, type-check, lint, formatting, dependency-boundary, build/smoke,
      license, SBOM, and secret-scan gate passed after the final implementation changes.
- [ ] Optional live OpenAI sign-in/generation is not part of the deterministic gate and requires an
      explicitly approved dedicated test account with synthetic input.
- [ ] Real Synology DSM execution remains the C11 package gate.

## Exit gate

C02 is **testbed complete**. OpenAI OAuth survives a NodeRag restart, model/effort choices come from
the connected account, and neither credential material nor private reasoning is exposed. Optional
live-account verification and real Synology execution remain explicitly deferred. Chat remains
disabled; C03 is authorized.
