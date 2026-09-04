import { Client, type ClientConfig } from 'pg';
import { runner } from 'node-pg-migrate';
import {
  defaultMigrationsDirectory,
  loadAndVerifyMigrationManifest,
  type MigrationManifest,
} from './manifest.js';

const migrationAdvisoryLock = 4_618_578_662;

const recordChecksums = async (
  database: ClientConfig,
  manifest: MigrationManifest,
): Promise<void> => {
  const client = new Client(database);
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const migration of manifest.migrations) {
      await client.query(
        `INSERT INTO noderag.migration_checksums (migration_id, sha256)
         VALUES ($1, $2)
         ON CONFLICT (migration_id) DO UPDATE SET sha256 = EXCLUDED.sha256
         WHERE noderag.migration_checksums.sha256 = EXCLUDED.sha256`,
        [migration.id, migration.sha256],
      );
      const result = await client.query<{ sha256: string }>(
        'SELECT sha256 FROM noderag.migration_checksums WHERE migration_id = $1',
        [migration.id],
      );
      if (result.rows[0]?.sha256 !== migration.sha256) {
        throw new Error(`Applied migration checksum drift: ${migration.id}`);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
};

export const runMigrations = async (database: ClientConfig): Promise<MigrationManifest> => {
  const lock = new Client(database);
  await lock.connect();
  await lock.query('SELECT pg_advisory_lock($1::bigint)', [migrationAdvisoryLock]);
  try {
    const manifest = await loadAndVerifyMigrationManifest();
    await runner({
      databaseUrl: database,
      dir: defaultMigrationsDirectory,
      migrationsTable: 'noderag_migrations',
      direction: 'up',
      checkOrder: true,
      singleTransaction: true,
      verbose: false,
      migrationLoaderStrategies: [{ extensions: ['.sql'], loader: 'sql' }],
    });
    await recordChecksums(database, manifest);
    return manifest;
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1::bigint)', [migrationAdvisoryLock]);
    await lock.end();
  }
};
