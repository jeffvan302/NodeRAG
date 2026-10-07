# Ollama connections, model capabilities, reasoning, and native tools

This guide describes Ollama's native API without assumptions about a particular application. It covers local and Cloud connections, model discovery, context limits, reasoning controls, thinking displays, and native tool calling.

## Connect to Ollama

### Local server

The default local base URL is:

```text
http://localhost:11434
```

List installed models to verify the connection:

```bash
curl http://localhost:11434/api/tags
```

The local API does not require authentication by default. Bind it only to trusted interfaces or place authentication and TLS in front of it before allowing remote access.

### Ollama Cloud

Create an Ollama API key, keep it on the server, and send it as a bearer token:

```bash
curl https://ollama.com/api/chat \
  -H "Authorization: Bearer $OLLAMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemma4:31b",
    "messages": [{"role": "user", "content": "Say hello."}],
    "stream": false
  }'
```

Use the exact model name returned by `https://ollama.com/api/tags`. Cloud API names and local CLI aliases can differ. See [Ollama Cloud](https://docs.ollama.com/cloud).

## Discover a model's capabilities and limits

### 1. List model names

```bash
curl http://localhost:11434/api/tags
```

Use the returned `models[].name` or `models[].model` value exactly, including its tag.

### 2. Inspect model metadata

```bash
curl http://localhost:11434/api/show \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3:8b"}'
```

Read these fields:

| Field                           | Meaning                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `capabilities`                  | Model features such as completion, vision, tools, or thinking.                           |
| `model_info.*.context_length`   | Advertised context length. The prefix depends on the model architecture.                 |
| `parameters`                    | Text representation of model defaults; it can include `num_ctx` and `num_predict`.       |
| `details.family` and `families` | Model-family information useful for diagnostics, not a substitute for capability fields. |

Do not hard-code an architecture prefix. Find a numeric `model_info` key that ends in `.context_length`.

### 3. Check the active context allocation

After loading the model, call:

```bash
curl http://localhost:11434/api/ps
```

The matching model's `context_length` is the active allocation. It can be lower than the advertised model limit because local defaults depend on available VRAM. Cloud models use their maximum context by default.

### 4. Build a normalized capability record

```ts
type OllamaCapabilities = {
  model: string;
  advertisedContextTokens: number | null;
  activeContextTokens: number | null;
  configuredNumCtx: number | null;
  configuredNumPredict: number | null;
  supportsTools: boolean;
  supportsThinking: boolean;
};
```

Treat missing values as unknown. A successful short prompt does not prove that the server can allocate the model's full advertised context.

## Set context and output limits

For a single chat request, send generation settings under `options`:

```json
{
  "model": "qwen3:8b",
  "messages": [{ "role": "user", "content": "Summarize the document." }],
  "stream": false,
  "options": {
    "num_ctx": 32768,
    "num_predict": 4096
  }
}
```

- `num_ctx` requests the active context allocation.
- `num_predict` limits generated tokens.
- Larger `num_ctx` values consume more memory.
- `OLLAMA_CONTEXT_LENGTH=64000 ollama serve` changes the server default.
- A Modelfile can set persistent model defaults with `PARAMETER num_ctx` and `PARAMETER num_predict`.

Verify the actual allocation with `/api/ps` after a request. See [Ollama context length](https://docs.ollama.com/context-length) and [Modelfile parameters](https://docs.ollama.com/modelfile).

## Enable native tool calling

There is no separate global switch. Native tool calling is enabled for a request by using a model that supports tools and sending function schemas in the top-level `tools` array.

Check `POST /api/show` first. Prefer a model whose `capabilities` includes `tools`, and consult its model page when the field is unavailable.

The native loop is:

1. Send messages and tool schemas to `/api/chat`.
2. Read `message.tool_calls`.
3. Validate each function name and argument object.
4. Execute only allowlisted application functions.
5. Append the assistant message containing `tool_calls`.
6. Append one `role: "tool"` message per result, with the matching `tool_name`.
7. Call `/api/chat` again until no tool calls remain.

```js
import ollama from "ollama";

const tools = [
  {
    type: "function",
    function: {
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
    },
  },
];

const messages = [
  { role: "user", content: "What is the temperature in Cape Town?" },
];

while (true) {
  const response = await ollama.chat({
    model: "qwen3:8b",
    messages,
    tools,
    think: "medium",
  });

  messages.push(response.message);
  const calls = response.message.tool_calls ?? [];
  if (calls.length === 0) {
    console.log(response.message.content);
    break;
  }

  for (const call of calls) {
    if (call.function.name !== "get_temperature") {
      throw new Error(`Tool is not allowed: ${call.function.name}`);
    }

    const args = call.function.arguments;
    const result = await getTemperature(args.city);
    messages.push({
      role: "tool",
      tool_name: call.function.name,
      content: JSON.stringify(result),
    });
  }
}
```

`getTemperature` is application code and must be implemented separately. Add timeouts, authorization, schema validation, output-size limits, and confirmation for consequential actions.

For streaming, accumulate all partial `thinking`, `content`, and `tool_calls` fields into one assistant message before appending tool results. Ollama's [tool-calling guide](https://docs.ollama.com/capabilities/tool-calling) includes single, parallel, multi-turn, and streaming patterns.

## Configure reasoning and thinking

Set the top-level `think` field on `/api/chat` or `/api/generate`. It does not belong inside `options`.

| `think` value | Behavior                                                                           |
| ------------- | ---------------------------------------------------------------------------------- |
| omitted       | Use the model/server default. Thinking is enabled by default for supported models. |
| `false`       | Disable thinking when the model supports boolean control.                          |
| `true`        | Enable thinking without selecting a named effort level.                            |
| `"low"`       | Request a shorter/lighter reasoning trace when supported.                          |
| `"medium"`    | Request balanced reasoning when supported.                                         |
| `"high"`      | Request deeper reasoning when supported.                                           |
| `"max"`       | Request the highest Ollama-defined level when the model supports it.               |

Support is model-specific:

- GPT-OSS requires `low`, `medium`, or `high`. Boolean `true`/`false` is ignored, and its thinking cannot be fully disabled.
- Other thinking models may support only boolean control.
- Some models accept named levels, including `max`.
- `/api/show` can advertise a `thinking` capability, but it does not return a universal list of supported level strings. Use the model documentation or a validated capability profile.

Reasoning effort is separate from `num_ctx`, `num_predict`, temperature, and answer length.

## Thinking bubbles

Ollama returns reasoning separately from the answer:

- `/api/chat`: `message.thinking` and `message.content`
- `/api/generate`: `thinking` and `response`

For a non-streaming chat request, read the two fields directly:

```js
const response = await ollama.chat({
  model: "qwen3:8b",
  messages: [{ role: "user", content: "Compare the two designs." }],
  think: "medium",
  stream: false,
});

console.log("Thinking:", response.message.thinking);
console.log("Answer:", response.message.content);
```

For streaming chat:

1. When the first nonempty `message.thinking` chunk arrives, create a **Thinking** bubble.
2. Append later thinking chunks to the same bubble.
3. When `message.content` begins, mark thinking complete and stream the final answer separately.
4. When `message.tool_calls` arrives, create **Using `<tool>`** bubbles with sanitized arguments.
5. Show the application result as **completed** or **failed** before continuing the model loop.

Ollama describes `thinking` as a reasoning trace. It can be useful for debugging, but it may still be partial, model-formatted, or incorrect. Treat it as observability data rather than proof that the answer is correct.

The CLI can enable thinking with `--think`, hide the trace with `--hidethinking`, and toggle it in an interactive session. Hiding a trace is a display choice and does not necessarily disable reasoning.

## Cross-provider effort names

OpenAI and Ollama share several labels, but the values are not universally equivalent. Use the selected model's capability record as the final authority.

| UI label         | OpenAI Responses API      | Ollama native API                            | Portability rule                                                      |
| ---------------- | ------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| Provider default | omit                      | omit                                         | Safest portable default.                                              |
| Off              | `none`, when supported    | `false`, when supported                      | Unavailable for GPT-OSS in Ollama and some OpenAI models.             |
| Minimal          | `minimal`, when supported | No exact universal value                     | Do not silently convert to low.                                       |
| Low              | `low`                     | `"low"` or `true` for boolean-only models    | Named level support must be verified.                                 |
| Medium           | `medium`                  | `"medium"` or `true` for boolean-only models | Named level support must be verified.                                 |
| High             | `high`                    | `"high"` or `true` for boolean-only models   | Widely supported by reasoning-capable models.                         |
| Extra high       | `xhigh`                   | No exact universal value                     | Ollama `max` can be a product-specific choice, but is not equivalent. |
| Maximum          | `max`, when supported     | `"max"`, when supported                      | For GPT-OSS on Ollama, `"high"` is the highest available level.       |

Recommended behavior for a shared UI:

1. Discover or load the selected model's supported choices.
2. Show only valid choices, plus **Provider default**.
3. Store the provider-specific wire value with the model selection.
4. Revalidate when the model or server changes.
5. If a saved value becomes invalid, fall back to provider default and surface the change.

## Troubleshooting

| Symptom                                   | Check                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| No `tool_calls`                           | Confirm the model supports tools, schemas are present, and the prompt presents a reason to call the function. |
| Tool arguments are malformed              | Validate every call; simplify descriptions and JSON schemas; try a model with stronger tool support.          |
| The model repeats the same tool call      | Append the assistant call and matching tool result, cap iterations, and make result content explicit.         |
| No `thinking` field                       | Confirm the model supports thinking and that `think` is valid for that model.                                 |
| `think: false` does not work              | GPT-OSS ignores boolean controls; use one of its named levels.                                                |
| `max` is rejected                         | The model does not support that named level; use a documented level or boolean control.                       |
| Advertised context exceeds active context | Increase the server allocation if memory permits, then verify with `/api/ps`.                                 |
| Tool loop exhausts context                | Limit iterations and result sizes, then compact between tool calls.                                           |

## References

- [Ollama chat API](https://docs.ollama.com/api/chat)
- [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling)
- [Ollama thinking](https://docs.ollama.com/capabilities/thinking)
- [Ollama model details](https://docs.ollama.com/api-reference/show-model-details)
- [Ollama list models](https://docs.ollama.com/api/tags)
- [Ollama running models](https://docs.ollama.com/api/ps)
- [Ollama context length](https://docs.ollama.com/context-length)
- [OpenAI reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
