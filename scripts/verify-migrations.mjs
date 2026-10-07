import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'platform/migration-checksums.v1.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (
  manifest.version !== 1 ||
  !Array.isArray(manifest.migrations) ||
  manifest.migrations.length === 0
) {
  throw new Error('Invalid migration manifest shape.');
}
const ids = manifest.migrations.map((migration) => migration.id);
if (new Set(ids).size !== ids.length || ids.join('\n') !== [...ids].sort().join('\n')) {
  throw new Error('Migration IDs must be unique and sorted.');
}
if (manifest.expectedHead !== ids.at(-1)) throw new Error('Migration head is not the final ID.');
const runtimeSchemaRevision = await readFile(
  resolve(root, 'packages/server/src/store/schema-revision.ts'),
  'utf8',
);
const declaredRuntimeHead = /CURRENT_SCHEMA_REVISION\s*=\s*'([^']+)'/u.exec(
  runtimeSchemaRevision,
)?.[1];
if (declaredRuntimeHead !== manifest.expectedHead) {
  throw new Error('Runtime schema revision does not match the migration manifest head.');
}

for (const migration of manifest.migrations) {
  if (migration.direction !== 'up-only') throw new Error(`${migration.id} is not forward-only.`);
  const bytes = await readFile(resolve(root, migration.path));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== migration.sha256) throw new Error(`Checksum mismatch: ${migration.path}`);
  const sql = bytes.toString('utf8');
  if (/--\s*down migration/i.test(sql)) throw new Error(`Down migration found: ${migration.path}`);
}

const diskFiles = (await readdir(resolve(root, 'packages/server/migrations')))
  .filter((file) => file.endsWith('.sql'))
  .sort();
const listedFiles = manifest.migrations.map((migration) => migration.path.split('/').at(-1)).sort();
if (diskFiles.join('\n') !== listedFiles.join('\n')) {
  throw new Error('Migration manifest does not cover exactly the SQL migrations on disk.');
}
console.info(
  `Verified ${ids.length} forward-only migration; expected head ${manifest.expectedHead}.`,
);
