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
        migrationHead: '000029_chat_files',
        expectedMigrationHead: '000029_chat_files',
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
      const visionDefaults = await client.query<{
        ollama_model: string;
        ollama_parallel: number;
        ollama_images_per_call: number;
        ollama_timeout_ms: number;
        ollama_max_attempts: number;
        max_image_px: number;
      }>(
        `SELECT ollama_model,ollama_parallel,ollama_images_per_call,ollama_timeout_ms,
                ollama_max_attempts,max_image_px
         FROM noderag.settings WHERE id=1`,
      );
      await client.end();
      expect(vector.rows[0]?.extversion).toBe('0.8.6');
      expect(marker.rows[0]?.milestone).toBe('M02');
      expect(visionDefaults.rows[0]).toEqual({
        ollama_model: 'minimax-m3:cloud',
        ollama_parallel: 2,
        ollama_images_per_call: 3,
        ollama_timeout_ms: 120_000,
        ollama_max_attempts: 3,
        max_image_px: 1650,
      });
    } finally {
      await container.stop();
    }
  });
});
