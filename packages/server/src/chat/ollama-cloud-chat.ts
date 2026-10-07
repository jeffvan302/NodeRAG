import { z } from 'zod';
import {
  CHAT_PROVIDER_CONTRACT_VERSION,
  chatProviderRequestDataSchema,
  type ChatModelProfile,
  type ChatProvider,
  type ChatProviderEvent,
  type ChatProviderRequest,
} from './contract.js';
import {
  OLLAMA_CLOUD_ENDPOINTS,
  OllamaCloudError,
  type OllamaCloudClientOptions,
} from './ollama-cloud.js';

const streamedChunkSchema = z
  .object({
    model: z.string().optional(),
    message: z
      .object({
        role: z.string().optional(),
        content: z.string().default(''),
        thinking: z.string().default(''),
        tool_calls: z.array(z.unknown()).optional(),
      })
      .passthrough(),
    done: z.boolean().default(false),
    done_reason: z.string().optional(),
    prompt_eval_count: z.number().int().nonnegative().optional(),
    eval_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const ollamaToolCallSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    function: z
      .object({
        name: z.string().min(1).max(120),
        arguments: z.unknown(),
      })
      .passthrough(),
  })
  .passthrough();

const maximumLineBytes = 512 * 1024;
type StreamedChunk = z.infer<typeof streamedChunkSchema>;

const statusError = (status: number): OllamaCloudError => {
  if (status === 401 || status === 403)
    return new OllamaCloudError('ollama_cloud_credentials_rejected', false, status);
  if (status === 404) return new OllamaCloudError('ollama_cloud_model_not_found', false, status);
  if (status === 408 || status === 429)
    return new OllamaCloudError('ollama_cloud_rate_limited', true, status);
  if (status >= 500) return new OllamaCloudError('ollama_cloud_unavailable', true, status);
  return new OllamaCloudError('ollama_cloud_request_rejected', false, status);
};

const ollamaThink = (model: string, effort: string): boolean | string | undefined => {
  if (effort === 'default') return undefined;
  if (effort === 'none') return false;
  if (/(?:^|[/:_-])gpt-?oss(?:$|[/:_-])/iu.test(model)) {
    return effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined;
  }
  return effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max'
    ? effort
    : undefined;
};

