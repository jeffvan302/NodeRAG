import { describe, expect, it } from 'vitest';
import {
  ChatProviderContractError,
  assertChatProviderEventSequence,
  chatProviderRequestDataSchema,
  type ChatProviderEvent,
} from '../src/chat/contract.js';
import { createFakeOllamaCloudProvider, createFakeOpenAiOauthProvider } from '../src/chat/fake.js';
import { CHAT_FEATURE_KEYS, loadChatFeatureFlags } from '../src/chat/features.js';

const request = () => ({
  runId: '11111111-1111-4111-8111-111111111111',
  conversationId: '22222222-2222-4222-8222-222222222222',
  model: 'cloud-model',
  reasoningEffort: 'medium' as const,
  messages: [{ role: 'user' as const, content: 'Hello' }],
  tools: [],
  signal: new AbortController().signal,
});

const collect = async (provider: ReturnType<typeof createFakeOllamaCloudProvider>) => {
  const events: ChatProviderEvent[] = [];
  for await (const event of provider.stream(request())) events.push(event);
  return events;
};

describe('chat provider foundation', () => {
  it('normalizes deterministic Ollama Cloud and OpenAI OAuth event streams', async () => {
    const ollama = createFakeOllamaCloudProvider({ reasoningSummary: 'Checked the request.' });
    const openai = createFakeOpenAiOauthProvider();
    const ollamaEvents = await collect(ollama);
    const openAiEvents: ChatProviderEvent[] = [];
    for await (const event of openai.stream(request())) openAiEvents.push(event);

    expect(assertChatProviderEventSequence(ollamaEvents).map(({ type }) => type)).toEqual([
      'response.started',
      'response.reasoning_summary.delta',
      'response.output_text.delta',
      'response.usage',
      'response.completed',
    ]);
    expect(assertChatProviderEventSequence(openAiEvents).at(-1)?.type).toBe('response.completed');
    await expect(ollama.listModels(new AbortController().signal)).resolves.toMatchObject([
      { provider: 'ollama_cloud', model: 'fake-cloud-model' },
    ]);
  });

  it('represents provider failure as a safe terminal event', async () => {
    const events = await collect(
      createFakeOllamaCloudProvider({
        failWith: { code: 'provider_unavailable', retryable: true },
      }),
    );
    expect(assertChatProviderEventSequence(events).at(-1)).toMatchObject({
      type: 'response.failed',
      code: 'provider_unavailable',
      retryable: true,
    });
  });

  it('rejects missing terminals, duplicate tool calls, and malformed requests', () => {
    const base = {
      occurredAt: '2026-01-01T00:00:00.000Z',
    } as const;
    expect(() =>
      assertChatProviderEventSequence([{ ...base, sequence: 0, type: 'response.started' }]),
    ).toThrowError(ChatProviderContractError);
    expect(() =>
      assertChatProviderEventSequence([
        { ...base, sequence: 0, type: 'response.started' },
        {
          ...base,
          sequence: 1,
          type: 'response.tool_call',
          callId: 'duplicate',
          name: 'rag.search.v1',
          arguments: {},
        },
        {
          ...base,
          sequence: 2,
          type: 'response.tool_call',
          callId: 'duplicate',
          name: 'rag.search.v1',
          arguments: {},
        },
        { ...base, sequence: 3, type: 'response.completed', finishReason: 'stop' },
      ]),
    ).toThrowError('duplicate_tool_call');
    expect(chatProviderRequestDataSchema.safeParse({ model: '' }).success).toBe(false);
  });
});

describe('chat rollout feature flags', () => {
  it('keeps every Chat feature disabled by default', () => {
    const flags = loadChatFeatureFlags({});
    expect(CHAT_FEATURE_KEYS.every((key) => flags[key] === false)).toBe(true);
  });

  it('accepts an explicitly ordered dependency set', () => {
    const flags = loadChatFeatureFlags({
      NODERAG_CHAT_PROVIDERS_ENABLED: 'true',
      NODERAG_CHAT_CONTEXT_ENABLED: 'true',
      NODERAG_CHAT_UI_ENABLED: '1',
      NODERAG_CHAT_WEB_TOOLS_ENABLED: 'true',
    });
    expect(flags['chat.tools.web.enabled']).toBe(true);
  });

  it('rejects invalid values and unsafe partial activation', () => {
    expect(() => loadChatFeatureFlags({ NODERAG_CHAT_UI_ENABLED: 'perhaps' })).toThrow(
      'NODERAG_CHAT_UI_ENABLED must be true, false, 1, or 0.',
    );
    expect(() => loadChatFeatureFlags({ NODERAG_CHAT_WEB_TOOLS_ENABLED: 'true' })).toThrow(
      'chat.tools.web.enabled requires chat.ui.enabled.',
    );
  });
});
