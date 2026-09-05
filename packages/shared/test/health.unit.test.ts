import { describe, expect, it } from 'vitest';
import { healthResponseSchema, readinessResponseSchema } from '../src/index.js';

describe('service contracts', () => {
  it('accepts the stable health envelope', () => {
    expect(
      healthResponseSchema.parse({ service: 'noderag', status: 'ok', version: '1.0.0-rc.1' }),
    ).toEqual({ service: 'noderag', status: 'ok', version: '1.0.0-rc.1' });
  });

  it('rejects readiness without a reason when unavailable is represented incorrectly', () => {
    expect(() =>
      readinessResponseSchema.parse({
        service: 'noderag',
        status: 'missing',
        migrationHead: null,
        expectedMigrationHead: '000001_foundation',
        reasons: [],
      }),
    ).toThrow();
  });
});
