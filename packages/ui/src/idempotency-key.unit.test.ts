import { describe, expect, it } from 'vitest';
import { createIdempotencyKey } from './idempotency-key.js';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('createIdempotencyKey', () => {
  it('uses native randomUUID when the browser provides it', () => {
    expect(createIdempotencyKey({ randomUUID: () => 'native-request-id' })).toBe(
      'native-request-id',
    );
  });

  it('creates a UUID with getRandomValues when randomUUID is unavailable over HTTP', () => {
    const key = createIdempotencyKey({
      getRandomValues: (values) => {
        values.set(Array.from({ length: 16 }, (_, index) => index));
        return values;
      },
    });

    expect(key).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(key).toMatch(uuidV4);
  });

  it('still creates a valid unique key when no Web Crypto API is available', () => {
    const first = createIdempotencyKey(null);
    const second = createIdempotencyKey(null);

    expect(first).toMatch(uuidV4);
    expect(second).toMatch(uuidV4);
    expect(second).not.toBe(first);
  });
});
