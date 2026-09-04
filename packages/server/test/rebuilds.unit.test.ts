import { describe, expect, it } from 'vitest';
import { calculateRebuildEstimate } from '../src/store/rebuilds.js';

describe('M11 rebuild planning', () => {
  it('produces a deterministic capacity and duration estimate before work exists', () => {
    const estimate = calculateRebuildEstimate({
      sourceCharacters: 10_000n,
      documentCount: 4n,
      reusableCharacters: 2_000n,
      reusableVisionArtifacts: 7n,
      targetChars: 2_000,
      overlapChars: 300,
      dimensions: 1_024,
      embeddingCharactersPerSecond: 1_500,
      availableBytes: 20n * 1024n ** 3n,
      freeSpaceReserveBytes: 10n * 1024n ** 3n,
    });

    expect(estimate).toEqual({
      sourceCharacters: 10_000n,
      expectedChunks: 6n,
      estimatedEmbeddingSeconds: 6n,
      estimatedVisionReuse: 7n,
      temporaryBytes: 57_888n,
      requiredFreeBytes: 10_737_476_128n,
      availableBytes: 21_474_836_480n,
      fits: true,
    });
  });

  it('fails closed on impossible overlap, dimensions, throughput, or cache accounting', () => {
    const valid = {
      sourceCharacters: 1_000n,
      documentCount: 1n,
      reusableCharacters: 0n,
      reusableVisionArtifacts: 0n,
      targetChars: 1_200,
      overlapChars: 200,
      dimensions: 1_024,
      embeddingCharactersPerSecond: 1_000,
      availableBytes: 1_000_000n,
      freeSpaceReserveBytes: 0n,
    } as const;
    expect(() => calculateRebuildEstimate({ ...valid, overlapChars: 700 })).toThrow(
      'invalid-rebuild-estimate-input',
    );
    expect(() => calculateRebuildEstimate({ ...valid, dimensions: 0 })).toThrow(
      'invalid-rebuild-estimate-input',
    );
    expect(() => calculateRebuildEstimate({ ...valid, embeddingCharactersPerSecond: 0 })).toThrow(
      'invalid-rebuild-estimate-input',
    );
    expect(() => calculateRebuildEstimate({ ...valid, reusableCharacters: 1_001n })).toThrow(
      'invalid-rebuild-estimate-input',
    );
  });
});
