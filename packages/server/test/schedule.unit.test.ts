import { describe, expect, it } from 'vitest';
import { nextBackupScheduleAt } from '../src/recovery/schedule.js';

describe('scheduled backup UTC cadence', () => {
  it('selects the next daily time without local-time drift', () => {
    expect(
      nextBackupScheduleAt('daily', 2, 15, null, new Date('2026-09-04T01:00:00Z')).toISOString(),
    ).toBe('2026-09-04T02:15:00.000Z');
    expect(
      nextBackupScheduleAt('daily', 2, 15, null, new Date('2026-09-04T03:00:00Z')).toISOString(),
    ).toBe('2026-09-05T02:15:00.000Z');
  });

  it('selects the requested weekly UTC weekday', () => {
    expect(
      nextBackupScheduleAt('weekly', 4, 30, 1, new Date('2026-09-04T12:00:00Z')).toISOString(),
    ).toBe('2026-09-07T04:30:00.000Z');
    expect(() =>
      nextBackupScheduleAt('weekly', 4, 30, null, new Date('2026-09-04T12:00:00Z')),
    ).toThrow('backup-schedule-weekday-invalid');
  });
});
