# C11 Chat Release and Synology Operations

**Status:** Testbed qualification in progress
**Candidate:** `noderag-1.0.0-45-x86_64.spk`
**Database head:** `000029_chat_files`

## Non-negotiable provider boundary

For Chat, **Ollama always means Ollama Cloud**. NodeRag fixes the service root to
`https://ollama.com`; administrators can enter an API key and select hosted models, but cannot enter
a local, self-hosted, forwarded, or custom Ollama address. Chat generation uses
`https://ollama.com/api/chat`. Chat internet search and page retrieval use the same encrypted
Ollama Cloud credential with `https://ollama.com/api/web_search` and
`https://ollama.com/api/web_fetch` respectively. The separate document-vision integration is not
the Chat provider and may retain its independently configured Ollama-compatible endpoint.

## Candidate production sequence

Run each gate against the same F-drive worktree. Do not number or distribute a package from a tree
that changed after its evidence was recorded.

1. Verify all migration files and regenerate the OpenAPI and route-authorization inventories.
2. Run type checking, linting, formatting, dependency boundaries, unit tests, PostgreSQL integration
   tests, browser/accessibility tests, production build/smoke, license policy, SBOM, and secret scan.
3. Validate the eight-case C11 conversation-evaluation catalog and its mapped automated evidence.
4. Regenerate and verify the release freeze after every frozen input has stopped changing.
5. Build revision 45 with the pinned Node 22, PostgreSQL 17.11, pgvector 0.8.6, and production
   dependencies. Record the SPK SHA-256.
6. Inspect the package archive and run the non-root package-user lifecycle simulation. This must
   cover Chat configuration/storage, an artifact across restart, full backup inclusion,
   feature-disabled rollback, retained uninstall/reinstall, and destructive purge.
7. Run the revision-26-to-45 forward-upgrade simulation. Authentication, knowledge base, document,
   existing search index, Research collection, and root encryption key must survive without a
   document re-index.
8. Run the 90-second mixed-workload qualification. Only after it passes, start the minimum 1-hour
   mixed Chat/artifact/ingest/search/backup/restart/resource soak against the identical SPK.
9. Verify that the release freeze is still byte-for-byte unchanged, then write the C11 proof outside
   the freeze. Never regenerate a frozen package input after package qualification.
10. Install that exact checksum on a real Synology and complete the DSM acceptance matrix below.
11. Keep `releaseAuthorized=false` until every DSM row passes. A code or package change creates a
    new candidate and invalidates the package, soak, and DSM evidence.

## Docker commands

From WSL at the repository root:

```text
pnpm ci:quality
pnpm test:integration
pnpm test:e2e
pnpm evaluation:chat:c11
pnpm release:freeze
pnpm release:freeze:verify
pnpm package:candidate
pnpm package:candidate:verify
bash scripts/simulate-c11-upgrade.sh
bash docker-testbed/scripts/m14-soak.sh validate
bash docker-testbed/scripts/m14-soak.sh start
```

Use `bash docker-testbed/scripts/m14-soak.sh status` and `... logs` to inspect the long soak. Its
proof is written under `docker-testbed/artifacts/m14/`. The local HTTP test double used by this soak
is exclusively a document-vision outage fixture; it is never a Chat or Chat-internet provider.

## DSM acceptance matrix

Use synthetic data and a dedicated test credential. Record the NAS model, DSM build, installed
dependency versions, package checksum, start/end timestamps, and safe error references. Never put
an API key, OAuth token, setup key, backup passphrase, or private document in the evidence.

1. Upgrade an installed revision 26 through Package Center and confirm the prior administrator,
   knowledge bases, documents, all four search modes, Research collections, settings, and encrypted
   credentials remain available without re-indexing.
2. Confirm the package runs as the DSM-created `noderag` account, PostgreSQL has no TCP listener,
   and package data plus selected `.noderag-chat` storage are writable only through intended ACLs.
3. From the trusted LAN, open `http://<ip address>/noderag/`. Verify sign in, CSRF-protected writes,
   asset loading, streaming reconnect, downloads, and viewer links. Public/WAN access, external DNS,
   certificate management, and internet-facing reverse proxies are explicitly outside the v1 scope.
4. In Administration → Chat Providers, save one Ollama Cloud key, refresh hosted models, and test
   generation, web search, and web fetch independently. Network inspection must show only the fixed
   `ollama.com` endpoints and must not expose the credential in bodies, UI, logs, or evidence.
5. If OpenAI OAuth is in release scope, complete the device-code flow using the dedicated test
   account, refresh models, restart the package, and test generation. Otherwise record it as not
   certified and do not claim support.
6. Create rolling and managed-context chats; test streamed output, cancellation, retry, Research
   attachments, grant revocation, all RAG search modes, Ollama Cloud internet citations, PDF and
   Markdown viewer links, artifact create/edit/history/download, DOCX/PDF export, and exact-revision
   ingestion. Upload two Chat images with the same original filename and verify their distinct
   `/noderag/chat/<chat-id>/file/<file-id>.<extension>` URLs render in managed Markdown, survive a
   package restart/full backup restore, remain owner-only, and stop resolving after confirmed delete.
7. Restart the package and reboot DSM while work is idle, then while a synthetic Chat run is active.
   Confirm terminal recovery is explicit, committed history remains readable, archives verify, and
   no run remains indefinitely leased.
8. Run a full encrypted backup, verify it, restore it into an isolated acceptance installation, and
   confirm Chat tables, log segments, artifacts, manifests, and safe reset of in-flight work. Cloud
   credentials must restore disabled unless protected by the restored package root key.
9. Exercise feature-disabled rollback with `NODERAG_CHAT_ENABLED=0`; core ingestion, Research, and
   search must continue while Chat routes are unavailable and Chat data remains intact.
10. Observe CPU, memory, disk, browser history performance, active runs, provider capacity, quota,
    context compression, archive health, and reconciliation throughout a representative concurrent
    load. Compare with the release ceilings rather than judging only by UI responsiveness.
11. Verify retained uninstall/reinstall and, only on disposable test data, the explicit destructive
    purge path.

## Release decision

The candidate passes only if automated gates, the exact-SPK package simulations, minimum 1-hour
soak, and every applicable DSM acceptance item pass. Any unresolved provider, storage, migration,
authorization, credential, backup, restart, or resource-ceiling failure blocks release. Docker
success is valuable qualification but is not a substitute for the live DSM result.
