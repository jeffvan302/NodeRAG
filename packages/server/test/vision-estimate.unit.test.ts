import { describe, expect, it } from 'vitest';
import { calculateVisionDispatchEstimate } from '../src/vision/estimate.js';

describe('enhanced PDF vision estimates', () => {
  it('keeps images per call independent from provider parallelism', () => {
    expect(calculateVisionDispatchEstimate(11, 5, 2, 1_000)).toEqual({
      estimatedImages: 11,
      imagesPerCall: 5,
      parallelCalls: 2,
      estimatedBatches: 3,
      estimatedParallelWaves: 2,
      provisionalElapsedMs: 2_000,
    });
  });

  it('returns an honest unknown duration without a provider baseline', () => {
    expect(calculateVisionDispatchEstimate(0, 0, 0, null)).toEqual({
      estimatedImages: 0,
      imagesPerCall: 1,
      parallelCalls: 1,
      estimatedBatches: 0,
      estimatedParallelWaves: 0,
      provisionalElapsedMs: null,
    });
  });
});
