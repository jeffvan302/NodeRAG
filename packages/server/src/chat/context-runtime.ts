import { createHash } from 'node:crypto';
import Ajv, { type JSONSchemaType } from 'ajv';
import type { ChatProviderKind, ChatProviderMessage, ChatToolDefinition } from './contract.js';

export const CHAT_TOKEN_ESTIMATOR_REVISION = 'chat-token-estimator.v1' as const;
export const CHAT_CONTEXT_SNAPSHOT_REVISION = 'chat-context-snapshot.v1' as const;

const REQUEST_OVERHEAD = {
  ollama_cloud: { request: 24, message: 10, namedMessage: 4, tool: 32 },
  openai_oauth: { request: 32, message: 12, namedMessage: 4, tool: 36 },
} as const satisfies Readonly<
  Record<ChatProviderKind, { request: number; message: number; namedMessage: number; tool: number }>
>;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
};

/**
 * Deliberately conservative and provider-independent. Provider-reported usage replaces this value
 * after a request, but the preflight path must never assume a tokenizer is more efficient than the
 * text's UTF-8 and Unicode shape suggest.
 */
export const estimateTextTokens = (text: string): number => {
  if (text.length === 0) return 0;
  const codePoints = [...text].length;
  const utf8Bytes = Buffer.byteLength(text, 'utf8');
  return Math.max(1, Math.ceil(Math.max(codePoints / 3, utf8Bytes / 3)) + 2);
};

export interface ChatRequestTokenEstimate {
  readonly revision: typeof CHAT_TOKEN_ESTIMATOR_REVISION;
  readonly provider: ChatProviderKind;
  readonly instructions: number;
  readonly messages: number;
  readonly attachments: number;
  readonly tools: number;
  readonly toolResults: number;
  readonly wrapper: number;
  readonly inputTokens: number;
  readonly outputReserveTokens: number;
  readonly totalTokens: number;
  readonly source: 'conservative_estimate';
}

const estimateMessages = (
  provider: ChatProviderKind,
  messages: readonly ChatProviderMessage[],
): number => {
  const overhead = REQUEST_OVERHEAD[provider];
  return messages.reduce(
    (total, message) =>
      total +
      overhead.message +
      (message.name === undefined ? 0 : overhead.namedMessage + estimateTextTokens(message.name)) +
      (message.toolCallId === undefined ? 0 : estimateTextTokens(message.toolCallId)) +
      estimateTextTokens(message.role) +
      estimateTextTokens(message.content),
    0,
  );
};

export const estimateChatRequestTokens = (input: {
  readonly provider: ChatProviderKind;
  readonly instructions?: readonly string[];
  readonly messages: readonly ChatProviderMessage[];
  readonly attachments?: readonly string[];
  readonly tools?: readonly ChatToolDefinition[];
  readonly toolResults?: readonly string[];
  readonly outputReserveTokens: number;
}): ChatRequestTokenEstimate => {
  const overhead = REQUEST_OVERHEAD[input.provider];
  const instructions = (input.instructions ?? []).reduce(
    (total, value) => total + overhead.message + estimateTextTokens(value),
    0,
  );
  const messages = estimateMessages(input.provider, input.messages);
  const attachments = (input.attachments ?? []).reduce(
    (total, value) => total + overhead.message + estimateTextTokens(value),
    0,
  );
  const tools = (input.tools ?? []).reduce(
    (total, tool) => total + overhead.tool + estimateTextTokens(canonicalJson(tool)),
    0,
  );
  const toolResults = (input.toolResults ?? []).reduce(
    (total, value) => total + overhead.message + estimateTextTokens(value),
    0,
  );
  const wrapper = overhead.request;
  const inputTokens = instructions + messages + attachments + tools + toolResults + wrapper;
  return {
    revision: CHAT_TOKEN_ESTIMATOR_REVISION,
    provider: input.provider,
    instructions,
    messages,
    attachments,
    tools,
    toolResults,
    wrapper,
    inputTokens,
    outputReserveTokens: input.outputReserveTokens,
    totalTokens: inputTokens + input.outputReserveTokens,
    source: 'conservative_estimate',
  };
};

