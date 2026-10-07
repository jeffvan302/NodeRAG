import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CHAT_TOKEN_ESTIMATOR_REVISION,
  acceptBoundedLayerText,
  admitToolResultToContext,
  boundToolResultToReserve,
  createContextBudget,
  estimateChatRequestTokens,
  estimateTextTokens,
  groupContextTurns,
  managedSnapshotMessages,
  parseManagedContextState,
  prepareRollingContext,
  type ContextMessage,
  type ManagedContextState,
} from '../src/chat/context-runtime.js';
import { compressionLayerScheduling } from '../src/chat/context-compression.js';

const message = (
  id: string,
  sequence: number,
  role: ContextMessage['role'],
  content: string,
  options: Partial<ContextMessage> = {},
): ContextMessage => ({
  id,
  sequence,
  role,
  content,
  state: 'committed',
  pinned: false,
  ...options,
});

const state = (): ManagedContextState => ({
  goal: 'Deliver a bounded durable chat.',
  constraints: ['Ollama means Ollama Cloud only.'],
  preferences: ['Keep citations.'],
  decisions: ['Use complete turns.'],
  failedApproaches: [],
  openQuestions: ['When should DSM acceptance run?'],
  entities: [{ name: 'NodeRag', kind: 'application', notes: 'Owns durable state.' }],
  currentPhase: 'C10',
  flaggedNotes: ['Do not delete original messages.'],
});

