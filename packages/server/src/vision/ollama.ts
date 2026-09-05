import { z } from 'zod';
import {
  ollamaVisionJsonSchema,
  visionResponseSchema,
  VISION_PROVIDER_CONTRACT_VERSION,
  VisionProviderError,
  type ValidatedVisionResponse,
  type VisionProvider,
  type VisionProviderRequest,
} from './contract.js';

const tagsResponseSchema = z.object({
  models: z.array(
    z
      .object({
        name: z.string().min(1),
        model: z.string().min(1).optional(),
        digest: z.string().min(1).optional(),
      })
      .passthrough(),
  ),
});

const chatResponseSchema = z
  .object({
    message: z
      .object({
        role: z.string(),
        content: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export interface OllamaVisionConfig {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly model: string;
  readonly modelRevision?: string;
  readonly keepAlive?: string;
  readonly contextWindow?: number;
}

export interface OllamaModel {
  readonly name: string;
  readonly digest: string | null;
}

interface OllamaEndpoints {
  readonly chat: URL;
  readonly models: URL;
  readonly isCloud: boolean;
}

const ollamaEndpoints = (value: string): OllamaEndpoints => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('ollama-base-url-protocol');
  }
  url.search = '';
  url.hash = '';
  const pathname = url.pathname.replace(/\/+$/u, '');
  let chat: URL;
  let models: URL;
  if (pathname.endsWith('/api/chat')) {
    chat = new URL(url);
    chat.pathname = pathname;
    const apiBase = new URL(url);
    apiBase.pathname = `${pathname.slice(0, -'/chat'.length)}/`;
    models = new URL('tags', apiBase);
  } else if (pathname.endsWith('/api')) {
    const apiBase = new URL(url);
    apiBase.pathname = `${pathname}/`;
    chat = new URL('chat', apiBase);
    models = new URL('tags', apiBase);
  } else {
    const hostBase = new URL(url);
    hostBase.pathname = `${pathname}/`;
    chat = new URL('api/chat', hostBase);
    models = new URL('api/tags', hostBase);
  }
  return { chat, models, isCloud: url.hostname.toLowerCase() === 'ollama.com' };
};

const authorizationHeaders = (token: string | undefined): Readonly<Record<string, string>> =>
  token === undefined || token.length === 0 ? {} : { authorization: `Bearer ${token}` };

const providerHttpError = (status: number): VisionProviderError => {
  if (status === 404) return new VisionProviderError('vision-model-missing', 'permanent');
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new VisionProviderError('vision-provider-unavailable', 'transient');
  }
  return new VisionProviderError('vision-provider-rejected-request', 'permanent');
};

export class OllamaVisionProvider implements VisionProvider {
  readonly provider = 'ollama';
  readonly contractVersion = VISION_PROVIDER_CONTRACT_VERSION;
  readonly model: string;
  readonly modelRevision: string;
  private readonly chatUrl: URL;
  private readonly modelsUrl: URL;
  private readonly isCloud: boolean;
  private readonly token: string | undefined;
  private readonly keepAlive: string;
  private readonly contextWindow: number;
  private readonly request: typeof fetch;

  constructor(config: OllamaVisionConfig, request: typeof fetch = fetch) {
    const endpoints = ollamaEndpoints(config.baseUrl);
    this.chatUrl = endpoints.chat;
    this.modelsUrl = endpoints.models;
    this.isCloud = endpoints.isCloud;
    this.token = config.bearerToken;
    this.model = config.model;
    this.modelRevision = config.modelRevision ?? config.model;
    this.keepAlive = config.keepAlive ?? '30m';
    this.contextWindow = config.contextWindow ?? 8192;
    this.request = request;
  }

  securityWarning(): string | null {
    if (this.chatUrl.protocol !== 'http:') return null;
    const host = this.chatUrl.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
      ? null
      : 'ollama-plaintext-non-loopback';
  }

  async models(signal?: AbortSignal): Promise<readonly OllamaModel[]> {
    let response: Response;
    try {
      response = await this.request(this.modelsUrl, {
        headers: authorizationHeaders(this.token),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw new VisionProviderError('vision-provider-unreachable', 'transient', { cause: error });
    }
    if (!response.ok) throw providerHttpError(response.status);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new VisionProviderError('vision-tags-malformed', 'transient', { cause: error });
    }
    const tags = tagsResponseSchema.safeParse(parsed);
    if (!tags.success) {
      throw new VisionProviderError('vision-tags-schema-invalid', 'transient', {
        cause: tags.error,
      });
    }
    return tags.data.models.map((model) => ({
      name: model.model ?? model.name,
      digest: model.digest ?? null,
    }));
  }

  async assertModelAvailable(signal?: AbortSignal): Promise<OllamaModel> {
    const models = await this.models(signal);
    const found = models.find(
      ({ name }) => name === this.model || name.split(':', 1)[0] === this.model.split(':', 1)[0],
    );
    if (found === undefined) throw new VisionProviderError('vision-model-missing', 'permanent');
    return found;
  }

  async analyse(input: VisionProviderRequest): Promise<ValidatedVisionResponse> {
    let response: Response;
    try {
      const schemaPrompt = `${input.prompt}\n\nReturn only valid JSON matching this JSON Schema exactly:\n${JSON.stringify(input.schema)}`;
      response = await this.request(this.chatUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authorizationHeaders(this.token),
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'user',
              content: schemaPrompt,
              images: [Buffer.from(input.bytes).toString('base64')],
            },
          ],
          stream: false,
          keep_alive: this.keepAlive,
          options: { temperature: 0, num_ctx: this.contextWindow },
          ...(this.isCloud ? {} : { format: input.schema }),
        }),
        signal: input.signal,
      });
    } catch (error) {
      const code = input.signal.aborted ? 'vision-provider-timeout' : 'vision-provider-unreachable';
      throw new VisionProviderError(code, 'transient', { cause: error });
    }
    if (!response.ok) throw providerHttpError(response.status);
    let outer: unknown;
    try {
      outer = await response.json();
    } catch (error) {
      throw new VisionProviderError('vision-response-malformed', 'transient', { cause: error });
    }
    const chat = chatResponseSchema.safeParse(outer);
    if (!chat.success) {
      throw new VisionProviderError('vision-response-schema-invalid', 'transient', {
        cause: chat.error,
      });
    }
    let content: unknown;
    try {
      content = JSON.parse(chat.data.message.content);
    } catch (error) {
      throw new VisionProviderError('vision-content-malformed', 'transient', { cause: error });
    }
    const result = visionResponseSchema.safeParse(content);
    if (!result.success) {
      throw new VisionProviderError('vision-content-schema-invalid', 'transient', {
        cause: result.error,
      });
    }
    return result.data;
  }
}

export const activateOllamaVision = async (
  provider: OllamaVisionProvider,
  sample: Uint8Array,
  signal: AbortSignal,
): Promise<{ readonly model: OllamaModel; readonly sample: ValidatedVisionResponse }> => {
  const model = await provider.assertModelAvailable(signal);
  const result = await provider.analyse({
    bytes: sample,
    mediaType: 'image/png',
    sourceKind: 'document-image',
    pageNumber: null,
    imageId: 'bundled-table-activation',
    prompt:
      'This is the NodeRag activation image. Transcribe it as a Markdown table. Return only the requested JSON object.',
    schema: ollamaVisionJsonSchema,
    signal,
  });
  if (result.kind !== 'table' || !result.markdown.includes('|')) {
    throw new VisionProviderError('vision-capability-test-failed', 'permanent');
  }
  return { model, sample: result };
};