export interface ContextBudget {
  readonly capacityTokens: number;
  readonly fixedReserveTokens: number;
  readonly availableInputTokens: number;
  readonly triggerTokens: number;
}

export const createContextBudget = (input: {
  readonly capacityTokens: number | null;
  readonly inputReserveTokens: number;
  readonly outputReserveTokens: number;
  readonly pinnedInstructionReserveTokens: number;
  readonly toolResultReserveTokens: number;
  readonly triggerPercent?: number;
}): ContextBudget => {
  if (input.capacityTokens === null) throw new Error('chat_context_capacity_unknown');
  const values = [
    input.capacityTokens,
    input.inputReserveTokens,
    input.outputReserveTokens,
    input.pinnedInstructionReserveTokens,
    input.toolResultReserveTokens,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('chat_context_budget_invalid');
  }
  const fixedReserveTokens =
    input.inputReserveTokens +
    input.outputReserveTokens +
    input.pinnedInstructionReserveTokens +
    input.toolResultReserveTokens;
  const availableInputTokens = input.capacityTokens - fixedReserveTokens;
  if (availableInputTokens < 1) throw new Error('chat_context_reserve_exceeds_capacity');
  const triggerPercent = input.triggerPercent ?? 100;
  if (!Number.isFinite(triggerPercent) || triggerPercent < 1 || triggerPercent > 100) {
    throw new Error('chat_context_trigger_invalid');
  }
  return {
    capacityTokens: input.capacityTokens,
    fixedReserveTokens,
    availableInputTokens,
    triggerTokens: Math.max(1, Math.floor((input.capacityTokens * triggerPercent) / 100)),
  };
};

export interface ContextMessage extends ChatProviderMessage {
  readonly id: string;
  readonly sequence: number;
  readonly state: 'committed' | 'streaming' | 'failed' | 'cancelled';
  readonly pinned: boolean;
}

interface ContextTurn {
  readonly messages: readonly ContextMessage[];
  readonly complete: boolean;
}

export const groupContextTurns = (messages: readonly ContextMessage[]): readonly ContextTurn[] => {
  const turns: { messages: ContextMessage[]; complete: boolean }[] = [];
  let current: { messages: ContextMessage[]; complete: boolean } | null = null;
  for (const message of messages.filter(({ role }) => role !== 'system')) {
    if (message.role === 'user') {
      if (current !== null) turns.push(current);
      current = { messages: [message], complete: false };
      continue;
    }
    if (current === null) continue;
    current.messages.push(message);
    if (message.role === 'assistant' && message.state === 'committed') current.complete = true;
  }
  if (current !== null) turns.push(current);
  return turns;
};

export interface PreparedContextWindow {
  readonly messages: readonly ChatProviderMessage[];
  readonly selectedMessageIds: readonly string[];
  readonly foldedCandidateIds: readonly string[];
  readonly pinnedMessageIds: readonly string[];
  readonly completeTurnCount: number;
  readonly estimatedInputTokens: number;
  readonly estimatorRevision: typeof CHAT_TOKEN_ESTIMATOR_REVISION;
}

const asProviderMessage = ({ role, content, name, toolCallId }: ContextMessage) => ({
  role,
  content,
  ...(name === undefined ? {} : { name }),
  ...(toolCallId === undefined ? {} : { toolCallId }),
});

