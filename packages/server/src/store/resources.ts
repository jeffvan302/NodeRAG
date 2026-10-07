import { setTimeout as delay } from 'node:timers/promises';
import type { Embedder, EmbedderModel, EmbeddingBatch } from '@noderag/shared';
import type { Pool, PoolClient } from 'pg';
import { databaseInteger, withTransaction } from './database.js';

const embeddingIndexGate = 6_248_686_909;

interface ResourceLease {
  readonly resource: 'cpu';
  readonly slot: number;
  readonly owner: string;
  readonly epoch: number;
}

const acquireCpu = async (pool: Pool, owner: string, priority: number): Promise<ResourceLease> => {
  const deadline = Date.now() + (priority <= 1 ? 10_000 : 10 * 60_000);
  while (Date.now() < deadline) {
    const lease = await withTransaction(pool, async (database) => {
      const acquired = await database.query<{ slot: number; lease_epoch: unknown }>(
        `WITH candidate AS (
           SELECT slot FROM noderag.resource_lease
           WHERE resource = 'cpu' AND (owner IS NULL OR leased_until <= now())
             AND (
               $2::integer <= 1
               OR NOT COALESCE((SELECT throttle_when_busy FROM noderag.settings WHERE id=1), true)
               OR slot > 0
             )
           ORDER BY CASE WHEN $2::integer <= 1 AND slot = 0 THEN 0 ELSE 1 END, slot
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE noderag.resource_lease lease
         SET owner = $1, lease_epoch = lease.lease_epoch + 1,
             leased_until = now() + interval '60 seconds'
         FROM candidate
         WHERE lease.resource = 'cpu' AND lease.slot = candidate.slot
         RETURNING lease.slot, lease.lease_epoch`,
        [owner, priority],
      );
      const row = acquired.rows[0];
      return row === undefined
        ? null
        : {
            resource: 'cpu' as const,
            slot: row.slot,
            owner,
            epoch: databaseInteger(row.lease_epoch, 'resource lease epoch'),
          };
    });
    if (lease !== null) return lease;
    await delay(25);
  }
  throw new Error('cpu-resource-timeout');
};

const releaseCpu = async (pool: Pool, lease: ResourceLease): Promise<void> => {
  await pool.query(
    `UPDATE noderag.resource_lease
     SET owner = NULL, leased_until = NULL
     WHERE resource = $1 AND slot = $2 AND owner = $3 AND lease_epoch = $4`,
    [lease.resource, lease.slot, lease.owner, lease.epoch],
  );
};

const withAdvisoryGate = async <T>(
  pool: Pool,
  mode: 'embedding' | 'hnsw',
  operation: () => Promise<T>,
): Promise<T> => {
  const client: PoolClient = await pool.connect();
  const shared = mode === 'embedding';
  try {
    await client.query(
      shared ? 'SELECT pg_advisory_lock_shared($1::bigint)' : 'SELECT pg_advisory_lock($1::bigint)',
      [embeddingIndexGate],
    );
    return await operation();
  } finally {
    await client.query(
      shared
        ? 'SELECT pg_advisory_unlock_shared($1::bigint)'
        : 'SELECT pg_advisory_unlock($1::bigint)',
      [embeddingIndexGate],
    );
    client.release();
  }
};

export const withCpuResource = async <T>(
  pool: Pool,
  owner: string,
  operation: () => Promise<T>,
  priority = 5,
): Promise<T> => {
  const lease = await acquireCpu(pool, owner, priority);
  try {
    return await operation();
  } finally {
    await releaseCpu(pool, lease);
  }
};

export const withHnswBuildResource = async <T>(
  pool: Pool,
  owner: string,
  operation: () => Promise<T>,
): Promise<T> => withCpuResource(pool, owner, () => withAdvisoryGate(pool, 'hnsw', operation), 8);

export const coordinatedEmbedder = (pool: Pool, owner: string, embedder: Embedder): Embedder => ({
  countTokens: (
    texts: readonly string[],
    priority?: number,
    model?: EmbedderModel,
  ): Promise<readonly number[]> =>
    withCpuResource(
      pool,
      `${owner}:tokenize`,
      () => embedder.countTokens(texts, priority, model),
      priority ?? 5,
    ),
  embed: (
    texts: readonly string[],
    maximumTokens: number,
    priority?: number,
    model?: EmbedderModel,
  ): Promise<EmbeddingBatch> =>
    withCpuResource(
      pool,
      `${owner}:embed`,
      () =>
        withAdvisoryGate(pool, 'embedding', () =>
          embedder.embed(texts, maximumTokens, priority, model),
        ),
      priority ?? 5,
    ),
});
