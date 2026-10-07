import { describe, expect, it } from 'vitest';
import { createDeterministicRuntime, createLazyRuntime } from '../src/runtime.js';

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

  it('separates model manifests and honors each selected dimension', async () => {
    const runtime = createDeterministicRuntime();
    const first = await runtime.embed(['model boundary'], 16, 0, {
      manifestDigest: 'ab'.repeat(32),
      dimensions: 17,
    });
    const second = await runtime.embed(['model boundary'], 16, 0, {
      manifestDigest: 'cd'.repeat(32),
      dimensions: 17,
    });
    expect(first.vectors[0]).toHaveLength(17);
    expect(second.vectors[0]).toHaveLength(17);
    expect(first.vectors[0]).not.toEqual(second.vectors[0]);
  });

  it('reports and safely changes the managed CPU thread allocation', async () => {
    const runtime = createDeterministicRuntime(1024, undefined, 8);
    expect(runtime.runtimeStatus()).toEqual({
      availableProcessors: 8,
      threads: 1,
      generation: 0,
    });
    await expect(runtime.configureThreads(6)).resolves.toEqual({
      availableProcessors: 8,
      threads: 6,
      generation: 1,
    });
    await expect(runtime.configureThreads(9)).rejects.toThrow('EMBEDDER_THREAD_COUNT_INVALID');
  });

  it('starts before model files exist and retries loading after they become available', async () => {
    let available = false;
    let attempts = 0;
    const runtime = createLazyRuntime(1024, async () => {
      attempts += 1;
      if (!available) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return createDeterministicRuntime();
    });

    await expect(runtime.embed(['first attempt'], 16)).rejects.toMatchObject({ code: 'ENOENT' });
    available = true;
    await expect(runtime.embed(['second attempt'], 16)).resolves.toMatchObject({
      vectors: [expect.any(Array)],
    });
    expect(attempts).toBe(2);
    await runtime.close();
  });
});