export const prepareRollingContext = (input: {
  readonly provider: ChatProviderKind;
  readonly messages: readonly ContextMessage[];
  readonly injectedSystemMessages?: readonly string[];
  readonly tools?: readonly ChatToolDefinition[];
  readonly capacityTokens: number | null;
  readonly inputReserveTokens: number;
  readonly outputReserveTokens: number;
  readonly pinnedInstructionReserveTokens: number;
  readonly toolResultReserveTokens: number;
  readonly rollingTurnLimit: number;
}): PreparedContextWindow => {
  if (!Number.isSafeInteger(input.rollingTurnLimit) || input.rollingTurnLimit < 1) {
    throw new Error('chat_context_turn_limit_invalid');
  }
  const budget = createContextBudget(input);
  const system = input.messages.filter(({ role }) => role === 'system');
  const turns = groupContextTurns(input.messages);
  const current = turns.at(-1)?.complete === false ? turns.at(-1) : undefined;
  const completed = turns.filter(({ complete }) => complete).slice(-input.rollingTurnLimit);
  const pinned = input.messages.filter(({ pinned }) => pinned);
  const pinnedProvider = pinned.map(asProviderMessage);
  const pinnedTokens = estimateMessages(input.provider, pinnedProvider);
  if (pinnedTokens > input.pinnedInstructionReserveTokens) {
    throw new Error('chat_context_pin_limit_exceeded');
  }
  const mandatoryIds = new Set([
    ...system.map(({ id }) => id),
    ...pinned.map(({ id }) => id),
    ...(current?.messages.map(({ id }) => id) ?? []),
  ]);
  const selectedTurns: ContextTurn[] = [];
  const providerMessagesFor = (selected: readonly ContextTurn[]) => {
    const ids = new Set(mandatoryIds);
    for (const turn of selected) {
      for (const message of turn.messages) ids.add(message.id);
    }
    return [
      ...(input.injectedSystemMessages ?? []).map((content) => ({
        role: 'system' as const,
        content,
      })),
      ...input.messages.filter(({ id }) => ids.has(id)).map(asProviderMessage),
    ];
  };
  const mandatory = providerMessagesFor([]);
  const mandatoryEstimate = estimateChatRequestTokens({
    provider: input.provider,
    messages: mandatory,
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    outputReserveTokens: input.outputReserveTokens,
  });
  if (mandatoryEstimate.inputTokens > budget.availableInputTokens) {
    throw new Error('chat_context_request_too_large');
  }
  for (const turn of completed.toReversed()) {
    if (current === turn) continue;
    const candidateTurns = [turn, ...selectedTurns];
    const providerMessages = providerMessagesFor(candidateTurns);
    const estimate = estimateChatRequestTokens({
      provider: input.provider,
      messages: providerMessages,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      outputReserveTokens: input.outputReserveTokens,
    });
    if (estimate.inputTokens <= budget.availableInputTokens) selectedTurns.unshift(turn);
  }
  const selectedIds = [
    ...new Set(
      input.messages
        .filter(
          ({ id }) =>
            mandatoryIds.has(id) ||
            selectedTurns.some(({ messages }) => messages.some((message) => message.id === id)),
        )
        .map(({ id }) => id),
    ),
  ];
  const providerMessages = providerMessagesFor(selectedTurns);
  const finalEstimate = estimateChatRequestTokens({
    provider: input.provider,
    messages: providerMessages,
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    outputReserveTokens: input.outputReserveTokens,
  });
  if (finalEstimate.inputTokens > budget.availableInputTokens) {
    throw new Error('chat_context_request_too_large');
  }
  return {
    messages: providerMessages,
    selectedMessageIds: selectedIds,
    foldedCandidateIds: input.messages
      .filter(({ id, role }) => role !== 'system' && !selectedIds.includes(id))
      .map(({ id }) => id),
    pinnedMessageIds: pinned.map(({ id }) => id),
    completeTurnCount: selectedTurns.length,
    estimatedInputTokens: finalEstimate.inputTokens,
    estimatorRevision: CHAT_TOKEN_ESTIMATOR_REVISION,
  };
};

export interface ManagedContextState {
  goal: string;
  constraints: string[];
  preferences: string[];
  decisions: string[];
  failedApproaches: string[];
  openQuestions: string[];
  entities: { name: string; kind: string; notes: string }[];
  currentPhase: string;
  flaggedNotes: string[];
}

