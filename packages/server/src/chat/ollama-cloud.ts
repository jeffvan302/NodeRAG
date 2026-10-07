import { z } from 'zod';
import type { ChatModelProfile, ChatReasoningEffort } from './contract.js';

export const OLLAMA_CLOUD_SERVICE_ROOT = 'https://ollama.com' as const;
export const OLLAMA_CLOUD_ENDPOINTS = {
  chat: `${OLLAMA_CLOUD_SERVICE_ROOT}/api/chat`,
  models: `${OLLAMA_CLOUD_SERVICE_ROOT}/api/tags`,
  show: `${OLLAMA_CLOUD_SERVICE_ROOT}/api/show`,
  runningModels: `${OLLAMA_CLOUD_SERVICE_ROOT}/api/ps`,
  webSearch: `${OLLAMA_CLOUD_SERVICE_ROOT}/api/web_search`,
  webFetch: `${OLLAMA_CLOUD_SERVICE_ROOT}/api/web_fetch`,
} as const;

const modelSchema = z
  .object({
    name: z.string().trim().min(1).max(180).optional(),
    model: z.string().trim().min(1).max(180).optional(),
    modified_at: z.string().optional(),
    size: z.number().nonnegative().optional(),
    digest: z.string().max(300).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .refine(({ name, model }) => name !== undefined || model !== undefined);

const modelsResponseSchema = z.object({ models: z.array(modelSchema).max(10_000) }).passthrough();

const showResponseSchema = z
  .object({
    parameters: z.string().max(1_000_000).optional(),
    capabilities: z.array(z.string().trim().min(1).max(80)).max(64).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    model_info: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const runningModelsResponseSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(180).optional(),
            model: z.string().trim().min(1).max(180).optional(),
            context_length: z.number().int().positive().max(10_000_000).optional(),
          })
          .passthrough()
          .refine(({ name, model }) => name !== undefined || model !== undefined),
      )
      .max(10_000),
  })
  .passthrough();

const generationResponseSchema = z
  .object({
    model: z.string().optional(),
    message: z.object({ content: z.string(), thinking: z.string().optional() }).passthrough(),
    done: z.boolean().optional(),
    prompt_eval_count: z.number().int().nonnegative().optional(),
    eval_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const webSearchResponseSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            title: z.string(),
            url: z.string().url(),
            content: z.string(),
          })
          .passthrough(),
      )
      .max(10),
  })
  .passthrough();

const webFetchResponseSchema = z
  .object({
    title: z.string(),
    content: z.string(),
    links: z.array(z.string()).max(20_000),
  })
  .passthrough();

const positiveInteger = (value: unknown, maximum: number): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : null;

const serializedParameters = (value: string | undefined): ReadonlyMap<string, string> => {
  const result = new Map<string, string>();
  for (const line of value?.split(/\r?\n/u) ?? []) {
    const match = /^\s*([a-z][a-z0-9_]*)\s+(.+?)\s*$/iu.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      result.set(match[1].toLowerCase(), match[2]);
    }
  }
  return result;
};

const parameterInteger = (
  parameters: ReadonlyMap<string, string>,
  name: string,
  maximum: number,
): number | null => {
  const raw = parameters.get(name);
  if (raw === undefined || !/^\d+$/u.test(raw)) return null;
  return positiveInteger(Number(raw), maximum);
};

const metadataInteger = (
  metadata: Readonly<Record<string, unknown>> | undefined,
  suffixes: readonly string[],
  maximum: number,
): number | null => {
  const candidates = Object.entries(metadata ?? {})
    .filter(([key]) => suffixes.some((suffix) => key.toLowerCase().endsWith(suffix)))
    .map(([, value]) => positiveInteger(value, maximum))
    .filter((value): value is number => value !== null);
  return candidates.length === 0 ? null : Math.max(...candidates);
};

const detailStrings = (details: Readonly<Record<string, unknown>> | undefined): readonly string[] =>
  Object.values(details ?? {}).flatMap((value) =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [],
  );

const isGptOssModel = (
  model: string,
  details: Readonly<Record<string, unknown>> | undefined,
): boolean =>
  [model, ...detailStrings(details)].some((value) =>
    /(?:^|[/:_-])gpt-?oss(?:$|[/:_-])/iu.test(value),
  );

export const ollamaReasoningEfforts = (
  model: string,
  capabilities: readonly string[],
  details?: Readonly<Record<string, unknown>>,
): ChatReasoningEffort[] => {
  if (!capabilities.some((capability) => capability.toLowerCase() === 'thinking')) {
    return ['default'];
  }
  return isGptOssModel(model, details)
    ? ['default', 'low', 'medium', 'high']
    : ['default', 'none', 'low', 'medium', 'high', 'max'];
};

interface OllamaModelMetadata {
  readonly capabilities: readonly string[];
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly advertisedContextTokens: number | null;
  readonly configuredContextTokens: number | null;
  readonly maximumOutputTokens: number | null;
}

