# C03 — Context Window and Chat Settings Administration Checklist

**Status:** Testbed complete
**Environment:** F-drive worktree; Windows x64 and WSL2 Linux/amd64 Docker testbed
**Recorded:** 2026-09-15

## Persistence and revision safety

- [x] Migration 000021 adds administrator and known-model capacity evidence without editing applied
      provider migrations.
- [x] Context and Chat settings are separate append-only revisions with UUID identities.
- [x] The current configuration pointer updates transactionally.
- [x] Changing context creates a paired settings revision and safely falls back to rolling mode until
      managed layers are retested.
- [x] Database triggers reject normal update/delete attempts against revision rows and allow only the
      transaction-scoped verified recovery path.
- [x] Provider catalog refresh preserves administrator capacity overrides and evidence notes.
- [x] Full encrypted recovery includes configuration and restores provider connections disabled;
      portable corpus export excludes installation-specific Chat configuration.

## Capacity and context policy

- [x] Context precedence is runtime, configured, advertised, administrator fallback, versioned
      known-model, then Unknown.
- [x] Output precedence is provider metadata, administrator fallback, versioned known-model, then
      Unknown.
- [x] Authentication or catalog success never fabricates a context limit.
- [x] Reserve arithmetic rejects a fully consumed known window and oversized output reservations.
- [x] Rolling selection groups complete user/assistant/tool turns rather than counting message rows.
- [x] Managed L1–L4 settings require complete L2/L3 model, effort, instructions, output target, and L3
      schema values.
- [x] Both `openai_oauth` and `ollama_cloud` are accepted for L2 and L3.
- [x] Managed configuration requires verified capacities; output targets cannot exceed model limits.
- [x] Synthetic preview uses fake content, reports before/after estimates, pins, layer states/errors,
      recent turns, and projected calls, then records independent L2/L3 readiness.

## Defaults, Cloud boundary, and storage

- [x] Initial defaults are rolling context, Research/RAG/internet off, bounded calls and timeouts,
      quotas, retention, and Markdown-only output.
- [x] A default response model must be current, enabled, generation-healthy, and use a catalog effort.
- [x] Managed default mode is rejected until both current layer checks are healthy.
- [x] Internet default is rejected unless fixed-endpoint Ollama Cloud `web_search` and `web_fetch` are
      independently healthy, including when OpenAI is the generation model.
- [x] No local, forwarded, custom-address, or self-hosted Ollama path is introduced.
- [x] Chat storage probing accepts only an absolute server path and creates a contained private
      `.noderag-chat/manifest.json`.
- [x] Existing valid manifests are reused; occupied, malformed, escaped, unwritable, full, and
      policy-invalid storage fails closed.

## Administration API and interface

- [x] Configuration read, context save/preview, settings save, capacity override, and storage probe
      routes are registered.
- [x] All six routes are server-admin only; search-only credentials receive 404.
- [x] All mutations require CSRF and idempotency.
- [x] Route authorization and generated OpenAPI inventories contain every C03 route.
- [x] Administration adds Context window and Chat settings only when the C03 flag is enabled.
- [x] Forms explain capacity provenance, reserves, rolling turns, L1–L4, quotas, retention, storage,
      and independent data/tool switches.
- [x] The interface repeatedly identifies Ollama Cloud as Chat's sole internet provider.
- [x] Provider/model-dependent effort options, unknown warnings, managed readiness, and internet
      readiness are visible and fail closed.
- [x] Responsive layout and focused WCAG A/AA browser checks pass.
- [x] Chat navigation and prompt execution remain disabled.

## Verification

- [x] Pure unit checks cover capacity precedence, output precedence, reserve arithmetic, complete
      turns, token estimates, schemas, synthetic preview, and storage manifests.
- [x] Linux/amd64 PostgreSQL integration covers access control, defaults, immutable revisions,
      L2/L3 preview, persistence/restart, overrides, Cloud-only internet, storage, and faults.
- [x] Encrypted recovery integration passes with migration 000021 and restored Chat configuration.
- [x] Focused browser workflow passes with WCAG A/AA scans for both new Administration screens.
- [x] Full browser suite passes: 23/23.
- [x] Full unit suite passes: 45 files and 186 tests; the combined workspace quality gate passes.
- [x] Real DSM ACL/filesystem execution is explicitly deferred to the C11 package gate.

## Exit gate

C03 is closed after all deterministic checks above passed. Chat stays hidden. C04 may now add
durable owner-scoped conversations without tools; C07 remains the only stage that exposes bounded
Ollama Cloud internet search/fetch to a Chat run.
