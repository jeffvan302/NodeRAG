import { describe, expect, it } from 'vitest';
import {
  createChatSchema,
  decodeChatCursor,
  encodeChatCursor,
  hashChatEvent,
  sendChatMessageSchema,
} from '../src/chat/core.js';

describe('durable Chat core contract', () => {
  it('validates bounded chat creation and complete provider/model overrides', () => {
    expect(createChatSchema.parse({ name: 'Legal notes' })).toEqual({
      name: 'Legal notes',
      researchIds: [],
      allowRag: false,
      allowInternet: false,
    });
    expect(
      createChatSchema.parse({
        name: 'Cloud answer',
        provider: 'ollama_cloud',
        model: 'minimax-m3:cloud',
      }),
    ).toMatchObject({ provider: 'ollama_cloud', model: 'minimax-m3:cloud' });
    expect(() =>
      createChatSchema.parse({ name: 'Missing model', provider: 'ollama_cloud' }),
    ).toThrow();
    expect(() =>
      createChatSchema.parse({ name: 'Local', provider: 'ollama_local', model: 'x' }),
    ).toThrow();
    expect(() => sendChatMessageSchema.parse({ content: '   ' })).toThrow();
  });

  it('round-trips opaque cursor data and fails closed on malformed cursors', () => {
    const value = {
      updatedAt: '2026-09-15T10:00:00.000Z',
      id: '11111111-1111-4111-8111-111111111111',
    };
    expect(decodeChatCursor(encodeChatCursor(value))).toEqual(value);
    expect(() => decodeChatCursor('not-a-cursor')).toThrow('chat_cursor_invalid');
  });

  it('hashes canonical event content and its previous chain link', () => {
    const common = {
      eventId: '22222222-2222-4222-8222-222222222222',
      conversationId: '11111111-1111-4111-8111-111111111111',
      runId: '33333333-3333-4333-8333-333333333333',
      sequence: 2,
      type: 'response.usage',
      occurredAt: '2026-09-15T10:00:00.000Z',
      previousSha256: null,
    } as const;
    const first = hashChatEvent({ ...common, payload: { output: 2, input: 1 } });
    const reordered = hashChatEvent({ ...common, payload: { input: 1, output: 2 } });
    const chained = hashChatEvent({
      ...common,
      payload: { input: 1, output: 2 },
      previousSha256: first.toString('hex'),
    });
    expect(reordered.equals(first)).toBe(true);
    expect(chained.equals(first)).toBe(false);
  });
});