const modelMetadata = (value: z.infer<typeof showResponseSchema>): OllamaModelMetadata => {
  const parameters = serializedParameters(value.parameters);
  return {
    capabilities: value.capabilities ?? [],
    details: value.details,
    advertisedContextTokens: metadataInteger(value.model_info, ['.context_length'], 10_000_000),
    configuredContextTokens: parameterInteger(parameters, 'num_ctx', 10_000_000),
    maximumOutputTokens:
      parameterInteger(parameters, 'num_predict', 1_000_000) ??
      metadataInteger(
        value.model_info,
        ['.max_output_tokens', '.max_output_length', '.output_token_limit'],
        1_000_000,
      ),
  };
};

export type OllamaCloudCapability = 'generation' | 'model_catalog' | 'web_search' | 'web_fetch';

export class OllamaCloudError extends Error {
  constructor(
    readonly code:
      | 'ollama_cloud_cancelled'
      | 'ollama_cloud_timeout'
      | 'ollama_cloud_unreachable'
      | 'ollama_cloud_credentials_rejected'
      | 'ollama_cloud_rate_limited'
      | 'ollama_cloud_model_not_found'
      | 'ollama_cloud_request_rejected'
      | 'ollama_cloud_unavailable'
      | 'ollama_cloud_response_too_large'
      | 'ollama_cloud_response_malformed',
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'OllamaCloudError';
  }
}

export interface OllamaCloudClientOptions {
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly fetch?: typeof fetch;
}

export interface OllamaCloudTestResult {
  readonly capability: OllamaCloudCapability;
  readonly latencyMs: number;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

const errorForStatus = (status: number): OllamaCloudError => {
  if (status === 401 || status === 403)
    return new OllamaCloudError('ollama_cloud_credentials_rejected', false, status);
  if (status === 404) return new OllamaCloudError('ollama_cloud_model_not_found', false, status);
  if (status === 408 || status === 429)
    return new OllamaCloudError('ollama_cloud_rate_limited', true, status);
  if (status >= 500) return new OllamaCloudError('ollama_cloud_unavailable', true, status);
  return new OllamaCloudError('ollama_cloud_request_rejected', false, status);
};

export const readBoundedOllamaCloudJson = async (
  response: Response,
  maximumBytes: number,
): Promise<unknown> => {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new OllamaCloudError('ollama_cloud_response_too_large', false);
  }
  if (response.body === null) throw new OllamaCloudError('ollama_cloud_response_malformed', false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new OllamaCloudError('ollama_cloud_response_too_large', false);
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } catch (error) {
    throw new OllamaCloudError('ollama_cloud_response_malformed', false, undefined, {
      cause: error,
    });
  }
};

