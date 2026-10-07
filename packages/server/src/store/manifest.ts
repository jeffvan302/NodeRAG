import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
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

const inferredRepositoryRoot = [process.cwd(), resolve(process.cwd(), '../..')].find((candidate) =>
  existsSync(resolve(candidate, 'platform/migration-checksums.v1.json')),
);
const repositoryRoot = resolve(
  process.env['NODERAG_REPOSITORY_ROOT'] ?? inferredRepositoryRoot ?? process.cwd(),
);
const configuredMigrationsDirectory = process.env['NODERAG_MIGRATIONS_DIRECTORY'];

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
    const migrationPath =
      configuredMigrationsDirectory === undefined
        ? resolve(repositoryRoot, migration.path)
        : resolve(defaultMigrationsDirectory, basename(migration.path));
    const bytes = await readFile(migrationPath);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== migration.sha256) {
      throw new Error(`Migration checksum mismatch: ${migration.path}`);
    }
  }
  return manifest;
};
