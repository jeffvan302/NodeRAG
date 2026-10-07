import {
  CHAT_PROVIDER_CONTRACT_VERSION,
  chatProviderRequestDataSchema,
  type ChatModelProfile,
  type ChatProvider,
  type ChatProviderEvent,
  type ChatProviderKind,
  type ChatProviderRequest,
} from './contract.js';

const FIXED_TIME = '2026-01-01T00:00:00.000Z';

export interface DeterministicFakeChatProviderOptions {
  readonly kind: ChatProviderKind;
  readonly model: string;
  readonly output?: string;
  readonly reasoningSummary?: string;
  readonly failWith?: { readonly code: string; readonly retryable: boolean };
}

export class DeterministicFakeChatProvider implements ChatProvider {
  readonly contractVersion = CHAT_PROVIDER_CONTRACT_VERSION;
  readonly kind: ChatProviderKind;
  readonly #model: string;
  readonly #output: string;
  readonly #reasoningSummary: string | undefined;
  readonly #failure: DeterministicFakeChatProviderOptions['failWith'];

  constructor(options: DeterministicFakeChatProviderOptions) {
    this.kind = options.kind;
    this.#model = options.model;
    this.#output = options.output ?? 'Deterministic chat response.';
    this.#reasoningSummary = options.reasoningSummary;
    this.#failure = options.failWith;
  }

  async listModels(signal: AbortSignal): Promise<readonly ChatModelProfile[]> {
    if (signal.aborted) throw signal.reason;
    return [
      {
        provider: this.kind,
        model: this.#model,
        displayName: this.#model,
        reasoningEfforts: ['default', 'low', 'medium', 'high'],
        advertisedContextTokens: 32_768,
        configuredContextTokens: null,
        runtimeContextTokens: null,
        maximumOutputTokens: 4_096,
        contextProvenance: 'provider_catalog',
        checkedAt: FIXED_TIME,
      },
    ];
  }

  async *stream(request: ChatProviderRequest): AsyncIterable<ChatProviderEvent> {
    const { signal, executeTool: _executeTool, ...data } = request;
    void _executeTool;
    chatProviderRequestDataSchema.parse(data);
    if (signal.aborted) throw signal.reason;
    let sequence = 0;
    yield {
      type: 'response.started',
      sequence: sequence++,
      occurredAt: FIXED_TIME,
      providerRequestId: `fake-${request.runId}`,
    };
    if (this.#failure !== undefined) {
      yield {
        type: 'response.failed',
        sequence,
        occurredAt: FIXED_TIME,
        code: this.#failure.code,
        retryable: this.#failure.retryable,
      };
      return;
    }
    if (this.#reasoningSummary !== undefined) {
      yield {
        type: 'response.reasoning_summary.delta',
        sequence: sequence++,
        occurredAt: FIXED_TIME,
        text: this.#reasoningSummary,
      };
    }
    yield {
      type: 'response.output_text.delta',
      sequence: sequence++,
      occurredAt: FIXED_TIME,
      text: this.#output,
    };
    yield {
      type: 'response.usage',
      sequence: sequence++,
      occurredAt: FIXED_TIME,
      inputTokens: request.messages.reduce((total, message) => total + message.content.length, 0),
      outputTokens: this.#output.length,
    };
    yield {
      type: 'response.completed',
      sequence,
      occurredAt: FIXED_TIME,
      finishReason: 'stop',
    };
  }
}

export const createFakeOllamaCloudProvider = (
  overrides: Omit<DeterministicFakeChatProviderOptions, 'kind' | 'model'> & {
    readonly model?: string;
  } = {},
): DeterministicFakeChatProvider =>
  new DeterministicFakeChatProvider({
    kind: 'ollama_cloud',
    model: overrides.model ?? 'fake-cloud-model',
    ...overrides,
  });

export const createFakeOpenAiOauthProvider = (
  overrides: Omit<DeterministicFakeChatProviderOptions, 'kind' | 'model'> & {
    readonly model?: string;
  } = {},
): DeterministicFakeChatProvider =>
  new DeterministicFakeChatProvider({
    kind: 'openai_oauth',
    model: overrides.model ?? 'fake-oauth-model',
    ...overrides,
  });
