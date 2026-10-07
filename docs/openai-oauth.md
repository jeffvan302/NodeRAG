# OpenAI authentication, reasoning, and native tools

This guide is implementation-neutral. It covers the two supported OpenAI connection patterns, capability discovery, reasoning controls, reasoning-summary displays, and native function calling.

## Choose the authentication surface

OpenAI API authentication and ChatGPT OAuth serve different products. Do not treat their credentials as interchangeable.

| Use case                                        | Supported authentication                                                                              | Primary interface         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------- |
| A server or application calling the OpenAI API  | OpenAI API key, service-account key, or an approved workload-identity configuration                   | Responses API             |
| A Codex client using a user's ChatGPT allowance | ChatGPT browser or device-code login managed by Codex app-server                                      | Codex app-server JSON-RPC |
| A host that already owns ChatGPT tokens         | Experimental app-server `chatgptAuthTokens`; the host must refresh tokens when app-server requests it | Codex app-server JSON-RPC |

A ChatGPT OAuth token is not a general replacement for `OPENAI_API_KEY` on `api.openai.com`. For ordinary application integrations, use the Responses API with a supported API credential. Use ChatGPT OAuth only through the documented Codex client surface.

## Connect through Codex app-server OAuth

Launch `codex app-server`, initialize the JSON-RPC connection, and let app-server own credential storage and refresh. The client should not scrape browser cookies or implement an undocumented token exchange.

### Browser flow

Start the managed browser flow:

```json
{
  "method": "account/login/start",
  "id": 1,
  "params": {
    "type": "chatgpt",
    "useHostedLoginSuccessPage": true,
    "appBrand": "chatgpt"
  }
}
```

Open the returned `authUrl`, then wait for `account/login/completed` and `account/updated` notifications.

### Device-code flow

Use device code when a local callback is unavailable or the client owns the sign-in UI:

```json
{
  "method": "account/login/start",
  "id": 2,
  "params": { "type": "chatgptDeviceCode" }
}
```

Display the returned `verificationUrl` and `userCode`, then wait for the same completion notifications. Use `account/read` to inspect the active account and `account/logout` to disconnect.

