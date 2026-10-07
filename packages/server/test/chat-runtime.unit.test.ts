import { describe, expect, it } from 'vitest';
import { OllamaCloudChatProvider } from '../src/chat/ollama-cloud-chat.js';
import { OpenAiOAuthChatProvider } from '../src/chat/openai-chat-provider.js';
import type { OpenAiOAuthManager } from '../src/chat/openai-oauth.js';
import type { AppServerNotification, AppServerRequest } from '../src/chat/codex-app-server.js';
import { CHAT_RESEARCH_TOOL_DEFINITIONS } from '../src/chat/research.js';

const request = (signal = new AbortController().signal) => ({
  runId: '33333333-3333-4333-8333-333333333333',
  conversationId: '11111111-1111-4111-8111-111111111111',
  model: 'minimax-m3:cloud',
  reasoningEffort: 'default' as const,
  messages: [{ role: 'user' as const, content: 'Hello' }],
  tools: [],
  signal,
});

describe('C04/C05 production Chat provider adapters', () => {
  it('streams only from the fixed Ollama Cloud chat endpoint', async () => {
    const calls: { url: string; authorization: string | null; body: string }[] = [];
    const provider = new OllamaCloudChatProvider({
      apiKey: 'cloud-key',
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
          body: String(init?.body),
        });
        const lines = [
          JSON.stringify({
            message: { role: 'assistant', thinking: 'Checking evidence. ', content: 'Cloud ' },
            done: false,
          }),
          JSON.stringify({
            message: { role: 'assistant', content: 'answer.' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 5,
            eval_count: 2,
          }),
        ].join('\n');
        return new Response(`${lines}\n`, {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson', 'x-request-id': 'cloud-request' },
        });
      },
    });
    const events = [];
    for await (const event of provider.stream(request())) events.push(event);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://ollama.com/api/chat',
      authorization: 'Bearer cloud-key',
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({
      model: 'minimax-m3:cloud',
      stream: true,
    });
    expect(calls[0]?.body).not.toContain('cloud-key');
    expect(events.map(({ type }) => type)).toEqual([
      'response.started',
      'response.reasoning_summary.delta',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.usage',
      'response.completed',
    ]);
  });

  it('sends model-supported Ollama thinking controls for selected reasoning effort', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OllamaCloudChatProvider({
      apiKey: 'cloud-key',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          `${JSON.stringify({ message: { role: 'assistant', content: 'Done.' }, done: true })}\n`,
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        );
      },
    });
    for await (const event of provider.stream({
      ...request(),
      reasoningEffort: 'high',
    })) {
      void event;
    }
    for await (const event of provider.stream({
      ...request(),
      model: 'gpt-oss:120b-cloud',
      reasoningEffort: 'low',
    })) {
      void event;
    }
    for await (const event of provider.stream({
      ...request(),
      reasoningEffort: 'max',
    })) {
      void event;
    }

    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({ think: 'high' });
    expect(bodies[1]).toMatchObject({ think: 'low' });
    expect(bodies[2]).toMatchObject({ think: 'max' });
  });

  it('executes only declared Research tools through the fixed Ollama Cloud chat endpoint', async () => {
    const bodies: Record<string, unknown>[] = [];
    const results: string[] = [];
    const provider = new OllamaCloudChatProvider({
      apiKey: 'cloud-key',
      fetch: async (input, init) => {
        expect(String(input)).toBe('https://ollama.com/api/chat');
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify(
            bodies.length === 1
              ? {
                  message: {
                    role: 'assistant',
                    thinking: 'I need the research list.',
                    content: '',
                    tool_calls: [
                      {
                        id: 'cloud-tool-1',
                        function: { name: 'research.list_sources.v1', arguments: {} },
                      },
                    ],
                  },
                  done: true,
                  prompt_eval_count: 4,
                }
              : {
                  message: {
                    role: 'assistant',
                    thinking: 'I can now answer.',
                    content: 'Research answer [R1].',
                  },
                  done: true,
                  done_reason: 'stop',
                  prompt_eval_count: 6,
                  eval_count: 3,
                },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const events = [];
    for await (const event of provider.stream({
      ...request(),
      tools: [...CHAT_RESEARCH_TOOL_DEFINITIONS],
      executeTool: async (call) => {
        results.push(call.name);
        return { content: '{"sources":["R1"]}', isError: false };
      },
    })) {
      events.push(event);
    }
    expect(results).toEqual(['research.list_sources.v1']);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ stream: true });
    expect(JSON.stringify(bodies)).not.toContain('/api/web_search');
    expect(events.map(({ type }) => type)).toEqual([
      'response.started',
      'response.reasoning_summary.delta',
      'response.tool_call',
      'response.reasoning_summary.delta',
      'response.output_text.delta',
      'response.usage',
      'response.completed',
    ]);
  });

  it('rejects malformed Ollama Cloud tool arguments with the normalized provider error', async () => {
    const provider = new OllamaCloudChatProvider({
      apiKey: 'cloud-key',
      fetch: async () =>
        new Response(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'cloud-tool-malformed',
                  function: {
                    name: 'research.list_sources.v1',
                    arguments: '{not-json',
                  },
                },
              ],
            },
            done: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(async () => {
      for await (const event of provider.stream({
        ...request(),
        tools: [...CHAT_RESEARCH_TOOL_DEFINITIONS],
        executeTool: async () => ({ content: '{}', isError: false }),
      })) {
        // Drain the stream so malformed provider output is observed.
        void event;
      }
    }).rejects.toMatchObject({
      code: 'ollama_cloud_response_malformed',
      retryable: false,
    });
  });

  it('rejects an Ollama Cloud attempt to call an undeclared privileged tool', async () => {
    let executed = false;
    const provider = new OllamaCloudChatProvider({
      apiKey: 'cloud-key',
      fetch: async () =>
        new Response(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'cloud-tool-escalation',
                  function: { name: 'admin.read_secrets.v1', arguments: {} },
                },
              ],
            },
            done: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(async () => {
      for await (const event of provider.stream({
        ...request(),
        tools: [...CHAT_RESEARCH_TOOL_DEFINITIONS],
        executeTool: async () => {
          executed = true;
          return { content: '{"secret":"must-not-run"}', isError: false };
        },
      })) {
        void event;
      }
    }).rejects.toMatchObject({
      code: 'ollama_cloud_response_malformed',
      retryable: false,
    });
    expect(executed).toBe(false);
  });

  it('maps the pinned app-server text, safe summary, usage, and terminal notifications', async () => {
    let listener: ((notification: AppServerNotification) => void) | null = null;
    const calls: string[] = [];
    const fakeManager = {
      subscribeChatNotifications(next: (notification: AppServerNotification) => void) {
        listener = next;
        return () => {
          listener = null;
        };
      },
      async callChatRuntime(method: string) {
        calls.push(method);
        if (method === 'thread/start') return { thread: { id: 'openai-thread' } };
        if (method === 'turn/start') {
          const notify = listener as ((notification: AppServerNotification) => void) | null;
          notify?.({
            method: 'item/reasoning/summaryTextDelta',
            params: {
              threadId: 'openai-thread',
              turnId: 'openai-turn',
              delta: 'Checked evidence.',
            },
          });
          notify?.({
            method: 'item/reasoning/textDelta',
            params: {
              threadId: 'openai-thread',
              turnId: 'openai-turn',
              delta: ' Compared the strongest sources.',
            },
          });
          notify?.({
            method: 'item/agentMessage/delta',
            params: { threadId: 'openai-thread', turnId: 'openai-turn', delta: 'OAuth answer.' },
          });
          notify?.({
            method: 'thread/tokenUsage/updated',
            params: {
              threadId: 'openai-thread',
              turnId: 'openai-turn',
              tokenUsage: { last: { inputTokens: 8, outputTokens: 3, cachedInputTokens: 1 } },
            },
          });
          notify?.({
            method: 'turn/completed',
            params: {
              threadId: 'openai-thread',
              turnId: 'openai-turn',
              turn: { status: 'completed' },
            },
          });
          return { turn: { id: 'openai-turn' } };
        }
        return {};
      },
    } as unknown as OpenAiOAuthManager;
    const provider = new OpenAiOAuthChatProvider(fakeManager);
    const events = [];
    for await (const event of provider.stream({
      ...request(),
      model: 'gpt-test',
      reasoningEffort: 'low',
    })) {
      events.push(event);
    }
    expect(events.map(({ type }) => type)).toEqual([
      'response.started',
      'response.reasoning_summary.delta',
      'response.reasoning_summary.delta',
      'response.output_text.delta',
      'response.usage',
      'response.completed',
    ]);
    expect(calls).toEqual(['thread/start', 'turn/start', 'thread/delete']);
  });

  it('binds only declared Research dynamic tools in the pinned OpenAI app-server', async () => {
    let notificationListener: ((notification: AppServerNotification) => void) | null = null;
    let requestListener: ((request: AppServerRequest) => Promise<unknown | null>) | null = null;
    let threadStart: Record<string, unknown> | null = null;
    let executed = '';
    const fakeManager = {
      subscribeChatNotifications(next: (notification: AppServerNotification) => void) {
        notificationListener = next;
        return () => {
          notificationListener = null;
        };
      },
      subscribeChatRequests(next: (request: AppServerRequest) => Promise<unknown | null>) {
        requestListener = next;
        return () => {
          requestListener = null;
        };
      },
      async callChatRuntime(method: string, params: Record<string, unknown>) {
        if (method === 'thread/start') {
          threadStart = params;
          return { thread: { id: 'research-thread' } };
        }
        if (method === 'turn/start') {
          setImmediate(() => {
            void (async () => {
              const handle = requestListener;
              await (handle as ((request: AppServerRequest) => Promise<unknown | null>) | null)?.({
                id: 7,
                method: 'item/tool/call',
                params: {
                  threadId: 'research-thread',
                  turnId: 'research-turn',
                  callId: 'openai-tool-1',
                  tool: 'research.list_sources.v1',
                  arguments: {},
                },
              });
              const notify = notificationListener;
              (notify as ((notification: AppServerNotification) => void) | null)?.({
                method: 'item/agentMessage/delta',
                params: {
                  threadId: 'research-thread',
                  turnId: 'research-turn',
                  delta: 'OpenAI Research answer [R1].',
                },
              });
              (notify as ((notification: AppServerNotification) => void) | null)?.({
                method: 'turn/completed',
                params: {
                  threadId: 'research-thread',
                  turnId: 'research-turn',
                  turn: { status: 'completed' },
                },
              });
            })();
          });
          return { turn: { id: 'research-turn' } };
        }
        return {};
      },
    } as unknown as OpenAiOAuthManager;
    const provider = new OpenAiOAuthChatProvider(fakeManager);
    const events = [];
    for await (const event of provider.stream({
      ...request(),
      model: 'gpt-test',
      tools: [...CHAT_RESEARCH_TOOL_DEFINITIONS],
      executeTool: async ({ name }) => {
        executed = name;
        return { content: '{"sources":["R1"]}', isError: false };
      },
    })) {
      events.push(event);
    }
    expect(executed).toBe('research.list_sources.v1');
    expect(threadStart?.['dynamicTools']).toMatchObject([
      { type: 'function', name: 'research.list_sources.v1' },
      { type: 'function', name: 'research.read_page.v1' },
      { type: 'function', name: 'research.read_document.v1' },
    ]);
    expect(JSON.stringify(threadStart)).not.toContain('web.search');
    expect(events.map(({ type }) => type)).toEqual([
      'response.started',
      'response.tool_call',
      'response.output_text.delta',
      'response.completed',
    ]);
  });
});
