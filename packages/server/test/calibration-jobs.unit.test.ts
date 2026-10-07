import { describe, expect, it } from 'vitest';
import { CalibrationJobRegistry } from '../src/api/calibration-jobs.js';

const deferred = <Value>() => {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

describe('background embedding calibration', () => {
  it('returns immediately, reports progress, and retains the completed result', async () => {
    const completion = deferred<{ readonly charactersPerSecond: number }>();
    const registry = new CalibrationJobRegistry((error) =>
      error instanceof Error ? error.message : 'embedding_calibration_failed',
    );

    const started = registry.start(17, async (report) => {
      report('measuring', 20);
      const result = await completion.promise;
      report('finalizing', 95);
      return result;
    });
    expect(started).toMatchObject({ state: 'running', phase: 'loading-model', progress: 1 });

    await Promise.resolve();
    expect(registry.status(17)).toMatchObject({ state: 'running', phase: 'measuring' });
    expect(registry.start(17, async () => ({ charactersPerSecond: 0 })).id).toBe(started.id);

    completion.resolve({ charactersPerSecond: 321 });
    await completion.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.status(17)).toMatchObject({
      id: started.id,
      state: 'succeeded',
      progress: 100,
      result: { charactersPerSecond: 321 },
      errorCode: null,
    });
    expect(registry.status(18)).toBeNull();
  });

  it('converts a background failure to a safe problem code', async () => {
    const registry = new CalibrationJobRegistry(() => 'embedding_model_load_failed');
    registry.start(19, async () => {
      throw new Error('sensitive runtime detail');
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.status(19)).toMatchObject({
      state: 'failed',
      errorCode: 'embedding_model_load_failed',
      result: null,
    });
  });
});