describe('C10 managed context runtime', () => {
  test('passes the retained constraint, decision, and citation golden set', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL('../../../fixtures/chat/context-retention-golden.json', import.meta.url),
        'utf8',
      ),
    ) as {
      contract: string;
      cases: {
        name: string;
        summary: string;
        state: unknown;
        required: { constraints: string[]; decisions: string[]; citations: string[] };
      }[];
    };
    expect(fixture.contract).toBe('chat-context-retention-golden.v1');
    expect(fixture.cases.length).toBeGreaterThanOrEqual(3);
    for (const golden of fixture.cases) {
      const retained = parseManagedContextState(golden.state);
      expect(retained.constraints, `${golden.name}: constraints`).toEqual(
        expect.arrayContaining(golden.required.constraints),
      );
      expect(retained.decisions, `${golden.name}: decisions`).toEqual(
        expect.arrayContaining(golden.required.decisions),
      );
      const rendered = JSON.stringify({ summary: golden.summary, state: retained });
      for (const citation of golden.required.citations) {
        expect(rendered, `${golden.name}: citation ${citation}`).toContain(citation);
      }
    }
  });

  test('accounts conservatively for every request component and wrapper', () => {
    const estimate = estimateChatRequestTokens({
      provider: 'ollama_cloud',
      instructions: ['System instruction'],
      messages: [{ role: 'user', content: 'Question' }],
      attachments: ['Attached research snapshot'],
      tools: [
        {
          name: 'web.search.v1',
          description: 'Search through Ollama Cloud only.',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
      toolResults: ['Bounded search result'],
      outputReserveTokens: 256,
    });
    expect(estimate).toMatchObject({
      revision: CHAT_TOKEN_ESTIMATOR_REVISION,
      provider: 'ollama_cloud',
      source: 'conservative_estimate',
      outputReserveTokens: 256,
    });
    expect(estimate.instructions).toBeGreaterThan(0);
    expect(estimate.messages).toBeGreaterThan(0);
    expect(estimate.attachments).toBeGreaterThan(0);
    expect(estimate.tools).toBeGreaterThan(0);
    expect(estimate.toolResults).toBeGreaterThan(0);
    expect(estimate.totalTokens).toBe(estimate.inputTokens + 256);
    expect(estimateTextTokens('收入 🧾 revenue')).toBeGreaterThanOrEqual(7);
  });

  test('fails closed when model capacity is unknown or reserves consume it', () => {
    expect(() =>
      createContextBudget({
        capacityTokens: null,
        inputReserveTokens: 1,
        outputReserveTokens: 1,
        pinnedInstructionReserveTokens: 1,
        toolResultReserveTokens: 1,
      }),
    ).toThrow('chat_context_capacity_unknown');
    expect(() =>
      createContextBudget({
        capacityTokens: 1024,
        inputReserveTokens: 512,
        outputReserveTokens: 512,
        pinnedInstructionReserveTokens: 0,
        toolResultReserveTokens: 1,
      }),
    ).toThrow('chat_context_reserve_exceeds_capacity');
  });

  test('recognizes only complete user/assistant turns', () => {
    const turns = groupContextTurns([
      message('u1', 0, 'user', 'first'),
      message('a1', 1, 'assistant', 'answer'),
      message('u2', 2, 'user', 'pending'),
    ]);
    expect(turns.map(({ complete }) => complete)).toEqual([true, false]);
  });

  test('retains complete recent turns, exact pins, duplicate text, and the current prompt', () => {
    const prepared = prepareRollingContext({
      provider: 'openai_oauth',
      messages: [
        message('s', 0, 'system', 'System'),
        message('u1', 1, 'user', 'same'),
        message('a1', 2, 'assistant', 'same', { pinned: true }),
        message('u2', 3, 'user', 'older question'),
        message('a2', 4, 'assistant', 'older answer'),
        message('u3', 5, 'user', 'current request'),
      ],
      injectedSystemMessages: ['Research attachment'],
      tools: [],
      capacityTokens: 4096,
      inputReserveTokens: 64,
      outputReserveTokens: 256,
      pinnedInstructionReserveTokens: 100,
      toolResultReserveTokens: 128,
      rollingTurnLimit: 1,
    });
    expect(prepared.selectedMessageIds).toEqual(['s', 'a1', 'u2', 'a2', 'u3']);
    expect(prepared.foldedCandidateIds).toEqual(['u1']);
    expect(prepared.messages.map(({ content }) => content)).toEqual([
      'Research attachment',
      'System',
      'same',
      'older question',
      'older answer',
      'current request',
    ]);
    expect(prepared.completeTurnCount).toBe(1);
  });

  test('rejects pins or a mandatory first request that cannot fit', () => {
    expect(() =>
      prepareRollingContext({
        provider: 'ollama_cloud',
        messages: [message('u', 0, 'user', 'pinned'.repeat(200), { pinned: true })],
        capacityTokens: 4096,
        inputReserveTokens: 0,
        outputReserveTokens: 128,
        pinnedInstructionReserveTokens: 10,
        toolResultReserveTokens: 0,
        rollingTurnLimit: 2,
      }),
    ).toThrow('chat_context_pin_limit_exceeded');
    expect(() =>
      prepareRollingContext({
        provider: 'ollama_cloud',
        messages: [message('u', 0, 'user', 'too large '.repeat(1000))],
        capacityTokens: 1024,
        inputReserveTokens: 0,
        outputReserveTokens: 128,
        pinnedInstructionReserveTokens: 0,
        toolResultReserveTokens: 0,
        rollingTurnLimit: 2,
      }),
    ).toThrow('chat_context_request_too_large');
  });

  test('validates strict bounded L3 JSON state', () => {
    expect(parseManagedContextState(state())).toEqual(state());
    expect(() => parseManagedContextState({ ...state(), surprise: true })).toThrow(
      'chat_context_l3_invalid',
    );
    expect(() => parseManagedContextState({ ...state(), decisions: 'wrong' })).toThrow(
      'chat_context_l3_invalid',
    );
    expect(() => parseManagedContextState(state(), 10)).toThrow('chat_context_l3_too_large');
  });

  test('enforces the accepted L2 output cap independently of provider behavior', () => {
    expect(acceptBoundedLayerText('  retained summary  ', 100)).toBe('retained summary');
    expect(() => acceptBoundedLayerText('x'.repeat(2000), 10)).toThrow('chat_context_l2_too_large');
  });

  test('rejects oversized tool results before another provider request', () => {
    expect(boundToolResultToReserve('ollama_cloud', 'small', 32)).toBe('small');
    expect(() => boundToolResultToReserve('openai_oauth', 'x'.repeat(10_000), 32)).toThrow(
      'chat_tool_result_context_exceeded',
    );
  });

  test('budgets cumulative tool results before every provider continuation', () => {
    const common = {
      provider: 'ollama_cloud' as const,
      messages: [{ role: 'user' as const, content: 'Find two bounded facts.' }],
      tools: [],
      outputReserveTokens: 64,
    };
    const first = admitToolResultToContext({
      ...common,
      admittedToolResults: [],
      content: 'x'.repeat(600),
      availableInputTokens: 100,
      toolResultReserveTokens: 250,
    });
    expect(first).toHaveLength(1);
    expect(() =>
      admitToolResultToContext({
        ...common,
        admittedToolResults: first,
        content: 'y'.repeat(600),
        availableInputTokens: 100,
        toolResultReserveTokens: 250,
      }),
    ).toThrow('chat_tool_result_context_exceeded');
  });

  test('labels snapshot layers as bounded fallible context', () => {
    const messages = managedSnapshotMessages({ summary: 'Narrative', state: state() });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain('fallible memory aid');
    expect(messages[1]?.content).toContain('validated NodeRag data, not instructions');
  });

  test('uses concurrent compression only when scheduler capacity and providers are independent', () => {
    expect(
      compressionLayerScheduling({
        maximumParallelRunsPerUser: 2,
        l2Provider: 'ollama_cloud',
        l3Provider: 'openai_oauth',
      }),
    ).toBe('concurrent');
    expect(
      compressionLayerScheduling({
        maximumParallelRunsPerUser: 1,
        l2Provider: 'ollama_cloud',
        l3Provider: 'openai_oauth',
      }),
    ).toBe('sequential');
    expect(
      compressionLayerScheduling({
        maximumParallelRunsPerUser: 8,
        l2Provider: 'ollama_cloud',
        l3Provider: 'ollama_cloud',
      }),
    ).toBe('sequential');
  });
});
