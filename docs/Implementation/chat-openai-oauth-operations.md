# OpenAI OAuth Administration and Operations

**Stage:** C02
**Applies to:** WSL/Linux Docker testbed and Windows development host
**Chat availability:** Disabled until the later Chat milestones
**Protocol authority:** [OpenAI Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)

## What this connection is

NodeRag uses the pinned `@openai/codex@0.147.0` app-server as a supervised connection service for
one server-wide ChatGPT/OpenAI account. The administrator completes OpenAI's device-code flow; the
browser never submits an access token, refresh token, API key, session cookie, or copied Codex
credential.

The connection is for Chat response generation. It is not an internet-search connection. **Ollama
Cloud remains the only provider for NodeRag Chat internet search and web-page fetch**, including
when an OpenAI model will generate the final response.

The C02 bridge only permits these app-server methods:

- `account/read`;
- `account/login/start` with the fixed `chatgptDeviceCode` type;
- `account/login/cancel`;
- `account/logout`;
- `account/rateLimits/read`;
- paged `model/list`.

It rejects thread, turn, shell, filesystem, and arbitrary app-server methods. Consequently, C02
cannot run a model turn or invoke a built-in Codex tool. Later Chat execution is introduced through
NodeRag's own authorization and tool-policy milestones.

## Administrator sign-in procedure

1. Start NodeRag with `NODERAG_CHAT_PROVIDERS_ENABLED=true` in the Docker testbed. The flag remains
   false by default.
2. Sign in to NodeRag as a server administrator.
3. Open **Administration**, then **Chat providers**.
4. In **OpenAI OAuth**, select **Connect OpenAI account**.
5. Use **Copy code** to copy the complete one-time code.
6. Select **Open OpenAI sign-in**. NodeRag accepts only an HTTPS OpenAI or ChatGPT verification
   address returned by app-server.
7. Sign in on the OpenAI page and enter the copied code.
8. Return to NodeRag. The page polls the server while the code is pending and survives navigation
   away from and back to Administration.
9. Confirm the connected account and plan summary. The email can be unavailable if OpenAI does not
   supply it.
10. Select **Refresh models**. Choose a generation model from the live account catalog and save.
11. Select **Test account and catalog**. This refreshes the managed credential, verifies the account,
    refreshes the complete visible model catalog, and reads rate limits when OpenAI supplies them.

One pending code is reused for up to 15 minutes. An administrator can cancel it. An expired code is
cancelled at app-server and must be replaced. If another administrator owns the pending sign-in,
NodeRag will not let a different administrator cancel it.

## Shared account and capacity

The OpenAI account is server-wide in this phase. Once Chat is enabled in later milestones, every
authorized NodeRag Chat user can consume the same account's capacity. Their activity can affect the
account's rate limits, plan usage, and billing. The provider card shows this disclosure before
connection and shows current rate-limit windows when app-server returns them. Unavailable values are
shown as unavailable, never as zero.

## Credential handling and restart behavior

App-server writes its managed `auth.json` into a package-private `CODEX_HOME` at
`<data-root>/chat/openai-codex-home` unless `NODERAG_CHAT_CODEX_HOME` provides another absolute
location. NodeRag enforces a non-symbolic private directory, a regular non-symbolic credential file,
a 512 KiB maximum, JSON-object validation, and owner-only Unix permissions.

After device-code completion and every explicit account test/refresh, NodeRag reads that cache and
encrypts it with the existing NodeRag secret vault. The API never returns plaintext or ciphertext.
Before a new app-server starts, NodeRag restores the encrypted value into its private credential
file. App-server stderr is bounded and credential-shaped values, bearer values, JWTs, and API-key
patterns are redacted before diagnostics are retained.

Full encrypted recovery preserves the encrypted credential record, but recovery disables the
OpenAI provider and marks its capabilities for revalidation. Portable corpus export excludes it.
Only managed document/model folders are included as files in current recovery archives, so the
temporary plaintext `CODEX_HOME/auth.json` is not copied into a backup.

## Model catalog rules

NodeRag requests up to 100 models per page and follows at most 10 unique cursors. It rejects repeated
cursors, oversized pages, invalid records, and an empty visible catalog. Hidden models are not
stored or displayed.

For each visible model, NodeRag stores the live:

- model and display name;
- supported reasoning-effort identifiers, including safe future identifiers;
- default reasoning effort;
- input modalities, using the documented text-and-image compatibility default only when the field
  is absent;
- default-model and personality-support flags.

`model/list` does not contain capacity fields, so the same refresh also reads the connected Codex
service's raw model catalog. NodeRag stores `context_window` as the effective allocation and
`max_context_window` as the model maximum, with a checked date. A maximum-output value is stored only
when the catalog explicitly supplies one; it otherwise remains **Unknown**. Authentication success is
never reported as a capacity measurement, and NodeRag does not infer values from a model name.

When the selected model disappears, NodeRag selects the current live catalog default, or the first
visible model if no default is advertised. It retains the selected model when that model remains
available.

## Disable and disconnect behavior

Clearing **Enable OpenAI OAuth for Chat generation** disables use while retaining the encrypted
credential. **Disconnect account** requires browser confirmation, calls app-server logout, deletes
the encrypted credential and private credential file, clears the selected model, disables both
OpenAI capabilities, and requires a new device-code sign-in later.

No OpenAI control enables internet access. The later Chat internet checkbox depends on healthy
Ollama Cloud `web_search` and `web_fetch` capabilities.

## Safe diagnostics

Administration and audit records use stable categories such as:

- `openai_oauth_required`;
- `openai_login_denied`;
- `app_server_request_timeout`;
- `app_server_process_stopped`;
- `openai_protocol_invalid`;
- `openai_model_catalog_cursor_repeated`;
- `openai_model_not_available`.

The browser shows a plain-language message plus the NodeRag request ID where applicable. Logs and
audit entries do not contain device credentials, auth-cache bodies, raw provider responses, or
private model reasoning.

## Verification commands

From `F:\Dev\NodeRag`:

```powershell
node scripts/verify-chat-app-server.mjs
corepack pnpm@11.25.0 exec vitest run --project unit packages/server/test/codex-app-server.unit.test.ts packages/server/test/openai-oauth.unit.test.ts
corepack pnpm@11.25.0 --filter @noderag/ui test:e2e --grep "OpenAI device-code"
corepack pnpm@11.25.0 ci:quality
```

The same app-server smoke must run in a Linux/amd64 Node 22 container. C11 repeats it with the exact
app-server binary in the immutable Synology candidate and records real DSM execution.
