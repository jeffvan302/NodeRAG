import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CHAT_CORE_CONTRACT_VERSION = 'chat-core.v1' as const;

export const chatIdSchema = z.string().uuid();

export const createChatSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    provider: z.enum(['ollama_cloud', 'openai_oauth']).optional(),
    model: z.string().trim().min(1).max(180).optional(),
    reasoningEffort: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,31}$/u)
      .optional(),
    contextMode: z.enum(['rolling', 'managed']).optional(),
    researchIds: z.array(z.number().int().positive()).max(100).default([]),
    allowRag: z.boolean().default(false),
    allowInternet: z.boolean().default(false),
  })
  .strict()
  .refine((value) => (value.provider === undefined) === (value.model === undefined), {
    message: 'provider_and_model_required_together',
  });

export const updateChatSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.archived !== undefined);

export const sendChatMessageSchema = z
  .object({ content: z.string().trim().min(1).max(200_000) })
  .strict();

export const retryChatRunSchema = z.object({}).strict();

export const listChatQuerySchema = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    archived: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

export const listChatMessagesQuerySchema = z
  .object({
    before: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(60),
  })
  .strict();

export const listChatEventsQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
  })
  .strict();

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
};

export interface ChatEventHashInput {
  readonly eventId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  readonly previousSha256: string | null;
}

export const hashChatEvent = (input: ChatEventHashInput): Buffer =>
  createHash('sha256')
    .update(
      canonicalJson({
        contract: CHAT_CORE_CONTRACT_VERSION,
        eventId: input.eventId,
        conversationId: input.conversationId,
        runId: input.runId,
        sequence: input.sequence,
        type: input.type,
        payload: input.payload,
        occurredAt: input.occurredAt,
        previousSha256: input.previousSha256,
      }),
      'utf8',
    )
    .digest();

export interface ChatCursor {
  readonly updatedAt: string;
  readonly id: string;
}

export const encodeChatCursor = (cursor: ChatCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export const decodeChatCursor = (value: string | undefined): ChatCursor | null => {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    return z
      .object({ updatedAt: z.string().datetime({ offset: true }), id: z.string().uuid() })
      .strict()
      .parse(parsed);
  } catch {
    throw new Error('chat_cursor_invalid');
  }
};

export const safeChatReasoningSummary = (
  provider: 'ollama_cloud' | 'openai_oauth',
  value: string,
): string | null => {
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  // Persist only reasoning text explicitly exposed by the provider: OpenAI summaries or Ollama's
  // documented `message.thinking` trace. It is observability data, not proof of answer quality.
  return provider === 'openai_oauth' ? normalized.slice(0, 100_000) : normalized.slice(0, 100_000);
};
