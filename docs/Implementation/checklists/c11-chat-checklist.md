# C11 — Security, Evaluation, Operations, and DSM Candidate Checklist

**Status:** In progress
**Environment:** F-drive worktree; WSL2 Linux/amd64 Docker testbed; real DSM required for closure
**Candidate:** `noderag-1.0.0-45-x86_64.spk`

## Ollama Cloud boundary

- [x] Chat generation uses only `https://ollama.com/api/chat`.
- [x] Chat internet search/fetch uses only Ollama Cloud hosted APIs and the same encrypted key.
- [x] Chat exposes no local, self-hosted, forwarded, or custom Ollama endpoint.
- [x] The vision-only local test double is explicitly separated from Chat evidence.

## Combined implementation

- [x] Adversarial coverage includes prompt injection, secret confinement, undeclared tool
      escalation, owner/grant isolation, path/symlink/quota controls, malicious Markdown, SSRF, and
      archive tampering.
- [x] Eight-case conversation evaluation catalog maps Research, RAG, web, citations, artifacts,
      compression, refusal, and recovery to executable evidence.
- [x] Administration Chat Health reports providers, runs, capacity, context, storage, archives,
      reconciliation, quotas, safe errors, latency, context growth, compression, and process memory.
- [x] Full backup/restore covers Chat database state, encrypted provider credentials, log segments,
      artifacts, manifests, destination storage rebinding, and safe in-flight reset.
- [x] Synology launcher defaults Chat phases on and supports feature-disabled rollback through the
      master Chat flag without deleting migrated state.
- [x] Package lifecycle simulation exercises durable Chat configuration and artifact state.
- [x] Chat image uploads use owner-only chat/file UUID routes, tolerate duplicate original names,
      retain the DSM `/noderag/` mount in copied URLs, and render in managed Markdown.
- [ ] Revision 26 → 45 forward-upgrade simulation passes against the built candidate.
- [ ] All final workspace gates pass after the release freeze inputs stop changing.
- [ ] Exact revision 45 SPK builds reproducibly, verifies, and has a recorded SHA-256.
- [ ] Short mixed workload passes against the exact SPK.
- [ ] Minimum 1-hour mixed Chat/ingest/search soak passes against the exact SPK.

## Live DSM acceptance

- [ ] Exact SPK checksum and DSM/NAS identity are recorded.
- [ ] Package-account ACL, `.noderag-chat` storage, Web Station aliases, and non-root runtime pass.
- [ ] Ollama Cloud key restart persistence plus generation/search/fetch pass on the fixed endpoints.
- [ ] OpenAI OAuth device sign-in/restart passes, or the provider is explicitly excluded from claims.
- [ ] Streaming, tools, citations, viewers, artifacts, exports, exact-revision ingestion, managed
      context, old-log paging, and reconciliation pass with synthetic data.
- [ ] DSM restart/reboot and active-run recovery pass.
- [ ] Full backup/isolated restore and credential safety pass.
- [ ] CPU, memory, disk, concurrency, browser history, and 1-hour resource ceilings pass.
- [ ] Retained uninstall/reinstall and disposable destructive purge pass.

## Exit gate

C11 remains open until the exact revision 45 package passes the final automated freeze, 1-hour
soak, and live Synology matrix. The package remains a private test candidate and
`releaseAuthorized=false` until then.
