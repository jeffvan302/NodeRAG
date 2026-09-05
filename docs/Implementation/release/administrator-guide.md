# Administrator Guide — 1.0.0-rc.1

## Daily operating model

NodeRag is one private appliance. The package supervisor starts its private PostgreSQL, local
embedder, API/UI, and durable worker. Administrators should operate it through the UI or documented
API, not by editing the database, package files, PID files, secrets, or generated Markdown.

## First configuration

1. Complete the setup flow and store the first administrator credential in the approved password
   manager.
2. Probe every selected storage path. Treat a filesystem, free-space, encryption, ACL, sync-root,
   or indexing-root warning as an operator decision—not an automatic approval.
3. Import only a model matching the frozen manifest SHA-256 and source revision.
4. Run embedding calibration before large ingest. Keep the measured thread count and busy-host
   throttling unless repeat evidence supports a change.
5. Activate Ollama only after the model list and bundled table sample pass. Prefer loopback or TLS;
   a non-loopback plaintext endpoint produces a security warning.
6. Register watched sources below explicit allowlisted roots. Start schedules disabled, perform one
   manual crawl, review results, then enable them.

## Identity and silos

- A silo is the authorization and retrieval boundary. Create grants independently; read does not
  imply upload or delete.
- API keys may be search-only, CIDR-limited, rate-limited, expiring, and narrower than the owner.
- A gateway can only narrow the authenticated principal to configured silos. It never widens a
  grant. Keep gateway ports in 5300–5319 and place external TLS at the approved DSM proxy boundary.
- Review audit entries for sign-in, identity, grant, search, source, delete, build, backup, restore,
  and settings changes. Raw queries and secrets must not appear.

## Content lifecycle

Uploads and source crawls return before durable work finishes. Use the jobs view to observe queued,
leased, retrying, paused, failed, or completed state. A watched file that disappears becomes
`source_missing`; its index is retained until an administrator reviews it. Reindex is safe and
idempotent. Delete/purge is explicit and removes uniquely reachable original, Markdown, chunks,
images, caches, and rows.

## Rebuilds

1. Create a proposal and review source size, expected chunks, estimated time, temporary bytes, and
   free-space fit.
2. Confirm only while the proposal is current. The active build continues serving search.
3. Monitor per-silo checkpoint progress. Pause/resume/cancel rather than manipulating jobs.
4. Verify staged counts, locators, vector dimensions, non-finite values, indexes, source snapshot,
   and ANN recall.
5. Activate verified silos atomically. Keep rollback tables until the acceptance window ends.
6. Authorize and run cleanup separately after rollback is no longer required.

## Health and capacity

Investigate any open integrity finding, terminal job failure, repeated retry, failed backup,
gateway bind error, model mismatch, unavailable readiness state, or growth beyond planned corpus
and rebuild headroom. Component logs rotate at 5 MiB with five retained generations by default.
Collect logs and bounded API diagnostics before restarting; do not expose raw paths or secrets in a
support bundle.