export class OllamaCloudAdminClient {
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maximumResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: OllamaCloudClientOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length < 1 || apiKey.length > 4_000) throw new Error('invalid_ollama_cloud_api_key');
    this.#apiKey = apiKey;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 2 * 1024 * 1024;
    this.#fetch = options.fetch ?? fetch;
    if (
      !Number.isInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1_000 ||
      this.#timeoutMs > 600_000
    ) {
      throw new Error('invalid_ollama_cloud_timeout');
    }
    if (
      !Number.isInteger(this.#maximumResponseBytes) ||
      this.#maximumResponseBytes < 1_024 ||
      this.#maximumResponseBytes > 16 * 1024 * 1024
    ) {
      throw new Error('invalid_ollama_cloud_response_limit');
    }
  }

  async #request(
    url: (typeof OLLAMA_CLOUD_ENDPOINTS)[keyof typeof OLLAMA_CLOUD_ENDPOINTS],
    method: 'GET' | 'POST',
    body: Readonly<Record<string, unknown>> | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        redirect: 'error',
        signal: combined,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal.aborted) {
        throw new OllamaCloudError('ollama_cloud_cancelled', false, undefined, { cause: error });
      }
      if (timeout.aborted) {
        throw new OllamaCloudError('ollama_cloud_timeout', true, undefined, { cause: error });
      }
      throw new OllamaCloudError('ollama_cloud_unreachable', true, undefined, { cause: error });
    }
    if (!response.ok) throw errorForStatus(response.status);
    return readBoundedOllamaCloudJson(response, this.#maximumResponseBytes);
  }

  async listModels(signal: AbortSignal): Promise<readonly ChatModelProfile[]> {
    const raw = await this.#request(OLLAMA_CLOUD_ENDPOINTS.models, 'GET', undefined, signal);
    const parsed = modelsResponseSchema.safeParse(raw);
    if (!parsed.success) throw new OllamaCloudError('ollama_cloud_response_malformed', false);
    let running: z.infer<typeof runningModelsResponseSchema> = { models: [] };
    try {
      const runningRaw = await this.#request(
        OLLAMA_CLOUD_ENDPOINTS.runningModels,
        'GET',
        undefined,
        signal,
      );
      const parsedRunning = runningModelsResponseSchema.safeParse(runningRaw);
      if (!parsedRunning.success) {
        throw new OllamaCloudError('ollama_cloud_response_malformed', false);
      }
      running = parsedRunning.data;
    } catch (error) {
      if (!(
        error instanceof OllamaCloudError &&
        (error.code === 'ollama_cloud_model_not_found' ||
          error.code === 'ollama_cloud_credentials_rejected' ||
          error.code === 'ollama_cloud_request_rejected')
      )) {
        throw error;
      }
    }
    const runtimeContexts = new Map<string, number>();
    for (const item of running.models) {
      if (item.context_length !== undefined) {
        if (item.name !== undefined) runtimeContexts.set(item.name, item.context_length);
        if (item.model !== undefined) runtimeContexts.set(item.model, item.context_length);
      }
    }
    const discovered: Array<{
      readonly item: z.infer<typeof modelSchema>;
      readonly metadata: OllamaModelMetadata;
    }> = [];
    for (let offset = 0; offset < parsed.data.models.length; offset += 4) {
      const batch = parsed.data.models.slice(offset, offset + 4);
      discovered.push(
        ...(await Promise.all(
          batch.map(async (item) => {
            const name = item.name ?? item.model;
            if (name === undefined) {
              throw new OllamaCloudError('ollama_cloud_response_malformed', false);
            }
            const detailRaw = await this.#request(
              OLLAMA_CLOUD_ENDPOINTS.show,
              'POST',
              { model: name, verbose: false },
              signal,
            );
            const detail = showResponseSchema.safeParse(detailRaw);
            if (!detail.success) {
              throw new OllamaCloudError('ollama_cloud_response_malformed', false);
            }
            return { item, metadata: modelMetadata(detail.data) };
          }),
        )),
      );
    }
    const checkedAt = new Date().toISOString();
    return discovered.map(({ item, metadata }) => {
      const name = item.name ?? item.model;
      if (name === undefined) throw new OllamaCloudError('ollama_cloud_response_malformed', false);
      const runtimeContextTokens = runtimeContexts.get(name) ?? null;
      const contextKnown =
        runtimeContextTokens !== null ||
        metadata.configuredContextTokens !== null ||
        metadata.advertisedContextTokens !== null;
      return {
        provider: 'ollama_cloud',
        model: name,
        displayName: name,
        reasoningEfforts: ollamaReasoningEfforts(name, metadata.capabilities, metadata.details),
        advertisedContextTokens: metadata.advertisedContextTokens,
        configuredContextTokens: metadata.configuredContextTokens,
        runtimeContextTokens,
        maximumOutputTokens: metadata.maximumOutputTokens,
        contextProvenance: contextKnown ? 'provider_metadata' : 'unknown',
        checkedAt,
      };
    });
  }

  async testGeneration(model: string, signal: AbortSignal): Promise<OllamaCloudTestResult> {
    const normalizedModel = model.trim();
    if (normalizedModel.length < 1 || normalizedModel.length > 180) {
      throw new Error('invalid_ollama_cloud_model');
    }
    const started = performance.now();
    const raw = await this.#request(
      OLLAMA_CLOUD_ENDPOINTS.chat,
      'POST',
      {
        model: normalizedModel,
        messages: [{ role: 'user', content: 'Reply with exactly: NodeRag connection ready.' }],
        stream: false,
        // A connection test verifies answer generation, not hidden reasoning. Thinking-capable
        // Cloud models can otherwise consume this deliberately small allowance entirely in
        // `message.thinking` and leave `message.content` empty even though the model is healthy.
        think: false,
        options: { temperature: 0, num_predict: 16 },
      },
      signal,
    );
    const parsed = generationResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.message.content.trim().length === 0) {
      throw new OllamaCloudError('ollama_cloud_response_malformed', false);
    }
    return {
      capability: 'generation',
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      metadata: {
        model: parsed.data.model ?? normalizedModel,
        inputTokens: parsed.data.prompt_eval_count ?? null,
        outputTokens: parsed.data.eval_count ?? null,
      },
    };
  }

  async testWebSearch(signal: AbortSignal): Promise<OllamaCloudTestResult> {
    const started = performance.now();
    const raw = await this.#request(
      OLLAMA_CLOUD_ENDPOINTS.webSearch,
      'POST',
      { query: 'Ollama official documentation', max_results: 1 },
      signal,
    );
    const parsed = webSearchResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.results.length < 1) {
      throw new OllamaCloudError('ollama_cloud_response_malformed', false);
    }
    return {
      capability: 'web_search',
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      metadata: { resultCount: parsed.data.results.length },
    };
  }

  async testWebFetch(signal: AbortSignal): Promise<OllamaCloudTestResult> {
    const started = performance.now();
    const raw = await this.#request(
      OLLAMA_CLOUD_ENDPOINTS.webFetch,
      'POST',
      { url: 'https://docs.ollama.com/' },
      signal,
    );
    const parsed = webFetchResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.content.trim().length === 0) {
      throw new OllamaCloudError('ollama_cloud_response_malformed', false);
    }
    return {
      capability: 'web_fetch',
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      metadata: {
        titlePresent: parsed.data.title.trim().length > 0,
        linkCount: parsed.data.links.length,
      },
    };
  }
}
