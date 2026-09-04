import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Pool } from 'pg';
import { databaseInteger } from '../store/database.js';
import type { ArchiveEntrySource, BackupDataClass, BackupProduct } from './archive.js';
import { verifyEncryptedArchive, writeEncryptedArchive } from './archive.js';
import { withMaintenance } from './maintenance.js';
import {
  assertClassifiedSchema,
  assertPortableValueSafe,
  includedTables,
  preflightBackup,
  type BackupClassificationPolicy,
} from './policy.js';

export interface BackupExecutionOptions {
  readonly pool: Pool;
  readonly operationId: number;
  readonly product: BackupProduct;
  readonly destination: string;
  readonly passphrase: string;
  readonly dataRoot: string;
  readonly policy: BackupClassificationPolicy;
  readonly migrationHead: string;
  readonly postgresMajor: number;
  readonly postgresClientMajor: number;
  readonly requiredFreeBytes: number;
  readonly nodeRagVersion: string;
  readonly databaseDump?: () => AsyncIterable<Uint8Array>;
  readonly secretExport?: () => AsyncIterable<Uint8Array>;
  readonly includeModels?: boolean;
  readonly volumeBytes?: number;
}

const databaseClass = (value: string): BackupDataClass => {
  if (
    value === 'source-of-truth' ||
    value === 'behavioral-provenance' ||
    value === 'derived' ||
    value === 'secrets' ||
    value === 'security-history'
  )
    return value;
  throw new Error(`excluded-database-class:${value}`);
};

const tableContent = async function* (
  pool: Pool,
  table: string,
  excludedColumns: readonly string[],
  scanForSecrets: boolean,
): AsyncGenerator<Uint8Array> {
  if (!/^[a-z][a-z0-9_]*$/u.test(table)) throw new Error('unsafe-backup-table-name');
  let offset = 0;
  while (true) {
    const page = await pool.query<{ value: unknown }>(
      `SELECT to_jsonb(value) - $1::text[] AS value
       FROM (SELECT * FROM noderag.${table} ORDER BY ctid OFFSET $2 LIMIT 500) value`,
      [excludedColumns, offset],
    );
    for (const row of page.rows) {
      if (scanForSecrets) assertPortableValueSafe(row.value, `noderag.${table}`);
      yield Buffer.from(`${JSON.stringify(row.value)}\n`, 'utf8');
    }
    if (page.rows.length < 500) return;
    offset += page.rows.length;
  }
};

