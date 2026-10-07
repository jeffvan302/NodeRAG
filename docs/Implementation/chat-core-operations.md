# C04 Durable Chat Core — Operations Guide

**Applies to:** NodeRag Chat migration `000022_chat_core`
**Environment:** WSL/Linux Docker testbed; DSM packaging remains deferred to C11

## What C04 delivers

C04 enables durable, owner-scoped text conversations for entitled browser users. A conversation can
use a healthy Ollama Cloud generation model or the configured OpenAI OAuth connection. It has no
Research, RAG, internet, file, export, or ingest tools yet. Those capabilities remain behind later
milestone flags.

For Chat, “Ollama” always means Ollama Cloud at the fixed `https://ollama.com` service root. Local,
self-hosted, forwarded, and administrator-supplied Ollama addresses are not accepted. Internet access
is off in C04. When introduced in C07, internet search and fetch will be performed only by Ollama
Cloud, even when OpenAI generates the final response.

## Readiness requirements

Chat appears below Research only when all of the following are true:

1. provider, context, and Chat UI rollout flags are enabled in dependency order;
2. the signed-in principal has an enabled Chat entitlement;
3. Chat storage has a valid contained `.noderag-chat` manifest;
4. at least one enabled generation connection has a healthy, current model profile;
5. the request is made through a browser session, not a search-only API key.

The C04 context snapshot is always `rolling`. A managed-context selection is rejected until C10
implements and verifies the managed runtime.

## Normal user workflow

1. Sign in and select **Chat** below **Research**.
2. Select **New chat**.
3. Enter a name, provider/model, and available reasoning effort.
4. Review the Cloud-only and tool-free disclosure, then create the chat.
5. Enter a message. **Enter** sends; **Shift+Enter** inserts a line break.
6. Watch the response stream. A completed assistant message is labelled **Final answer**.
7. Use **Stop** to cancel a queued or running response, and **Retry last response** after a failed or
   cancelled run.
8. Use **View older logs** to load earlier messages without replacing newer history.
9. Rename or archive the selected conversation. Purge is a confirmed API operation and permanently
   removes the conversation's database history.

## Durability model

- PostgreSQL is the authoritative store for conversations, immutable configuration snapshots,
  messages, runs, normalized events, and usage.
- Each conversation permits exactly one queued/running/cancelling run.
- Workers claim runs with renewable leases. An expired lease is reclaimed, the abandoned partial
  assistant message is cleared, and a `run.recovered` event is recorded before retry.
- Every committed event receives an increasing database ID and a per-conversation SHA-256 chain.
- After the database transaction commits, the worker appends the same events to
  `.noderag-chat/conversations/<conversation-uuid>/events.ndjson` with mode `0600` under a private
  `0700` directory.
- A trailing partial line from an interrupted append is removed and rebuilt from PostgreSQL. A hash,
  chain, checkpoint, containment, symlink, or size mismatch fails closed as `chat_log_corrupt`.
- The browser reconnects through Server-Sent Events using event IDs. Database replay resumes after
  `Last-Event-ID`; an expired replay window returns `chat_event_replay_expired`.

## Stop, retry, and restart behavior

Queued Stop requests are cancelled transactionally. Running Stop requests enter `cancelling`; the
worker observes the request at its next lease heartbeat, aborts the provider, records a cancelled
terminal event, and releases the lease. Retry creates a new assistant message and run linked to the
failed/cancelled run; it never overwrites the prior terminal record.

An API restart is safe because the browser can reload messages and events from PostgreSQL. A worker
restart is safe because its lease expires and a replacement worker reclaims the run. Providers that
time out, omit a terminal event, repeat an event sequence, or attempt a tool call fail with a bounded
safe code; raw provider responses and credentials are never returned to the browser.

## Administrator checks

When Chat is unavailable, check in this order:

1. confirm the user entitlement;
2. confirm Providers shows a healthy generation capability and a current model;
3. confirm Chat Settings has a valid default model and writable Chat storage;
4. confirm the provider, context, and UI rollout flags are enabled;
5. inspect the safe run error code and the 24-hour Administration log without copying secrets;
6. verify the worker is running and renewing leases;
7. verify the `.noderag-chat` root remains inside the configured storage path and is not a symlink.

Do not edit NDJSON logs, database run state, or immutable configuration revisions manually. Correct
the provider/storage condition and use Retry, or allow an expired lease to be reclaimed.

## C04 verification command groups

The release evidence requires the deterministic C04 integration suite in Linux/amd64 Docker, the
provider/configuration/recovery integration suites, the complete browser suite, the complete unit
suite, and the workspace quality gate. Live account calls are optional additional evidence and must
not be required for a deterministic build.

## Deferred behavior

- C05: attached Research snapshots and citations.
- C06: permission-scoped RAG tools.
- C07: bounded Ollama Cloud-only internet search/fetch.
- C08–C10: Chat files, exports, ingest, managed context, and archive/reconciliation.
- C11: Docker release gate, DSM integration, upgrade test, and immutable SPK.