export class OllamaCloudChatProvider implements ChatProvider {
  readonly kind = 'ollama_cloud' as const;
  readonly contractVersion = CHAT_PROVIDER_CONTRACT_VERSION;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maximumResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: OllamaCloudClientOptions) {
    this.#apiKey = options.apiKey.trim();
    if (this.#apiKey.length < 1 || this.#apiKey.length > 4_000) {
      throw new Error('invalid_ollama_cloud_api_key');
    }
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 8 * 1024 * 1024;
    this.#fetch = options.fetch ?? fetch;
  }

  async listModels(_signal: AbortSignal): Promise<readonly ChatModelProfile[]> {
    throw new Error('ollama_cloud_catalog_uses_administration_client');
  }

  async *stream(request: ChatProviderRequest): AsyncIterable<ChatProviderEvent> {
    const { signal, executeTool, ...data } = request;
    chatProviderRequestDataSchema.parse(data);
    if (request.tools.length > 0) {
      if (executeTool === undefined) throw new Error('chat_tool_executor_required');
      yield* this.#streamWithTools(request, executeTool);
      return;
    }
    let sequence = 0;
    const occurredAt = (): string => new Date().toISOString();
    let terminalSeen = false;
    let terminalReason: string | undefined;
    let started = false;
    const emitChunk = (chunk: StreamedChunk): ChatProviderEvent[] => {
      if ((chunk.message.tool_calls?.length ?? 0) > 0) {
        throw new OllamaCloudError('ollama_cloud_response_malformed', false);
      }
      const events: ChatProviderEvent[] = [];
      if (chunk.message.thinking.length > 0) {
        events.push({
          type: 'response.reasoning_summary.delta',
          sequence: sequence++,
          occurredAt: occurredAt(),
          text: chunk.message.thinking,
        });
      }
      if (chunk.message.content.length > 0) {
        events.push({
          type: 'response.output_text.delta',
          sequence: sequence++,
          occurredAt: occurredAt(),
          text: chunk.message.content,
        });
      }
      if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) {
        events.push({
          type: 'response.usage',
          sequence: sequence++,
          occurredAt: occurredAt(),
          inputTokens: chunk.prompt_eval_count ?? 0,
          outputTokens: chunk.eval_count ?? 0,
        });
      }
      if (chunk.done) {
        terminalSeen = true;
        terminalReason = chunk.done_reason;
      }
      return events;
    };
    for await (const streamed of this.#chatChunks(
      {
        model: request.model,
        messages: request.messages.map(({ role, content }) => ({ role, content })),
        stream: true,
        think: ollamaThink(request.model, request.reasoningEffort),
        options: {
          ...(request.maximumOutputTokens === undefined
            ? {}
            : { num_predict: request.maximumOutputTokens }),
        },
      },
      signal,
    )) {
      if (!started) {
        started = true;
        yield {
          type: 'response.started',
          sequence: sequence++,
          occurredAt: occurredAt(),
          providerRequestId: streamed.providerRequestId,
        };
      }
      for (const event of emitChunk(streamed.chunk)) yield event;
    }
    if (!started || !terminalSeen)
      throw new OllamaCloudError('ollama_cloud_response_malformed', false);
    yield {
      type: 'response.completed',
      sequence,
      occurredAt: occurredAt(),
      finishReason: terminalReason === 'length' ? 'length' : 'stop',
    };
  }

  async *#streamWithTools(
    request: ChatProviderRequest,
    executeTool: NonNullable<ChatProviderRequest['executeTool']>,
  ): AsyncIterable<ChatProviderEvent> {
    const messages: Array<Record<string, unknown>> = request.messages.map(({ role, content }) => ({
      role,
      content,
    }));
    const tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    const allowedTools = new Set(request.tools.map(({ name }) => name));
    let sequence = 0;
    let started = false;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (let round = 0; round < 100; round += 1) {
      let terminalSeen = false;
      let terminalReason: string | undefined;
      let roundContent = '';
      let roundThinking = '';
      let roundInputTokens = 0;
      let roundOutputTokens = 0;
      const rawCalls: unknown[] = [];
      for await (const streamed of this.#chatChunks(
        {
          model: request.model,
          messages,
          tools,
          stream: true,
          think: ollamaThink(request.model, request.reasoningEffort),
          options: {
            ...(request.maximumOutputTokens === undefined
              ? {}
              : { num_predict: request.maximumOutputTokens }),
          },
        },
        request.signal,
      )) {
        if (!started) {
          started = true;
          yield {
            type: 'response.started',
            sequence: sequence++,
            occurredAt: new Date().toISOString(),
            providerRequestId: streamed.providerRequestId,
          };
        }
        const chunk = streamed.chunk;
        roundThinking += chunk.message.thinking;
        roundContent += chunk.message.content;
        rawCalls.push(...(chunk.message.tool_calls ?? []));
        if (chunk.message.thinking.length > 0) {
          yield {
            type: 'response.reasoning_summary.delta',
            sequence: sequence++,
            occurredAt: new Date().toISOString(),
            text: chunk.message.thinking,
          };
        }
        if (chunk.prompt_eval_count !== undefined) roundInputTokens = chunk.prompt_eval_count;
        if (chunk.eval_count !== undefined) roundOutputTokens = chunk.eval_count;
        if (chunk.done) {
          terminalSeen = true;
          terminalReason = chunk.done_reason;
        }
      }
      if (!terminalSeen) throw new OllamaCloudError('ollama_cloud_response_malformed', false);
      totalInputTokens += roundInputTokens;
      totalOutputTokens += roundOutputTokens;
      const parsedCalls = rawCalls.map((value) => {
        const parsed = ollamaToolCallSchema.safeParse(value);
        if (!parsed.success) {
          throw new OllamaCloudError('ollama_cloud_response_malformed', false, undefined, {
            cause: parsed.error,
          });
        }
        return parsed.data;
      });
      if (parsedCalls.some((call) => !allowedTools.has(call.function.name))) {
        throw new OllamaCloudError('ollama_cloud_response_malformed', false);
      }
      if (parsedCalls.length === 0) {
        if (roundContent.length > 0) {
          yield {
            type: 'response.output_text.delta',
            sequence: sequence++,
            occurredAt: new Date().toISOString(),
            text: roundContent,
          };
        }
        yield {
          type: 'response.usage',
          sequence: sequence++,
          occurredAt: new Date().toISOString(),
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
        yield {
          type: 'response.completed',
          sequence,
          occurredAt: new Date().toISOString(),
          finishReason: terminalReason === 'length' ? 'length' : 'stop',
        };
        return;
      }
      messages.push({
        role: 'assistant',
        content: roundContent,
        ...(roundThinking.length === 0 ? {} : { thinking: roundThinking }),
        tool_calls: rawCalls,
      });
      for (const [index, call] of parsedCalls.entries()) {
        const rawArguments = call.function.arguments;
        let arguments_: unknown = rawArguments;
        if (typeof rawArguments === 'string') {
          try {
            arguments_ = JSON.parse(rawArguments) as unknown;
          } catch (error) {
            throw new OllamaCloudError('ollama_cloud_response_malformed', false, undefined, {
              cause: error,
            });
          }
        }
        if (typeof arguments_ !== 'object' || arguments_ === null || Array.isArray(arguments_)) {
          throw new OllamaCloudError('ollama_cloud_response_malformed', false);
        }
        const callId = call.id ?? `ollama-${String(round)}-${String(index)}`;
        yield {
          type: 'response.tool_call',
          sequence: sequence++,
          occurredAt: new Date().toISOString(),
          callId,
          name: call.function.name,
          arguments: arguments_ as Record<string, unknown>,
        };
        const result = await executeTool({
          callId,
          name: call.function.name,
          arguments: arguments_ as Record<string, unknown>,
        });
        messages.push({
          role: 'tool',
          tool_name: call.function.name,
          content: result.content,
        });
      }
    }
    throw new OllamaCloudError('ollama_cloud_request_rejected', false);
  }

  async *#chatChunks(
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): AsyncIterable<{ readonly chunk: StreamedChunk; readonly providerRequestId?: string }> {
    const idle = new AbortController();
    let idleExpired = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshIdleTimeout = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleExpired = true;
        idle.abort();
      }, this.#timeoutMs);
    };
    const combined = AbortSignal.any([signal, idle.signal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      refreshIdleTimeout();
      const response = await this.#fetch(OLLAMA_CLOUD_ENDPOINTS.chat, {
        method: 'POST',
        headers: {
          accept: 'application/x-ndjson, application/json',
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        redirect: 'error',
        signal: combined,
        body: JSON.stringify(body),
      });
      refreshIdleTimeout();
      if (!response.ok) throw statusError(response.status);
      if (response.body === null)
        throw new OllamaCloudError('ollama_cloud_response_malformed', false);
      const providerRequestId = response.headers.get('x-request-id') ?? undefined;
      const decoder = new TextDecoder();
      reader = response.body.getReader();
      let buffer = '';
      let totalBytes = 0;
      const parseLine = (line: string): StreamedChunk => {
        if (Buffer.byteLength(line, 'utf8') > maximumLineBytes) {
          throw new OllamaCloudError('ollama_cloud_response_too_large', false);
        }
        try {
          return streamedChunkSchema.parse(JSON.parse(line));
        } catch (error) {
          if (error instanceof OllamaCloudError) throw error;
          throw new OllamaCloudError('ollama_cloud_response_malformed', false, undefined, {
            cause: error,
          });
        }
      };
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        refreshIdleTimeout();
        totalBytes += next.value.byteLength;
        if (totalBytes > this.#maximumResponseBytes) {
          await reader.cancel();
          throw new OllamaCloudError('ollama_cloud_response_too_large', false);
        }
        buffer += decoder.decode(next.value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) {
            yield {
              chunk: parseLine(line),
              ...(providerRequestId === undefined ? {} : { providerRequestId }),
            };
          }
          newline = buffer.indexOf('\n');
        }
      }
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        yield {
          chunk: parseLine(buffer.trim()),
          ...(providerRequestId === undefined ? {} : { providerRequestId }),
        };
      }
    } catch (error) {
      if (error instanceof OllamaCloudError) throw error;
      if (signal.aborted)
        throw new OllamaCloudError('ollama_cloud_cancelled', false, undefined, { cause: error });
      if (idleExpired)
        throw new OllamaCloudError('ollama_cloud_timeout', true, undefined, { cause: error });
      throw new OllamaCloudError('ollama_cloud_unreachable', true, undefined, { cause: error });
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (reader !== undefined && (signal.aborted || idleExpired)) {
        await reader.cancel().catch(() => undefined);
      }
    }
  }
}
