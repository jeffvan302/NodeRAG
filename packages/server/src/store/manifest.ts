import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const migrationSchema = z.object({
  id: z.string().regex(/^\d{6}_[a-z0-9_]+$/),
  path: z.string().startsWith('packages/server/migrations/'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  direction: z.literal('up-only'),
});

const manifestSchema = z.object({
  version: z.literal(1),
  expectedHead: z.string(),
  migrations: z.array(migrationSchema).min(1),
});

export type MigrationManifest = z.infer<typeof manifestSchema>;

const repositoryRoot = resolve(process.env['NODERAG_REPOSITORY_ROOT'] ?? process.cwd());

export const defaultManifestPath = resolve(
  process.env['NODERAG_MIGRATION_MANIFEST'] ??
    resolve(repositoryRoot, 'platform/migration-checksums.v1.json'),
);
export const defaultMigrationsDirectory = resolve(
  process.env['NODERAG_MIGRATIONS_DIRECTORY'] ??
    resolve(repositoryRoot, 'packages/server/migrations'),
);

export const loadAndVerifyMigrationManifest = async (
  manifestPath = defaultManifestPath,
): Promise<MigrationManifest> => {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  const manifest = manifestSchema.parse(parsed);
  const ids = manifest.migrations.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || ids.join('\n') !== [...ids].sort().join('\n')) {
    throw new Error('Migration IDs must be unique and sorted.');
  }
  if (manifest.expectedHead !== ids.at(-1)) {
    throw new Error('expectedHead must equal the final migration ID.');
  }
  for (const migration of manifest.migrations) {
    const bytes = await readFile(resolve(repositoryRoot, migration.path));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== migration.sha256) {
      throw new Error(`Migration checksum mismatch: ${migration.path}`);
    }
  }
  return manifest;
};
