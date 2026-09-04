import { describe, expect, it } from 'vitest';
import { planUpgrade } from '../src/recovery/upgrade.js';

describe('upgrade planning', () => {
  it('requires a complete safety copy for same-major upgrades', () => {
    expect(planUpgrade(17, 17, 500)).toEqual({
      kind: 'same-major',
      fromPostgresMajor: 17,
      toPostgresMajor: 17,
      logicalDatabaseBytes: 500,
      requiredFreeBytes: 500,
    });
  });

  it('requires twice the logical database size for a PostgreSQL-major transition', () => {
    expect(planUpgrade(17, 18, 750)).toEqual({
      kind: 'postgres-major',
      fromPostgresMajor: 17,
      toPostgresMajor: 18,
      logicalDatabaseBytes: 750,
      requiredFreeBytes: 1500,
    });
  });
});