const databaseEntries = async function* (
  options: BackupExecutionOptions,
): AsyncGenerator<ArchiveEntrySource> {
  if (options.product === 'full') {
    if (options.databaseDump === undefined) throw new Error('database-dump-source-unavailable');
    yield {
      path: 'database/logical.dump',
      class: 'source-of-truth',
      owner: 'database:noderag',
      content: options.databaseDump(),
    };
    const secretCount = await options.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM noderag.encrypted_secret`,
    );
    if (Number(secretCount.rows[0]?.count ?? '0') > 0 && options.secretExport === undefined)
      throw new Error('backup-secret-exporter-unavailable');
    if (options.secretExport !== undefined)
      yield {
        path: 'database/secrets.ndjson',
        class: 'secrets',
        owner: 'secrets:installation',
        content: options.secretExport(),
      };
  }
  for (const table of includedTables(options.policy, options.product)) {
    yield {
      path: `database/tables/${table.table}.ndjson`,
      class: databaseClass(table.class),
      owner: `table:noderag.${table.table}`,
      content: tableContent(
        options.pool,
        table.table,
        options.product === 'portable' ? (table.portableExcludedColumns ?? []) : [],
        options.product === 'portable',
      ),
    };
  }
};

const managedFiles = async function* (
  root: string,
  directory: string,
  archivePrefix: 'documents' | 'models',
  dataClass: BackupDataClass,
): AsyncGenerator<ArchiveEntrySource> {
  const absoluteRoot = resolve(root);
  const current = resolve(directory);
  if (current !== absoluteRoot && !current.startsWith(`${absoluteRoot}${sep}`))
    throw new Error('backup-file-root-escaped');
  let children;
  try {
    children = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, child.name);
    const information = await lstat(path);
    if (information.isSymbolicLink()) throw new Error('backup-managed-symlink-rejected');
    if (information.isDirectory()) {
      yield* managedFiles(root, path, archivePrefix, dataClass);
      continue;
    }
    if (!information.isFile()) throw new Error('backup-managed-special-file-rejected');
    const managed = relative(join(absoluteRoot, archivePrefix), path).split(sep).join('/');
    if (managed.startsWith('../') || managed === '..') throw new Error('backup-file-root-escaped');
    const ownerMatch = /^\d{6}\/(\d+)\//u.exec(managed);
    yield {
      path: `${archivePrefix}/${managed}`,
      class: dataClass,
      owner: ownerMatch === null ? `${archivePrefix}:installation` : `document:${ownerMatch[1]}`,
      content: createReadStream(path),
    };
  }
};

const allEntries = async function* (
  options: BackupExecutionOptions,
): AsyncGenerator<ArchiveEntrySource> {
  yield* databaseEntries(options);
  yield* managedFiles(
    options.dataRoot,
    join(resolve(options.dataRoot), 'documents'),
    'documents',
    'source-of-truth',
  );
  if (options.product === 'full' && options.includeModels === true)
    yield* managedFiles(
      options.dataRoot,
      join(resolve(options.dataRoot), 'models'),
      'models',
      'derived',
    );
};

const failBackup = async (pool: Pool, operationId: number, error: unknown): Promise<void> => {
  const code = error instanceof Error ? error.message.split(':', 1)[0] : 'backup-failed';
  await pool.query(
    `UPDATE noderag.backup_operation
     SET state = 'failed', verification_state = 'failed', error_code = $2,
         failure_detail = jsonb_build_object('errorName', $3::text), finished_at = now()
     WHERE id = $1`,
    [
      operationId,
      code?.slice(0, 160) ?? 'backup-failed',
      error instanceof Error ? error.name : 'unknown',
    ],
  );
};

export const executeBackup = async (
  options: BackupExecutionOptions,
): Promise<{ readonly sidecarPath: string; readonly sha256: string }> => {
  const claimed = await options.pool.query(
    `UPDATE noderag.backup_operation
     SET state = 'running', product = $2, started_at = now(), error_code = NULL,
         failure_detail = '{}'::jsonb
     WHERE id = $1 AND state = 'queued'`,
    [options.operationId, options.product],
  );
  if (claimed.rowCount !== 1) throw new Error('backup-operation-not-queued');
  try {
    await preflightBackup({
      destination: options.destination,
      activeRoots: [options.dataRoot],
      passphrase: options.passphrase,
      requiredFreeBytes: options.requiredFreeBytes,
      postgresClientMajor: options.postgresClientMajor,
      postgresServerMajor: options.postgresMajor,
    });
    await assertClassifiedSchema(options.pool, options.policy);
    return await withMaintenance(options.pool, 'backup', options.operationId, async () => {
      const clock = await options.pool.query<{ consistency_at: Date }>(
        'SELECT clock_timestamp() AS consistency_at',
      );
      const consistencyAt = clock.rows[0]?.consistency_at.toISOString();
      if (consistencyAt === undefined) throw new Error('database-clock-unavailable');
      const written = await writeEncryptedArchive({
        destinationDirectory: options.destination,
        baseName: `noderag-backup-${String(options.operationId)}`,
        passphrase: options.passphrase,
        product: options.product,
        consistencyAt,
        migrationHead: options.migrationHead,
        postgresMajor: options.postgresMajor,
        nodeRagVersion: options.nodeRagVersion,
        entries: allEntries(options),
        ...(options.volumeBytes === undefined ? {} : { volumeBytes: options.volumeBytes }),
      });
      await options.pool.query(
        `UPDATE noderag.backup_operation
         SET state = 'verifying', archive_path = $2, sidecar_path = $3,
             archive_sha256 = $4, archive_bytes = $5, volume_count = $6,
             consistency_at = $7, encryption = $8
         WHERE id = $1`,
        [
          options.operationId,
          join(options.destination, `noderag-backup-${String(options.operationId)}.nrag.*`),
          written.sidecarPath,
          written.sidecar.archive.sha256,
          written.sidecar.archive.bytes,
          written.sidecar.volumes.length,
          consistencyAt,
          written.sidecar.encryption,
        ],
      );
      const verified = await verifyEncryptedArchive(written.sidecarPath, options.passphrase);
      if (verified.manifest.entries.length === 0) throw new Error('backup-archive-empty');
      await options.pool.query(
        `UPDATE noderag.backup_operation
         SET state = 'succeeded', verification_state = 'verified', verified_at = now(),
             finished_at = now(), manifest = $2
         WHERE id = $1`,
        [options.operationId, verified.manifest],
      );
      return { sidecarPath: written.sidecarPath, sha256: written.sidecar.archive.sha256 };
    });
  } catch (error) {
    await failBackup(options.pool, options.operationId, error);
    throw error;
  }
};

export const createBackupOperation = async (
  pool: Pool,
  product: BackupProduct,
  destinationId: number,
  principalId: number,
  includeModels = false,
): Promise<number> => {
  const created = await pool.query<{ id: unknown }>(
    `INSERT INTO noderag.backup_operation
       (product, destination_id, requested_by, include_models)
     SELECT $1, location.id, $3, $4
     FROM noderag.storage_location location
     WHERE location.id = $2 AND location.enabled AND location.purpose = 'backup'
     RETURNING id`,
    [product, destinationId, principalId, includeModels],
  );
  if (created.rows[0] === undefined) throw new Error('backup-destination-not-found');
  return databaseInteger(created.rows[0].id, 'backup operation id');
};
