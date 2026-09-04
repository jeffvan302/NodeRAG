import { Client, type ClientConfig } from 'pg';
import type { ReadinessResponse } from '@noderag/shared';
import { loadAndVerifyMigrationManifest } from './manifest.js';

export type ReadinessProbe = () => Promise<ReadinessResponse>;

export const unavailableReadiness = async (): Promise<ReadinessResponse> => {
  const manifest = await loadAndVerifyMigrationManifest();
  return {
    service: 'noderag',
    status: 'unavailable',
    migrationHead: null,
    expectedMigrationHead: manifest.expectedHead,
    reasons: ['database-not-configured'],
  };
};

export const createDatabaseReadinessProbe =
  (database: ClientConfig): ReadinessProbe =>
  async () => {
    const manifest = await loadAndVerifyMigrationManifest();
    const client = new Client(database);
    await client.connect();
    try {
      const applied = await client.query<{ name: string }>(
        'SELECT name FROM public.noderag_migrations ORDER BY id DESC LIMIT 1',
      );
      const checksums = await client.query<{ migration_id: string; sha256: string }>(
        'SELECT migration_id, sha256 FROM noderag.migration_checksums ORDER BY migration_id',
      );
      const migrationHead = applied.rows[0]?.name ?? null;
      const expectedChecksums = new Map(manifest.migrations.map((item) => [item.id, item.sha256]));
      const checksumMatches =
        checksums.rows.length === expectedChecksums.size &&
        checksums.rows.every((row) => expectedChecksums.get(row.migration_id) === row.sha256);
      const reasons: string[] = [];
      if (migrationHead !== manifest.expectedHead) reasons.push('migration-head-mismatch');
      if (!checksumMatches) reasons.push('migration-checksum-mismatch');
      return {
        service: 'noderag',
        status: reasons.length === 0 ? 'ok' : 'unavailable',
        migrationHead,
        expectedMigrationHead: manifest.expectedHead,
        reasons,
      };
    } catch (error) {
      return {
        service: 'noderag',
        status: 'unavailable',
        migrationHead: null,
        expectedMigrationHead: manifest.expectedHead,
        reasons: [`database-check-failed:${error instanceof Error ? error.name : 'unknown'}`],
      };
    } finally {
      await client.end();
    }
  };
