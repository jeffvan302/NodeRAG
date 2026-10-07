import { describe, expect, it, vi } from 'vitest';
import { SemanticEvidenceCache, semanticEvidenceCacheKey } from '../src/search/evidence-cache.js';

const keyFor = (passage: string, manifestDigest = 'model-a') =>
  semanticEvidenceCacheKey({
    query: 'tax revenue',
    passage,
    manifestDigest,
    dimensions: 1024,
    maximumTokens: 8192,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    calibration: { minimumVectorSimilarity: 0.3, highConfidenceVectorSimilarity: 0.7 },
  });

describe('semantic evidence cache', () => {
  it('keys entries by query, passage, model, and retrieval policy', () => {
    expect(keyFor('A revenue passage.')).toBe(keyFor('A revenue passage.'));
    expect(keyFor('A revenue passage.')).not.toBe(keyFor('A different passage.'));
    expect(keyFor('A revenue passage.')).not.toBe(keyFor('A revenue passage.', 'model-b'));
  });

  it('reuses completed work and expires bounded entries', async () => {
    let now = 100;
    const cache = new SemanticEvidenceCache(1, 50, () => now);
    const compute = vi.fn(async () => [
      { kind: 'semantic' as const, text: 'Tax revenue supports services.', confidence: 0.86 },
    ]);
    await expect(cache.getOrCompute(keyFor('first'), compute)).resolves.toMatchObject({
      status: 'miss',
    });
    await expect(cache.getOrCompute(keyFor('first'), compute)).resolves.toMatchObject({
      status: 'hit',
    });
    expect(compute).toHaveBeenCalledTimes(1);

    await cache.getOrCompute(keyFor('second'), compute);
    await cache.getOrCompute(keyFor('first'), compute);
    expect(compute).toHaveBeenCalledTimes(3);

    now += 51;
    await expect(cache.getOrCompute(keyFor('first'), compute)).resolves.toMatchObject({
      status: 'miss',
    });
    expect(compute).toHaveBeenCalledTimes(4);
  });

  it('shares an in-flight model call without caching failures', async () => {
    const cache = new SemanticEvidenceCache();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compute = vi.fn(async () => {
      await gate;
      return [{ kind: 'semantic' as const, text: 'Shared evidence.', confidence: 0.75 }];
    });
    const first = cache.getOrCompute(keyFor('shared'), compute);
    const second = cache.getOrCompute(keyFor('shared'), compute);
    release();
    await expect(first).resolves.toMatchObject({ status: 'miss' });
    await expect(second).resolves.toMatchObject({ status: 'shared' });
    expect(compute).toHaveBeenCalledTimes(1);

    const failure = vi.fn(async () => Promise.reject(new Error('model-unavailable')));
    await expect(cache.getOrCompute(keyFor('failure'), failure)).rejects.toThrow(
      'model-unavailable',
    );
    await expect(cache.getOrCompute(keyFor('failure'), failure)).rejects.toThrow(
      'model-unavailable',
    );
    expect(failure).toHaveBeenCalledTimes(2);
  });
});
