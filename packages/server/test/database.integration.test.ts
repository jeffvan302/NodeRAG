import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/store/migrations.js';
import { createDatabaseReadinessProbe } from '../src/store/readiness.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

describe('foundation migration', () => {
  it('applies forward-only, records checksums, and remains idempotent', async () => {
    const container = await new PostgreSqlContainer(postgresImage)
      .withDatabase('noderag_test')
      .withUsername('noderag')
      .withPassword('synthetic-test-only-password')
      .start();
    try {
      const database = {
        host: container.getHost(),
        port: container.getPort(),
        database: container.getDatabase(),
        user: container.getUsername(),
        password: container.getPassword(),
      };
      const [first, second] = await Promise.all([runMigrations(database), runMigrations(database)]);
      expect(second.expectedHead).toBe(first.expectedHead);

      const readiness = await createDatabaseReadinessProbe(database)();
      expect(readiness).toEqual({
        service: 'noderag',
        status: 'unavailable',
        state: 'unconfigured',
        migrationHead: '000003_markdown_slice',
        expectedMigrationHead: '000003_markdown_slice',
        reasons: ['readiness-state:unconfigured'],
      });

      const client = new Client(database);
      await client.connect();
      const vector = await client.query<{ extversion: string }>(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
      );
      const marker = await client.query<{ milestone: string }>(
        "SELECT value->>'milestone' AS milestone FROM noderag.system_metadata WHERE key='foundation'",
      );
      await client.end();
      expect(vector.rows[0]?.extversion).toBe('0.8.6');
      expect(marker.rows[0]?.milestone).toBe('M02');
    } finally {
      await container.stop();
    }
  });
});
