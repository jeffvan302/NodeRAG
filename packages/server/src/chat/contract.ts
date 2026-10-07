import { z } from 'zod';

export const CHAT_PROVIDER_CONTRACT_VERSION = 'chat-provider.v1' as const;

export const chatProviderKindSchema = z.enum(['ollama_cloud', 'openai_oauth']);
export type ChatProviderKind = z.infer<typeof chatProviderKindSchema>;

export const chatReasoningEffortSchema = z.enum([
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
export type ChatReasoningEffort = z.infer<typeof chatReasoningEffortSchema>;

export const chatMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);

export const chatProviderMessageSchema = z
  .object({
    role: chatMessageRoleSchema,
    content: z.string().max(2_000_000),
    name: z.string().min(1).max(120).optional(),
    toolCallId: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ChatProviderMessage = z.infer<typeof chatProviderMessageSchema>;

export const chatToolDefinitionSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),
    description: z.string().min(1).max(2_000),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ChatToolDefinition = z.infer<typeof chatToolDefinitionSchema>;

export const chatProviderRequestDataSchema = z
  .object({
    runId: z.string().uuid(),
    conversationId: z.string().uuid(),
    model: z.string().trim().min(1).max(180),
    reasoningEffort: chatReasoningEffortSchema.default('default'),
    messages: z.array(chatProviderMessageSchema).min(1).max(4_000),
    tools: z.array(chatToolDefinitionSchema).max(64).default([]),
    maximumOutputTokens: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();
export type ChatProviderRequestData = z.infer<typeof chatProviderRequestDataSchema>;

export interface ChatToolExecutionRequest {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ChatToolExecutionResult {
  readonly content: string;
  readonly isError: boolean;
}

export interface ChatProviderRequest extends ChatProviderRequestData {
  readonly signal: AbortSignal;
  readonly executeTool?: (request: ChatToolExecutionRequest) => Promise<ChatToolExecutionResult>;
}

const eventBase = {
  sequence: z.number().int().nonnegative(),
  occurredAt: z.string().datetime({ offset: true }),
} as const;

export const chatProviderEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...eventBase,
      type: z.literal('response.started'),
      providerRequestId: z.string().min(1).max(300).optional(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('response.output_text.delta'),
      text: z.string().min(1).max(200_000),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('response.reasoning_summary.delta'),
      text: z.string().min(1).max(200_000),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('response.tool_call'),
      callId: z.string().min(1).max(200),
      name: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('response.usage'),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('response.completed'),
      finishReason: z.enum(['stop', 'length', 'tool_calls', 'cancelled']),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('response.failed'),
      code: z.string().regex(/^[a-z][a-z0-9_-]{0,119}$/u),
      retryable: z.boolean(),
    })
    .strict(),
]);
export type ChatProviderEvent = z.infer<typeof chatProviderEventSchema>;

export const chatModelProfileSchema = z
  .object({
    provider: chatProviderKindSchema,
    model: z.string().trim().min(1).max(180),
    displayName: z.string().trim().min(1).max(240),
    reasoningEfforts: z.array(chatReasoningEffortSchema).min(1),
    advertisedContextTokens: z.number().int().positive().max(10_000_000).nullable(),
    configuredContextTokens: z.number().int().positive().max(10_000_000).nullable(),
    runtimeContextTokens: z.number().int().positive().max(10_000_000).nullable(),
    maximumOutputTokens: z.number().int().positive().max(1_000_000).nullable(),
    contextProvenance: z.enum(['provider_catalog', 'provider_metadata', 'manual', 'unknown']),
    checkedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type ChatModelProfile = z.infer<typeof chatModelProfileSchema>;

export interface ChatProvider {
  readonly kind: ChatProviderKind;
  readonly contractVersion: typeof CHAT_PROVIDER_CONTRACT_VERSION;
  listModels(signal: AbortSignal): Promise<readonly ChatModelProfile[]>;
  stream(request: ChatProviderRequest): AsyncIterable<ChatProviderEvent>;
}

export class ChatProviderContractError extends Error {
  constructor(readonly code: 'invalid_event_order' | 'duplicate_tool_call' | 'missing_terminal') {
    super(code);
    this.name = 'ChatProviderContractError';
  }
}

export const assertChatProviderEventSequence = (
  input: readonly ChatProviderEvent[],
): readonly ChatProviderEvent[] => {
  const events = input.map((event) => chatProviderEventSchema.parse(event));
  if (events.length < 2 || events[0]?.type !== 'response.started') {
    throw new ChatProviderContractError('invalid_event_order');
  }
  const toolCallIds = new Set<string>();
  let terminalSeen = false;
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index || (terminalSeen && index < events.length)) {
      throw new ChatProviderContractError('invalid_event_order');
    }
    if (event.type === 'response.tool_call') {
      if (toolCallIds.has(event.callId)) throw new ChatProviderContractError('duplicate_tool_call');
      toolCallIds.add(event.callId);
    }
    if (event.type === 'response.completed' || event.type === 'response.failed') {
      if (index !== events.length - 1) throw new ChatProviderContractError('invalid_event_order');
      terminalSeen = true;
    }
  }
  if (!terminalSeen) throw new ChatProviderContractError('missing_terminal');
  return events;
};
