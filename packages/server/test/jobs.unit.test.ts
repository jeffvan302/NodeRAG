import { describe, expect, it } from 'vitest';
import { ClassifiedJobError, JobCancellationError, classifyJobError } from '../src/store/jobs.js';

describe('durable job failure classification', () => {
  it('keeps explicit retry classes and structured codes', () => {
    expect(
      classifyJobError(
        new ClassifiedJobError('provider-timeout', 'transient', 'try again', { provider: 'test' }),
      ),
    ).toEqual({
      code: 'provider-timeout',
      errorClass: 'transient',
      message: 'try again',
      detail: { provider: 'test' },
    });
    expect(classifyJobError(new JobCancellationError()).errorClass).toBe('cancelled');
    expect(classifyJobError(new Error('markdown-hash-mismatch')).errorClass).toBe('permanent');
    expect(classifyJobError(new Error('external outcome was not acknowledged')).errorClass).toBe(
      'indeterminate',
    );
  });
});
