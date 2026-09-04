import type { Pool, PoolClient } from 'pg';

export type SqlClient = Pick<PoolClient, 'query'>;

export const databaseInteger = (value: unknown, label: string): number => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint' || typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside JavaScript's safe integer range.`);
  }
  return parsed;
};

export const withTransaction = async <T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
