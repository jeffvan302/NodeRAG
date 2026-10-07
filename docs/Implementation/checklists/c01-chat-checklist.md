# C01 — Ollama Cloud Administration Checklist

**Status:** Testbed complete
**Environment:** F-drive worktree; Windows x64 UI and WSL2 Linux/amd64 Docker integration tests
**Recorded:** 2026-09-15

## Cloud-only boundary

- [x] Every Chat Ollama capability is explicitly Ollama Cloud, never local or self-hosted Ollama.
- [x] The service root is fixed to `https://ollama.com` and cannot be supplied by an administrator.
- [x] The adapter constructs only `/api/tags`, `/api/chat`, `/api/web_search`, and
      `/api/web_fetch` below the fixed HTTPS root.
- [x] Requests use bearer authentication, reject redirects, have a 30-second default timeout, and
      enforce a 2 MiB default response limit.
- [x] Model generation, hosted internet search, and hosted web fetch share one encrypted key but
      keep independent health states.
- [x] Ollama Cloud is recorded as the Chat internet-search provider even when a later OpenAI OAuth
      model generates the answer.

## Persistence and recovery

- [x] Migration `000019_chat_provider_foundation` creates constrained provider connections,
      per-capability health, model profiles, and per-principal Chat entitlements.
- [x] Ollama Cloud and OpenAI OAuth connection rows are seeded disabled.
- [x] The existing encrypted-secret vault stores the Ollama Cloud key; APIs never return plaintext
      or ciphertext.
- [x] A blank key field retains the saved key; replacement and clearing are explicit actions.
- [x] Disabling stops Cloud activity while retaining the key; clearing disables the connection and
      removes the key.
- [x] Settings, key fingerprints, model profiles, and health survive an API restart.
- [x] Full encrypted backup/restore preserves the key but restores the provider disabled with every
      capability requiring revalidation.
- [x] Chat provider tables are classified for full recovery and excluded from portable corpus
      exports.

## Administration API and safety

- [x] Server-admin GET, PUT, explicit disable, model refresh, generation test, web-search test, and
      web-fetch test routes exist.
- [x] Search-only principals receive a non-enumerating 404; anonymous and non-admin principals are
      denied.
- [x] Every mutation requires CSRF and an idempotency key.
- [x] Custom/local address fields are rejected by the strict update schema.
- [x] Candidate-key tests do not replace the stored key.
- [x] Safe error categories cover timeout, cancellation, unreachable service, rejected credentials,
      rate limiting, missing model, 5xx, malformed JSON, and oversized responses.
- [x] Audit records and structured logs contain capability, latency, safe error category, and
      fingerprint/status metadata without credentials or provider response bodies.
- [x] Route authorization and generated OpenAPI inventories contain all seven C01 endpoints.

## Administration interface

- [x] **Chat providers** appears only when the provider-foundation endpoint is enabled.
- [x] The Ollama Cloud card explains that it is not a local Ollama installation and that generation
      and internet-search data leave NodeRag.
- [x] The Cloud service address is visible and read-only.
- [x] The protected key field has clear retain, replace, disable, and clear behavior.
- [x] The selected model, parallel-call limit, optional request/token limits, and enabled state are
      editable and persist after navigation.
- [x] Authenticated model refresh populates model choices without inventing context limits.
- [x] Model catalog, generation, internet search, and web fetch have separate status, latency,
      failure, and test controls.
- [x] The browser flow passes an automated WCAG A/AA scan.
- [x] No user-facing Chat navigation, composer, or answer-generation path is enabled in C01.

## Verification

- [x] Ollama Cloud unit and contract/recovery unit checks pass (21 focused checks).
- [x] Database-backed provider administration checks pass (9 checks).
- [x] Full encrypted recovery integration checks pass (4 checks).
- [x] Focused browser configure/test/save/replace/clear/reload/accessibility workflow passes.
- [x] Full browser suite passes (21 checks).
- [x] Full workspace unit suite passes (42 files, 163 checks).
- [x] Migration, OpenAPI, type-check, lint, formatting, dependency-boundary, build, smoke, license,
      SBOM, and secret-scan gates pass together.
- [ ] Optional live Ollama Cloud tests are not part of the deterministic automated gate; run them
      only with an explicitly approved test account and synthetic/non-private inputs.

## Exit gate

C01 is **testbed complete**. An administrator can configure Ollama Cloud once, retain/replace/clear
the encrypted key safely, refresh the account model list, and independently verify generation,
hosted internet search, and hosted web fetch. No local Ollama address is accepted. C02 OpenAI OAuth
Administration is authorized; Chat remains disabled.
