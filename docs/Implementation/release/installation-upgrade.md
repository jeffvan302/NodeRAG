# Installation and Upgrade — 1.0.0-rc.1

## Before installation

1. Use only `noderag-1.0.0-46-x86_64.spk`. Package revision 46 replaces revisions 1–45. It is the
   current Chat-capable Synology test candidate. Revision 46 makes the Linux/x86_64 SBOM
   cross-platform deterministic and restores the isolated thin-package lifecycle simulator while
   retaining revision 45's managed-context concurrency and PDF Research-loading fixes. For Chat,
   Ollama is always Ollama Cloud at the fixed
   `https://ollama.com` service; its encrypted API key is used for Chat generation, web search, and
   web fetch. Local/custom Ollama endpoints are not a Chat option. Revision 46 retains revision 26's
   fix for the Administration settings reload so saved embedding-thread and ingest-worker values remain
   visible after changing tabs or returning to Settings, and standardizes the saved settings API
   response. It retains revision 25's live Administration controls for embedding CPU threads and background document concurrency,
   detected-versus-active processor reporting, three safe resource presets, controlled embedding
   engine reload, persistence across Package Center restarts, and an interactive CPU reservation for
   searches and semantic PDF highlighting. It retains revision 24's repair for
   a regression that could suppress the background semantic request when a search result already
   contained green-highlight evidence, requests up to four qualifying semantic sentences, and
   displays a clear status if processing fails, no sentence meets the threshold, or PDF text cannot
   be aligned. It retains revision 23's immediate exact highlights, semantic cache, and render-time
   improvements, revision 22's repaired PDF evidence alignment and page-level Research
   references, revision 21's rolling ingestion log and PDF bounds repair, and revision 20's Ollama
   Cloud defaults:
   `minimax-m3:cloud`, two parallel calls, three images per call, a
   120-second call timeout, three attempts, and a 1650-pixel image limit. Leaving the API-key field
   blank now reuses the encrypted saved credential during the connection test. It includes revision
   19's enhanced PDF extraction and re-index fixes plus all earlier DSM fixes.
2. Compare its SHA-256 with the attached `.sha256` file before opening Package Center.
3. Confirm x86_64, DSM 7.2-64570 or newer, Synology `Node.js_v22` and `WebStation`, port 8787
   availability, adequate RAM, and enough package plus data-volume space for the corpus, model,
   and one full rebuild. Package Center should offer to install either missing dependency.
4. Select a package-data volume and separate backup destination. Do not place backups inside any
   active database, document, model, cache, upload, or temporary root.
5. Keep the NAS behind its normal trusted-LAN controls. PostgreSQL must never be exposed over TCP.
   Remote/WAN access, public DNS, and external TLS termination are outside the version 1 scope.

## Clean installation

1. In Package Center, choose Manual Install and select the verified SPK.
2. Copy the complete one-time setup key displayed by the installation wizard, review the package
   identity and data-retention notice, then install.
3. Wait for Package Center to report Running. Do not attempt to initialize PostgreSQL manually.
4. Open NodeRag from the package UI and enter the copied setup key on step 1. The key expires 24
   hours after the service first starts and is deleted after setup completes; SSH is not required.
5. Create the first administrator and default silo, sign in, select/probe storage, import the
   checksum-pinned embedding model, run calibration, test Ollama if used, register sources, and
   complete setup.
6. Verify `/health`, `/ready`, one fixture of every supported format, all three search modes, the
   jobs view, and an independently verified backup before accepting the installation.

## Same-candidate reinstall

Uninstall retains data unless the destructive wizard choice is explicitly selected. A retained
reinstall must reuse the cluster, root key, database password, configuration, and documents. If it
does not, stop and preserve Package Center plus component logs; do not delete package data.

## Remote access deferred

Version 1 supports the DSM/Web Station `/noderag/` path on the trusted LAN. Do not forward router
ports or treat a public hostname, public certificate, external reverse proxy, or WAN test as a v1
installation requirement. Those controls need a separate internet-facing threat model and release
stage before they can be supported.

## Upgrade

1. Record the running version, migration head, SPK checksum, PostgreSQL major, model digest, and
   active build.
2. Create a full encrypted backup and wait for both `state=succeeded` and
   `verificationState=verified`. Preserve its passphrase separately.
3. Ensure at least one logical database size of free space for a same-major upgrade and twice that
   size for a PostgreSQL-major transition.
4. Install the newer verified SPK through Package Center. The pre-upgrade hook records state and
   stops services in dependency order.
5. The post-upgrade hook starts PostgreSQL, verifies the expected forward-only migration head,
   starts embedder/API/worker, and removes its marker only after health succeeds.
6. Verify authentication, silo grants, a known locator, vector/semantic/keyword/hybrid search, jobs,
   gateways, scheduled sources, backup destinations, vision configuration, audit history, and the
   Chat provider/storage/health screens. Test Ollama Cloud Chat generation, web search, and web
   fetch independently.
7. Retain the old package/cluster or safety backup until the acceptance period ends.

If migration, health, search, authentication, or restore verification fails, stop activation and
follow the rollback procedure in the recovery guide. Never edit a migration that has shipped.