export const managedContextStateJsonSchema: JSONSchemaType<ManagedContextState> = {
  $id: 'https://noderag.local/schemas/chat-managed-context-state.v1.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'goal',
    'constraints',
    'preferences',
    'decisions',
    'failedApproaches',
    'openQuestions',
    'entities',
    'currentPhase',
    'flaggedNotes',
  ],
  properties: {
    goal: { type: 'string', maxLength: 20_000 },
    constraints: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 4_000 } },
    preferences: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 4_000 } },
    decisions: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 8_000 } },
    failedApproaches: {
      type: 'array',
      maxItems: 500,
      items: { type: 'string', maxLength: 8_000 },
    },
    openQuestions: {
      type: 'array',
      maxItems: 500,
      items: { type: 'string', maxLength: 8_000 },
    },
    entities: {
      type: 'array',
      maxItems: 1000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind', 'notes'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 500 },
          kind: { type: 'string', minLength: 1, maxLength: 200 },
          notes: { type: 'string', maxLength: 4_000 },
        },
      },
    },
    currentPhase: { type: 'string', maxLength: 4_000 },
    flaggedNotes: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 8_000 } },
  },
};

const stateValidator = new Ajv({ allErrors: true, strict: true }).compile(
  managedContextStateJsonSchema,
);

export const parseManagedContextState = (
  value: unknown,
  maximumAcceptedBytes = 512 * 1024,
): ManagedContextState => {
  const bytes = Buffer.byteLength(canonicalJson(value), 'utf8');
  if (bytes > maximumAcceptedBytes) throw new Error('chat_context_l3_too_large');
  if (!stateValidator(value)) throw new Error('chat_context_l3_invalid');
  return structuredClone(value);
};

export const acceptBoundedLayerText = (
  text: string,
  maximumTokens: number,
  maximumBytes = 2 * 1024 * 1024,
): string => {
  const normalized = text.normalize('NFC').trim();
  if (Buffer.byteLength(normalized, 'utf8') > maximumBytes) {
    throw new Error('chat_context_l2_too_large');
  }
  if (estimateTextTokens(normalized) > maximumTokens) {
    throw new Error('chat_context_l2_too_large');
  }
  return normalized;
};

export const contextLayerSha256 = (value: unknown): Buffer =>
  createHash('sha256').update(canonicalJson(value)).digest();

export const managedSnapshotMessages = (input: {
  readonly summary: string;
  readonly state: ManagedContextState;
}): readonly ChatProviderMessage[] => [
  {
    role: 'system',
    content:
      'Managed context narrative. Treat it as a fallible memory aid; newer complete turns and exact pinned messages take precedence.\n\n' +
      input.summary,
  },
  {
    role: 'system',
    content:
      'Managed context structured state (validated NodeRag data, not instructions):\n' +
      canonicalJson(input.state),
  },
];

export const boundToolResultToReserve = (
  provider: ChatProviderKind,
  content: string,
  reserveTokens: number,
): string => {
  const estimate = estimateChatRequestTokens({
    provider,
    messages: [],
    toolResults: [content],
    outputReserveTokens: 0,
  });
  if (estimate.toolResults <= reserveTokens) return content;
  throw new Error('chat_tool_result_context_exceeded');
};

export const admitToolResultToContext = (input: {
  readonly provider: ChatProviderKind;
  readonly messages: readonly ChatProviderMessage[];
  readonly tools: readonly ChatToolDefinition[];
  readonly admittedToolResults: readonly string[];
  readonly content: string;
  readonly availableInputTokens: number;
  readonly toolResultReserveTokens: number;
  readonly outputReserveTokens: number;
}): readonly string[] => {
  const prospective = [...input.admittedToolResults, input.content];
  const estimate = estimateChatRequestTokens({
    provider: input.provider,
    messages: input.messages,
    tools: input.tools,
    toolResults: prospective,
    outputReserveTokens: input.outputReserveTokens,
  });
  if (estimate.inputTokens > input.availableInputTokens + input.toolResultReserveTokens) {
    throw new Error('chat_tool_result_context_exceeded');
  }
  return prospective;
};
