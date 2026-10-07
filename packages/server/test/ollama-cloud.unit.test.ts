import { describe, expect, it, vi } from 'vitest';
import {
  OLLAMA_CLOUD_ENDPOINTS,
  OllamaCloudAdminClient,
  OllamaCloudError,
} from '../src/chat/ollama-cloud.js';
import { loggerOptions } from '../src/logging.js';

const signal = (): AbortSignal => new AbortController().signal;

describe('Ollama Cloud administration client', () => {
  it('uses only fixed Cloud endpoints and applies bearer authentication', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url === OLLAMA_CLOUD_ENDPOINTS.models) {
        return Response.json({ models: [{ name: 'minimax-m3:cloud' }] });
      }
      if (url === OLLAMA_CLOUD_ENDPOINTS.runningModels) {
        return Response.json({
          models: [{ name: 'minimax-m3:cloud', context_length: 500_000 }],
        });
      }
      if (url === OLLAMA_CLOUD_ENDPOINTS.show) {
        return Response.json({
          capabilities: ['completion', 'tools', 'thinking'],
          details: { family: 'minimax-m3' },
          parameters: 'temperature 0.7\nnum_ctx 500000\nnum_predict 32768',
          model_info: {
            'general.architecture': 'minimax-m3',
            'minimax-m3.context_length': 1_000_000,
          },
        });
      }
      if (url === OLLAMA_CLOUD_ENDPOINTS.chat) {
        return Response.json({
          model: 'minimax-m3:cloud',
          message: { role: 'assistant', content: 'NodeRag connection ready.' },
          done: true,
          prompt_eval_count: 8,
          eval_count: 4,
        });
      }
      if (url === OLLAMA_CLOUD_ENDPOINTS.webSearch) {
        return Response.json({
          results: [{ title: 'Ollama', url: 'https://ollama.com/', content: 'Cloud models' }],
        });
      }
      if (url === OLLAMA_CLOUD_ENDPOINTS.webFetch) {
        return Response.json({ title: 'Ollama docs', content: 'Documentation', links: [] });
      }
      throw new Error('unexpected endpoint');
    });
    const client = new OllamaCloudAdminClient({ apiKey: 'synthetic-key', fetch: fakeFetch });

    await expect(client.listModels(signal())).resolves.toMatchObject([
      {
        provider: 'ollama_cloud',
        model: 'minimax-m3:cloud',
        reasoningEfforts: ['default', 'none', 'low', 'medium', 'high', 'max'],
        advertisedContextTokens: 1_000_000,
        configuredContextTokens: 500_000,
        runtimeContextTokens: 500_000,
        maximumOutputTokens: 32_768,
        contextProvenance: 'provider_metadata',
      },
    ]);
    await expect(client.testGeneration('minimax-m3:cloud', signal())).resolves.toMatchObject({
      capability: 'generation',
      metadata: { model: 'minimax-m3:cloud', inputTokens: 8, outputTokens: 4 },
    });
    const generationCall = calls.find(({ url }) => url === OLLAMA_CLOUD_ENDPOINTS.chat);
    expect(JSON.parse(String(generationCall?.init?.body))).toMatchObject({
      model: 'minimax-m3:cloud',
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 16 },
    });
    await expect(client.testWebSearch(signal())).resolves.toMatchObject({
      capability: 'web_search',
      metadata: { resultCount: 1 },
    });
    await expect(client.testWebFetch(signal())).resolves.toMatchObject({
      capability: 'web_fetch',
      metadata: { titlePresent: true, linkCount: 0 },
    });

    expect(calls.map(({ url }) => url)).toEqual([
      OLLAMA_CLOUD_ENDPOINTS.models,
      OLLAMA_CLOUD_ENDPOINTS.runningModels,
      OLLAMA_CLOUD_ENDPOINTS.show,
      OLLAMA_CLOUD_ENDPOINTS.chat,
      OLLAMA_CLOUD_ENDPOINTS.webSearch,
      OLLAMA_CLOUD_ENDPOINTS.webFetch,
    ]);
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get('authorization')).toBe('Bearer synthetic-key');
      expect(call.init?.redirect).toBe('error');
    }
  });

  it('maps HTTP errors to safe stable categories', async () => {
    for (const [status, code, retryable] of [
      [401, 'ollama_cloud_credentials_rejected', false],
      [403, 'ollama_cloud_credentials_rejected', false],
      [404, 'ollama_cloud_model_not_found', false],
      [429, 'ollama_cloud_rate_limited', true],
      [503, 'ollama_cloud_unavailable', true],
    ] as const) {
      const client = new OllamaCloudAdminClient({
        apiKey: 'secret-that-must-not-leak',
        fetch: vi.fn<typeof fetch>(async () => new Response('private provider detail', { status })),
      });
      try {
        await client.listModels(signal());
        throw new Error('expected provider failure');
      } catch (error) {
        expect(error).toBeInstanceOf(OllamaCloudError);
        expect(error).toMatchObject({ code, retryable, status });
        expect(String(error)).not.toContain('secret-that-must-not-leak');
        expect(String(error)).not.toContain('private provider detail');
      }
    }
  });

  it('rejects malformed and oversized responses without returning their body', async () => {
    const malformed = new OllamaCloudAdminClient({
      apiKey: 'synthetic-key',
      fetch: vi.fn<typeof fetch>(async () => Response.json({ models: [{ wrong: true }] })),
    });
    await expect(malformed.listModels(signal())).rejects.toMatchObject({
      code: 'ollama_cloud_response_malformed',
    });

    const oversized = new OllamaCloudAdminClient({
      apiKey: 'synthetic-key',
      maximumResponseBytes: 1_024,
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json({ models: [] }, { headers: { 'content-length': '4096' } }),
      ),
    });
    await expect(oversized.listModels(signal())).rejects.toMatchObject({
      code: 'ollama_cloud_response_too_large',
    });
  });

  it('does not accept an administrator-supplied service address', () => {
    expect(OLLAMA_CLOUD_ENDPOINTS).toEqual({
      chat: 'https://ollama.com/api/chat',
      models: 'https://ollama.com/api/tags',
      show: 'https://ollama.com/api/show',
      runningModels: 'https://ollama.com/api/ps',
      webSearch: 'https://ollama.com/api/web_search',
      webFetch: 'https://ollama.com/api/web_fetch',
    });
    expect(
      () =>
        new OllamaCloudAdminClient({
          apiKey: '',
        }),
    ).toThrow('invalid_ollama_cloud_api_key');
  });

  it('uses Ollama capability metadata for GPT-OSS effort levels without inventing limits', async () => {
    const client = new OllamaCloudAdminClient({
      apiKey: 'synthetic-key',
      fetch: vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url === OLLAMA_CLOUD_ENDPOINTS.models) {
          return Response.json({ models: [{ name: 'gpt-oss:120b-cloud' }] });
        }
        if (url === OLLAMA_CLOUD_ENDPOINTS.runningModels) {
          return Response.json({ models: [] });
        }
        if (url === OLLAMA_CLOUD_ENDPOINTS.show) {
          return Response.json({
            capabilities: ['completion', 'thinking'],
            details: { family: 'gptoss' },
            parameters: 'temperature 1',
            model_info: { 'gptoss.context_length': 131_072 },
          });
        }
        throw new Error('unexpected endpoint');
      }),
    });

    await expect(client.listModels(signal())).resolves.toMatchObject([
      {
        reasoningEfforts: ['default', 'low', 'medium', 'high'],
        advertisedContextTokens: 131_072,
        configuredContextTokens: null,
        runtimeContextTokens: null,
        maximumOutputTokens: null,
      },
    ]);
  });

  it('keeps model metadata when Ollama Cloud rejects its local-only running-model endpoint', async () => {
    const client = new OllamaCloudAdminClient({
      apiKey: 'synthetic-key',
      fetch: vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url === OLLAMA_CLOUD_ENDPOINTS.models) {
          return Response.json({ models: [{ name: 'cloud-model' }] });
        }
        if (url === OLLAMA_CLOUD_ENDPOINTS.runningModels) {
          return new Response(null, { status: 401 });
        }
        if (url === OLLAMA_CLOUD_ENDPOINTS.show) {
          return Response.json({
            capabilities: ['completion'],
            model_info: { 'cloud.context_length': 65_536 },
          });
        }
        throw new Error('unexpected endpoint');
      }),
    });

    await expect(client.listModels(signal())).resolves.toMatchObject([
      {
        reasoningEfforts: ['default'],
        advertisedContextTokens: 65_536,
        runtimeContextTokens: null,
        contextProvenance: 'provider_metadata',
      },
    ]);
  });

  it('times out bounded Cloud requests and keeps API keys out of structured logs', async () => {
    const client = new OllamaCloudAdminClient({
      apiKey: 'timeout-secret-that-must-not-leak',
      timeoutMs: 1_000,
      fetch: vi.fn<typeof fetch>(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ),
    });
    await expect(client.listModels(signal())).rejects.toMatchObject({
      code: 'ollama_cloud_timeout',
      retryable: true,
    });
    expect(loggerOptions).toMatchObject({
      redact: {
        paths: expect.arrayContaining(['req.body', '*.apiKey', 'req.headers.authorization']),
        censor: '[REDACTED]',
      },
    });
  });
});
