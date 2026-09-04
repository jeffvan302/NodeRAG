import { describe, expect, it } from 'vitest';
import { evaluateReadinessState, readinessPermits } from '../src/application/readiness-policy.js';

describe('readiness policy', () => {
  it('fails closed for mutations and worker claims outside operational state', () => {
    for (const state of [
      'unconfigured',
      'initializing',
      'maintenance',
      'upgrade_required',
      'database_ahead',
      'degraded',
      'unavailable',
    ] as const) {
      expect(readinessPermits(state, 'mutation')).toBe(false);
      expect(readinessPermits(state, 'worker_claim')).toBe(false);
      expect(readinessPermits(state, 'health')).toBe(true);
    }
    expect(readinessPermits('operational', 'mutation')).toBe(true);
  });

  it('distinguishes setup, migration, maintenance, and degraded states', () => {
    const base = {
      databaseReachable: true,
      configured: true,
      setupInitializing: false,
      migrationHead: '000002_identity_foundation',
      expectedMigrationHead: '000002_identity_foundation',
      knownMigrationOrder: ['000001_foundation', '000002_identity_foundation'],
      maintenance: false,
      degraded: false,
    } as const;
    expect(evaluateReadinessState(base)).toBe('operational');
    expect(evaluateReadinessState({ ...base, configured: false })).toBe('unconfigured');
    expect(evaluateReadinessState({ ...base, migrationHead: '000001_foundation' })).toBe(
      'upgrade_required',
    );
    expect(evaluateReadinessState({ ...base, migrationHead: 'future' })).toBe('database_ahead');
    expect(evaluateReadinessState({ ...base, maintenance: true })).toBe('maintenance');
    expect(evaluateReadinessState({ ...base, degraded: true })).toBe('degraded');
  });
});
