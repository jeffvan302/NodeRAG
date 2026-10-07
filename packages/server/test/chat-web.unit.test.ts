import { describe, expect, it, vi } from 'vitest';
import { ChatWebError, OllamaCloudWebClient, safePublicWebUrl } from '../src/chat/web.js';
import { OLLAMA_CLOUD_ENDPOINTS } from '../src/chat/ollama-cloud.js';

const jsonResponse = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init,
  });

describe('C07 Ollama Cloud web boundary', () => {
  it('accepts only bounded public HTTP(S) URLs', () => {
    expect(safePublicWebUrl('https://example.com/a?q=1#section')).toMatchObject({
      canonicalUrl: 'https://example.com/a?q=1',
      hostname: 'example.com',
    });
    for (const unsafe of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:password@example.com/',
      'https://localhost/',
      'http://127.0.0.1/',
      'http://10.0.0.2/',
      'http://169.254.169.254/latest/meta-data',
      'http://172.20.0.1/',
      'http://192.168.1.2/',
      'https://service.internal/',
      'https://printer.local/',
      'https://[::1]/',
      'https://example.com:8443/',
    ]) {
      expect(() => safePublicWebUrl(unsafe), unsafe).toThrowError(
        expect.objectContaining({ code: 'chat_web_url_unsafe' }),
      );
    }
  });

  it('searches only the fixed Ollama Cloud endpoint and sanitizes unsafe results', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new OllamaCloudWebClient({
      apiKey: 'cloud-secret-test-key',
      fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return jsonResponse({
          results: [
            {
              title: ' Official\u0000 source ',
              url: 'https://example.com/report#summary',
              content: `Evidence\u0007 text ${'x'.repeat(9_000)}`,
            },
            {
              title: 'Duplicate',
              url: 'https://example.com/report',
              content: 'Must be removed.',
            },
            {
              title: 'Metadata service',
              url: 'http://169.254.169.254/latest/meta-data',
              content: 'Must be rejected.',
            },
          ],
        });
      }) as typeof fetch,
    });
    const result = await client.search('fixed benign query', 5, new AbortController().signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: OLLAMA_CLOUD_ENDPOINTS.webSearch });
    expect(calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer cloud-secret-test-key',
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      query: 'fixed benign query',
      max_results: 5,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      title: 'Official source',
      canonicalUrl: 'https://example.com/report',
      hostname: 'example.com',
      contentTruncated: true,
    });
    expect(result.results[0]?.content).not.toContain('\u0007');
    expect(result.results[0]?.content).toHaveLength(8_000);
  });

  it('accepts the JSON payload Ollama Cloud serves with its current text/html media type', async () => {
    const client = new OllamaCloudWebClient({
      apiKey: 'cloud-content-type-regression-key',
      fetch: vi.fn(async () =>
        jsonResponse(
          {
            results: [
              {
                title: 'Current result',
                url: 'https://example.com/current',
                content: 'Current public evidence.',
              },
            ],
          },
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
      ) as typeof fetch,
    });

    await expect(
      client.search('current information', 1, new AbortController().signal),
    ).resolves.toMatchObject({
      results: [{ title: 'Current result', content: 'Current public evidence.' }],
    });
  });

  it('fetches only through Ollama Cloud and bounds content and links', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new OllamaCloudWebClient({
      apiKey: 'cloud-fetch-key',
      fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return jsonResponse({
          title: 'Fetched evidence',
          content: `Public evidence. ${'z'.repeat(130_000)}`,
          links: [
            'https://example.com/next',
            'https://example.com/next#duplicate',
            'http://127.0.0.1/private',
          ],
        });
      }) as typeof fetch,
    });
    const source = safePublicWebUrl('https://example.com/report#ignored');
    const result = await client.fetch(source, new AbortController().signal);
    expect(calls[0]?.url).toBe(OLLAMA_CLOUD_ENDPOINTS.webFetch);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      url: 'https://example.com/report',
    });
    expect(result.content).toHaveLength(120_000);
    expect(result.contentTruncated).toBe(true);
    expect(result.links).toMatchObject([
      { canonicalUrl: 'https://example.com/next', hostname: 'example.com' },
    ]);
  });

  it('normalizes rate limits, malformed media, and oversized bodies without exposing the key', async () => {
    const rateLimited = new OllamaCloudWebClient({
      apiKey: 'do-not-expose-rate-key',
      fetch: vi.fn(async () => new Response('{}', { status: 429 })) as typeof fetch,
    });
    await expect(
      rateLimited.search('query', 1, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'chat_web_rate_limited', retryable: true });

    const malformed = new OllamaCloudWebClient({
      apiKey: 'do-not-expose-media-key',
      fetch: vi.fn(
        async () =>
          new Response('<html></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ) as typeof fetch,
    });
    await expect(malformed.search('query', 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'chat_web_response_malformed',
      retryable: false,
    });

    const oversized = new OllamaCloudWebClient({
      apiKey: 'do-not-expose-size-key',
      fetch: vi.fn(
        async () =>
          new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json', 'content-length': '5000000' },
          }),
      ) as typeof fetch,
    });
    let caught: unknown;
    try {
      await oversized.search('query', 1, new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChatWebError);
    expect(caught).toMatchObject({ code: 'chat_web_response_too_large', retryable: false });
    expect(String(caught)).not.toContain('do-not-expose');
  });

  it('normalizes rejected credentials and a bounded request timeout', async () => {
    const rejected = new OllamaCloudWebClient({
      apiKey: 'never-print-rejected-key',
      fetch: vi.fn(async () => new Response('{}', { status: 401 })) as typeof fetch,
    });
    await expect(rejected.search('query', 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'chat_web_credentials_rejected',
      retryable: false,
    });

    const timedOut = new OllamaCloudWebClient({
      apiKey: 'never-print-timeout-key',
      timeoutMs: 1_000,
      fetch: vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal === null || signal === undefined) return;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ) as typeof fetch,
    });
    await expect(timedOut.search('query', 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'chat_web_timeout',
      retryable: true,
    });
  });

  it('cancels before a queued request can execute', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new OllamaCloudWebClient({
      apiKey: 'cancel-key',
      fetch: vi.fn(async () => jsonResponse({ results: [] })) as typeof fetch,
    });
    await expect(client.search('query', 1, controller.signal)).rejects.toMatchObject({
      code: 'chat_web_cancelled',
      retryable: false,
    });
  });
});
