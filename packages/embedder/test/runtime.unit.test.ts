import { describe, expect, it } from 'vitest';
import { createDeterministicRuntime } from '../src/runtime.js';

describe('deterministic test embedder', () => {
  it('returns finite normalized 1024-dimensional vectors and enforces token limits', async () => {
    const runtime = createDeterministicRuntime();
    const batch = await runtime.embed(['maintenance cost ledger'], 16);
    const vector = batch.vectors[0] ?? [];
    expect(vector).toHaveLength(1024);
    expect(vector.every(Number.isFinite)).toBe(true);
    expect(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 10);
    await expect(runtime.embed(['one two three'], 2)).rejects.toThrow('TOKEN_LIMIT');
  });
});
