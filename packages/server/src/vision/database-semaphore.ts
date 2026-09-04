import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { VisionConcurrency } from './service.js';

const visionAdvisoryNamespace = 1_315_079_167;

export class DatabaseVisionSemaphore implements VisionConcurrency {
  constructor(
    private readonly pool: Pool,
    readonly maximum: number,
  ) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16) {
      throw new Error('Database vision concurrency must be between 1 and 16.');
    }
  }

  async use<T>(operation: () => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    let slot: number | null = null;
    try {
      while (slot === null) {
        for (let candidate = 0; candidate < this.maximum; candidate += 1) {
          const claimed = await connection.query<{ claimed: boolean }>(
            'SELECT pg_try_advisory_lock($1, $2) AS claimed',
            [visionAdvisoryNamespace, candidate],
          );
          if (claimed.rows[0]?.claimed) {
            slot = candidate;
            break;
          }
        }
        if (slot === null) await delay(25);
      }
      return await operation();
    } finally {
      if (slot !== null) {
        await connection.query('SELECT pg_advisory_unlock($1, $2)', [
          visionAdvisoryNamespace,
          slot,
        ]);
      }
      connection.release();
    }
  }
}
