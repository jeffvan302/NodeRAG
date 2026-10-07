# C00 — Chat Scope, Privacy, and Feasibility Checklist

**Status:** Testbed complete
**Environment:** F-drive worktree; Windows x64 and WSL2 Ubuntu 24.04 x86_64
**Recorded:** 2026-09-15

## Architecture and security

- [x] Cloud egress amendment records what Ollama Cloud and OpenAI may receive.
- [x] Ollama is fixed to direct Ollama Cloud for Chat; local/self-hosted/custom URLs are excluded.
- [x] Ollama Cloud is the sole Chat internet-search and web-fetch provider.
- [x] System-wide provider administration and per-user Chat ownership are defined.
- [x] Chat entitlement defaults and search-only API-key exclusion are defined.
- [x] Current knowledge-space authorization is required on every Research/RAG document access.
- [x] Retention, archive, purge, provider disconnect, backup, and restore behavior are defined.
- [x] Threat controls cover provider credentials, prompt injection, cross-silo reads, SSRF, context
      exhaustion, unsafe paths/content, interruption, and corrupt logs.
- [x] Models receive neither shell/filesystem/database access nor unrestricted networking.
- [x] Hidden chain-of-thought is excluded; only provider-supplied displayable summaries are allowed.

## Executable foundation

- [x] Versioned `ChatProvider` request, model-profile, event, and tool-definition contracts exist.
- [x] Event order, unique tool calls, safe failure terminals, and request bounds are validated.
- [x] Deterministic Ollama Cloud and OpenAI OAuth fake providers exist.
- [x] All nine rollout flags exist, default off, and enforce activation dependencies.
- [x] Focused contract/flag tests pass (6 tests).
- [x] Server TypeScript check passes with the new foundation.

## Provider-runtime feasibility

- [x] `@openai/codex` is pinned at `0.147.0` and locked as a server dependency.
- [x] Package metadata reports Apache-2.0 and Linux x64/arm64 platform packages.
- [x] App-server starts on Windows x64, completes `initialize`, and returns unauthenticated
      `account/read` status using an isolated temporary credential store.
- [x] The same app-server smoke check passes inside WSL2 Linux x86_64.
- [x] The app-server smoke check passes inside an isolated Node 22 Linux/amd64 Docker container with
      networking disabled.
- [x] A working Linux Docker Engine is available inside WSL2 after Docker Desktop's internal socket
      failure was isolated without resetting its container data.
- [x] The dependency, license, security, formatting, lint, boundary, workspace type-check, and full
      unit gates pass together after all C00 files are finalized.

## Exit gate

C00 is **testbed complete**. The architecture, provider contract, disabled rollout boundary, and
Windows/WSL/Docker runtime feasibility gates pass. C01 schema/provider persistence is authorized;
all user-visible Chat behavior remains disabled.
