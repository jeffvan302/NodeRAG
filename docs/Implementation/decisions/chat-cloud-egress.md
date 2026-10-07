# C00 Decision — Chat Ownership, Cloud Egress, and Capability Boundaries

**Status:** Accepted for implementation in the WSL/Linux Docker testbed
**Recorded:** 2026-09-15
**Applies to:** NodeRag Chat delivery stream C00–C11

## Decision

NodeRag will add Chat as a durable, user-owned workspace. Provider configuration is administered
server-wide, but ordinary users can access only their own conversations, messages, runs, and Chat
files. A separate Chat entitlement controls whether a non-administrator can see or use Chat and does
not grant access to any knowledge base.

All Ollama use in Chat means **direct Ollama Cloud access**. Chat must not accept a local,
self-hosted, forwarded, or administrator-selected Ollama URL. The fixed service root is
`https://ollama.com`; model generation uses `/api/chat`, internet search uses `/api/web_search`, and
result retrieval uses `/api/web_fetch`. One encrypted Ollama Cloud API key may authorize all three,
but their health, enablement, scheduling, and failure states remain independent.

Ollama Cloud is the only internet-search provider in this delivery stream. This remains true when
OpenAI OAuth generates the assistant answer: the selected generation model receives NodeRag's
bounded Ollama Cloud search/fetch tools. Models never receive an unrestricted network client.

OpenAI OAuth is delegated to the pinned `@openai/codex` app-server. NodeRag will not implement its
own OAuth client secret, token exchange, or browser-token paste flow.

## Data-egress amendment

The existing statement that only vision images leave the NAS is no longer true when an administrator
enables Chat. The Administration and new-chat screens must disclose the following before Chat is
made user-visible:

| Action                         | External recipient              | Data that may leave NodeRag                                                                                                             |
| ------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Ollama Cloud answer generation | Ollama Cloud                    | System instructions, chat messages, selected Research/RAG excerpts, bounded tool results, and artifact excerpts required by the request |
| OpenAI OAuth answer generation | OpenAI through Codex app-server | The same generation context, subject to the chat's enabled tools and attachments                                                        |
| Internet search                | Ollama Cloud                    | Search query and bounded search options                                                                                                 |
| Internet result retrieval      | Ollama Cloud                    | Selected public URL and bounded fetch options                                                                                           |
| Provider setup tests           | Selected provider               | Synthetic text, fixed benign query, and fixed public test URL only                                                                      |

Provider credentials, encrypted secret material, filesystem paths, database connection details,
session cookies, CSRF tokens, setup tokens, and unrelated document content never belong in provider
requests. Setup tests must never sample a private document.

## Ownership and current-access rules

1. Provider credentials and default settings are system-wide and server-admin only.
2. Each conversation has exactly one owning principal. Ordinary users cannot enumerate another
   principal's Chat identifiers, metadata, messages, files, or run status.
3. A Research attachment stores citation/reference snapshots, but every document read rechecks the
   owner's current knowledge-space grant. A revoked grant takes effect at the next read/tool call.
4. Broad RAG search resolves a fresh `SiloScope` for every call. It never reuses the scope recorded
   when the conversation was created.
5. Search-only API keys cannot use Chat, provider configuration, Research attachments, Chat files,
   or Chat runs.
6. Server administrators may inspect operational metadata and redacted logs. Reading another user's
   content requires a future, separately authorized support/audit design and is not part of this
   implementation.

## Retention, archive, purge, backup, and restore

- **Active:** database history and checksummed filesystem segments remain available to the owner.
- **Archived:** hidden from the default list but retained; archive is reversible and does not release
  storage by itself.
- **Purge:** an explicit owner operation with confirmation. It enters a durable `purging` state,
  denies new runs, deletes Chat files through a contained job, then deletes database content. Failed
  purges remain visible and retryable. Automatic purge is disabled initially.
- **Provider disconnect:** stops new provider work without deleting conversations or artifacts.
- **Knowledge-space revocation:** hides or denies affected source material without deleting the
  user's original Chat messages.
- **Backup:** full backups include database Chat records, encrypted provider credential records, and
  checksummed Chat storage. Portable exports exclude provider secrets and authentication caches.
- **Restore:** restores database and files as one declared restore set, verifies hashes, reconciles
  missing segments explicitly, and leaves providers disabled until credentials are successfully
  revalidated.

## Model and tool boundary

Models receive only versioned NodeRag tools with validated arguments and bounded results. They do not
receive a shell, SQL connection, arbitrary path, raw storage root, unrestricted HTTP client, or a
way to change feature flags. Tool outputs and internet content are untrusted data: they cannot add
tools, change authorization, reveal secrets, or override system policy.

Provider-returned displayable reasoning summaries may be shown separately from the answer. NodeRag
must not request, store, reconstruct, or display private hidden chain-of-thought.

## Threats and mandatory controls

| Threat                                  | Required control before enabling the affected feature                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Shared provider-account misuse          | Chat entitlement, server-admin configuration, per-principal/run quotas, audit metadata, and immediate provider disable           |
| Credential theft or logging             | Existing encrypted-secret vault, masked replacement flow, fingerprints only, structured redaction, and secret-scanning tests     |
| Prompt injection in documents/web pages | Treat tool results as untrusted, preserve provenance, cap recursive calls, and prevent tool/policy mutation                      |
| Cross-owner or cross-silo reads         | Owner predicates, current `SiloScope`, database constraints/RLS, non-enumerating 404/empty behavior, and adversarial tests       |
| SSRF or unrestricted downloads          | Fixed Ollama Cloud endpoints; web fetch only through the hosted tool with URL, redirect, MIME, size, and repetition limits       |
| Context/output exhaustion               | Model profiles with honest unknowns, pre-request and tool-boundary budget checks, bounded tool results, and durable cancellation |
| Path traversal, links, or device files  | Chat-relative normalized paths, canonical containment, link/reparse denial, optimistic hashes, file count/byte limits            |
| Malicious Markdown or generated files   | Existing sanitizer, sandboxed rendering, deterministic server-side export, no macro/external relationships                       |
| Browser/API/worker interruption         | Durable queued runs, leases, idempotency, persisted normalized events, resumable history, and bounded retry policy               |
| Corrupt or divergent filesystem log     | Append-only checksummed segments, explicit reconciliation, quarantine, and database authority                                    |

## Dependency and platform decision

- Pin `@openai/codex` exactly at `0.147.0` (Apache-2.0) for the app-server integration.
- Use Node's built-in bounded `fetch` implementation for Ollama Cloud rather than adding a second
  general-purpose provider client.
- Keep the provider contract independent from either transport and verify it with deterministic
  fakes.
- Package the `@openai/codex` Linux x64 optional runtime in the eventual Synology x86_64 artifact.
  WSL/Linux proves binary startup and protocol compatibility; C11 remains responsible for real DSM
  execution and resource acceptance.

## Rollout consequence

All nine Chat flags default to disabled. Migrations may land before behavior, but no provider screen,
Chat navigation, tool, artifact, export, or import capability becomes visible until its own flag and
dependencies are explicitly enabled. Rollback disables new work; it does not reverse an applied
migration or delete Chat history.