The complete flow is documented in [Codex app-server authentication](https://learn.chatgpt.com/docs/app-server#auth-endpoints).

## Discover models and capabilities

### Codex app-server

After OAuth login, call `model/list` and paginate with `nextCursor`:

```json
{
  "method": "model/list",
  "id": 3,
  "params": { "limit": 100, "includeHidden": false }
}
```

Each model can report:

- `model` and `displayName`
- `supportedReasoningEfforts`
- `defaultReasoningEffort`
- `inputModalities`
- `isDefault`
- visibility and upgrade metadata

Use this response to populate model and reasoning selectors for the connected account. Do not invent effort choices that the selected model did not advertise.

`model/list` does not provide context-window or maximum-output fields. Obtain those limits from the official [OpenAI model catalog](https://developers.openai.com/api/docs/models) and keep a versioned model-metadata table. Treat an unknown model's limits as unknown.

### Standard OpenAI API

`GET /v1/models` lists models available to the API credential, but each model record contains basic identity and ownership metadata rather than a complete capability profile. Combine that list with the model catalog or a maintained capability registry.

A portable capability record can use this shape:

```ts
type ModelCapabilities = {
  model: string;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  supportsFunctionTools: boolean;
  inputModalities: string[];
  source: "live-catalog" | "official-docs" | "operator";
};
```

## Reasoning effort

In the Responses API, send reasoning controls under `reasoning`. In Chat Completions, the corresponding field is `reasoning_effort`; prefer Responses for new tool-using applications.

```ts
const response = await client.responses.create({
  model: "gpt-5.6",
  input: "Compare two migration plans.",
  reasoning: {
    effort: "medium",
    summary: "auto",
  },
});
```

Supported values and defaults are model-specific. Current models may expose some or all of:

| OpenAI value | Intended use                                                                 |
| ------------ | ---------------------------------------------------------------------------- |
| omitted      | Use the selected model's default.                                            |
| `none`       | Lowest latency when the model supports a no-reasoning mode.                  |
| `minimal`    | Very light reasoning; supported by only some model generations.              |
| `low`        | Faster, more context-efficient reasoning.                                    |
| `medium`     | Balanced quality, latency, and cost.                                         |
| `high`       | More reasoning for difficult multi-step work.                                |
| `xhigh`      | Extended reasoning for especially difficult work, when supported.            |
| `max`        | Highest provider-defined effort, available only on models that advertise it. |

Examples of why capability discovery matters:

- GPT-6 Astra advertises `low`, `medium`, `high`, `xhigh`, and `max`; it rejects `none`.
- GPT-5.6 family models advertise `none`, `low`, `medium`, `high`, `xhigh`, and `max`.
- Earlier reasoning models can expose smaller sets such as `low`, `medium`, and `high`.

Do not silently translate `max` to `xhigh`, or `none` to `minimal`. If the saved value is unsupported, choose the model's advertised default and tell the user that the selection changed.

Higher effort usually increases reasoning tokens, latency, and cost. It does not control answer length; use `max_output_tokens` and, where supported, text verbosity for that.

## Reasoning-summary bubbles

Through the standard Responses API, OpenAI does not expose raw reasoning tokens. To show a thinking-style UI, request a reasoning summary:

```json
{
  "reasoning": {
    "effort": "medium",
    "summary": "auto"
  }
}
```

For a streamed Responses request, use these events:

| Event                                    | Suggested UI behavior                                      |
| ---------------------------------------- | ---------------------------------------------------------- |
| `response.reasoning_summary_text.delta`  | Append `delta` to the current **Thinking** bubble.         |
| `response.reasoning_summary_text.done`   | Mark the bubble complete.                                  |
| `response.function_call_arguments.delta` | Optionally show that a tool request is being assembled.    |
| Completed `function_call` output item    | Show **Using `<tool>`** with reviewed/sanitized arguments. |
| Submitted `function_call_output`         | Show **`<tool>` completed** or **failed**.                 |
| `response.output_text.delta`             | Append to the visible answer.                              |

The Thinking bubble is a provider-generated summary. Label it **Reasoning summary** when that distinction matters. Do not describe it as complete chain-of-thought.

Keep the UI event log separate from model context. Preserve the reasoning item when the Responses API requires it for a later stateless turn, but do not append the displayed summary a second time as a user or assistant message.

### Get reasoning through the ChatGPT OAuth connection

When the connection uses ChatGPT OAuth through Codex app-server, reasoning arrives as app-server JSON-RPC notifications rather than Responses API events.

First, choose an effort advertised by `model/list`, then pass it to `turn/start`. The optional `summary` setting controls the requested summary style separately from effort:

```json
{
  "method": "turn/start",
  "id": 4,
  "params": {
    "threadId": "thr_123",
    "input": [{ "type": "text", "text": "Compare the two designs." }],
    "model": "gpt-5.6-terra",
    "effort": "medium",
    "summary": "concise"
  }
}
```

Listen continuously for these notifications:

| App-server notification                     | Meaning and UI behavior                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `item/started` with a reasoning item        | Create or reset the Thinking/Reasoning bubble for that `item.id`.                                                   |
| `item/reasoning/summaryTextDelta`           | Append `params.delta` to a readable reasoning-summary bubble. Use `summaryIndex` to separate summary sections.      |
| `item/reasoning/summaryPartAdded`           | Start a new summary section when the interface displays sections separately.                                        |
| `item/reasoning/textDelta`                  | Append `params.delta` to a reasoning-text bubble when the selected model supports this event.                       |
| `item/completed` with the same reasoning ID | Reconcile the bubble with the final item and mark it complete. The completed item is the authoritative final state. |

Minimal notification handling:

```ts
function onAppServerNotification(message: {
  method: string;
  params?: Record<string, unknown>;
}) {
  if (
    message.method === "item/reasoning/summaryTextDelta" ||
    message.method === "item/reasoning/textDelta"
  ) {
    const delta = String(message.params?.delta ?? "");
    appendToThinkingBubble(delta);
  }

  if (message.method === "item/completed") {
    reconcileCompletedItem(message.params);
  }
}
```

The OAuth login only establishes access. Visible reasoning still depends on the selected model, its supported effort values, the requested summary setting, and which reasoning events app-server emits. Prefer readable `summaryTextDelta` for a general user interface. Treat `textDelta` as optional diagnostic output, and do not promise that either event is a complete record of the model's internal processing.

See [Codex app-server turns and item deltas](https://learn.chatgpt.com/docs/app-server#item-deltas).

## Native function calling with the Responses API

Native tool calling means the model returns structured `function_call` items. The application executes the functions; the model does not run application code by itself.

The loop is:

1. Send function schemas in `tools`.
2. Receive one or more `function_call` output items.
3. Validate the name and JSON arguments against an allowlist and schema.
4. Execute the function in the application.
5. Send a `function_call_output` with the matching `call_id`.
6. Continue until the model returns no more function calls.

```ts
import OpenAI from "openai";

const client = new OpenAI();
const model = "gpt-5.6";

const tools = [
  {
    type: "function" as const,
    name: "get_temperature",
    description: "Get the current temperature for a city.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City and country" },
      },
      required: ["city"],
      additionalProperties: false,
    },
    strict: true,
  },
];

let response = await client.responses.create({
  model,
  input: "What is the temperature in Cape Town?",
  tools,
  tool_choice: "auto",
  reasoning: { effort: "medium", summary: "auto" },
});

while (true) {
  const calls = response.output.filter((item) => item.type === "function_call");
  if (calls.length === 0) break;

  const outputs = [];
  for (const call of calls) {
    if (call.name !== "get_temperature") {
      throw new Error(`Tool is not allowed: ${call.name}`);
    }

    const args = JSON.parse(call.arguments) as { city: string };
    const result = await getTemperature(args.city);
    outputs.push({
      type: "function_call_output" as const,
      call_id: call.call_id,
      output: JSON.stringify(result),
    });
  }

  response = await client.responses.create({
    model,
    previous_response_id: response.id,
    input: outputs,
    tools,
    reasoning: { effort: "medium", summary: "auto" },
  });
}

console.log(response.output_text);
```

`getTemperature` is application code and must be implemented separately. Apply timeouts, authorization, argument validation, result-size limits, and confirmation for consequential actions.

Use `strict: true` for function schemas. Strict mode requires every property to be listed in `required` and every object schema to set `additionalProperties: false`; represent optional values with a nullable type. See [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling).

### Tool selection

- `tool_choice: "auto"`: the model may call zero or more tools.
- `tool_choice: "required"`: the model must call at least one tool.
- A forced function choice: require one named function.
- `allowed_tools`: expose a stable tool list while restricting the callable subset.
- `parallel_tool_calls: false`: allow at most one function call in the turn.

## Native tools through Codex app-server OAuth

For a Codex client authenticated with ChatGPT, define `dynamicTools` when starting a thread. This app-server feature is experimental and requires `capabilities.experimentalApi = true` during initialization.

The call lifecycle is:

1. `item/started` reports a `dynamicToolCall` with the tool name and arguments.
2. App-server sends an `item/tool/call` request to the client.
3. The client validates and executes the allowed tool, then returns content items.
4. `item/completed` reports the final status and result.

Render those events with the same **Using**, **completed**, and **failed** bubbles as Responses API function calls. Keep app-server approval requests distinct from ordinary tool status so users can make an informed decision before a consequential action.

See [Codex app-server dynamic tools](https://learn.chatgpt.com/docs/app-server#dynamic-tool-calls-experimental).

## Cross-provider effort normalization

If one UI supports OpenAI and Ollama, keep a canonical label and a provider-specific wire value. An unavailable mapping should remain unavailable instead of being silently downgraded.

| Canonical label  | OpenAI wire value         | Ollama wire value                             | Notes                                                                 |
| ---------------- | ------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Provider default | omit                      | omit                                          | Let the selected model/server choose.                                 |
| Off              | `none`, when supported    | `false`, when supported                       | GPT-OSS through Ollama cannot disable thinking.                       |
| Minimal          | `minimal`, when supported | No exact universal value                      | Offer only with a documented provider mapping.                        |
| Low              | `low`                     | `"low"`, or `true` for boolean-only models    | Verify model support.                                                 |
| Medium           | `medium`                  | `"medium"`, or `true` for boolean-only models | Verify model support.                                                 |
| High             | `high`                    | `"high"`, or `true` for boolean-only models   | Verify model support.                                                 |
| Extra high       | `xhigh`                   | No exact universal value                      | Ollama `max` is a possible model-specific mapping, not an equivalent. |
| Maximum          | `max`, when supported     | `"max"`, when supported                       | GPT-OSS uses `"high"` as its highest supported level.                 |

Store both the canonical choice and resolved provider value for diagnostics. Re-resolve whenever the model changes.

## References

- [OpenAI API function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI reasoning models and summaries](https://developers.openai.com/api/docs/guides/reasoning)
- [OpenAI model catalog](https://developers.openai.com/api/docs/models)
- [OpenAI Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Ollama thinking](https://docs.ollama.com/capabilities/thinking)
