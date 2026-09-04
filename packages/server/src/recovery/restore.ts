import { lstat, mkdir, open, readdir, rename, rm, statfs } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Pool } from 'pg';
import { withTransaction } from '../store/database.js';
import type {
  ArchiveEntryConsumer,
  BackupDataClass,
  BackupInnerManifest,
  BackupProduct,
  VerifiedArchive,
} from './archive.js';
import { verifyEncryptedArchive } from './archive.js';
import { withMaintenance } from './maintenance.js';
import { preflightRestoreCompatibility } from './policy.js';

export const restoreConfirmationPhrase = 'RESTORE THIS INSTALLATION';
export const portableImportConfirmationPhrase = 'IMPORT PORTABLE CORPUS';

export interface RestoreCompatibilityTarget {
  readonly supportedArchiveVersions: readonly number[];
  readonly migrationHead: string;
  readonly postgresMajor: number;
  readonly modelDimensions: readonly number[];
}

export interface RestoreDatabaseTarget {
  readonly fileActivationMode?: 'replace' | 'merge';
  readonly resetInstallationLocalState?: boolean;
  readonly commitsOperationState?: boolean;
  validateEntry?(path: string, dataClass: BackupDataClass): void;
  isBlank(): Promise<boolean>;
  prepare(operationId: number, manifest: BackupInnerManifest): Promise<void>;
  consumeFullDump(content: AsyncIterable<Uint8Array>): Promise<void>;
  consumePortableTable(
    table: string,
    rows: AsyncIterable<Readonly<Record<string, unknown>>>,
  ): Promise<void>;
  consumeSecrets(rows: AsyncIterable<Readonly<Record<string, unknown>>>): Promise<void>;
  verify(manifest: BackupInnerManifest): Promise<Readonly<Record<string, unknown>>>;
  activate(operationId: number, verification: Readonly<Record<string, unknown>>): Promise<void>;
  rollback(): Promise<void>;
  cleanup(retainStaging: boolean): Promise<void>;
}

export interface RestoreExecutionOptions {
  readonly pool: Pool;
  readonly operationId: number;
  readonly sidecarPath: string;
  readonly passphrase: string;
  readonly confirmation: string;
  readonly expectedConfirmation?: string;
  readonly dataRoot: string;
  readonly compatibility: RestoreCompatibilityTarget;
  readonly archivedModelDimensions?: readonly number[];
  readonly database: RestoreDatabaseTarget;
}

export interface RestoreInspection {
  readonly product: BackupProduct;
  readonly createdAt: string;
  readonly migrationHead: string;
  readonly postgresMajor: number;
  readonly archiveSha256: string;
  readonly archiveBytes: number;
  readonly volumeCount: number;
  readonly entryCount: number;
}

export const requiredRestoreCapacity = (
  entries: readonly { readonly path: string; readonly bytes: number }[],
): bigint => {
  const payload = entries
    .filter((entry) => /^(documents|models)\//u.test(entry.path))
    .reduce((total, entry) => total + BigInt(entry.bytes), 0n);
  return payload + payload / 5n;
};

export const assertRestoreCapacity = (availableBytes: bigint, requiredBytes: bigint): void => {
  if (availableBytes < requiredBytes) throw new Error('restore-target-insufficient-space');
};

const inspectionFrom = (verified: VerifiedArchive): RestoreInspection => ({
  product: verified.sidecar.product,
  createdAt: verified.sidecar.createdAt,
  migrationHead: verified.manifest.migrationHead,
  postgresMajor: verified.manifest.postgresMajor,
  archiveSha256: verified.sidecar.archive.sha256,
  archiveBytes: verified.sidecar.archive.bytes,
  volumeCount: verified.sidecar.volumes.length,
  entryCount: verified.manifest.entries.length,
});

export const inspectRestoreArchive = async (
  sidecarPath: string,
  passphrase: string,
  target: RestoreCompatibilityTarget,
  archivedModelDimensions: readonly number[] = [1024],
): Promise<{ readonly inspection: RestoreInspection; readonly verified: VerifiedArchive }> => {
  const verified = await verifyEncryptedArchive(sidecarPath, passphrase);
  preflightRestoreCompatibility(
    {
      archiveVersion: verified.sidecar.version,
      migrationHead: verified.manifest.migrationHead,
      postgresMajor: verified.manifest.postgresMajor,
      modelDimensions: archivedModelDimensions,
    },
    target,
  );
  return { inspection: inspectionFrom(verified), verified };
};

const jsonRows = async function* (
  content: AsyncIterable<Uint8Array>,
): AsyncGenerator<Readonly<Record<string, unknown>>> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  for await (const chunk of content) {
    pending += decoder.decode(chunk, { stream: true });
    if (pending.length > 16 * 1024 * 1024) throw new Error('portable-row-too-large');
    while (true) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.length === 0) continue;
      const value = JSON.parse(line) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('portable-row-invalid');
      yield value as Readonly<Record<string, unknown>>;
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) throw new Error('portable-table-missing-newline');
};

const safeStagingPath = (stagingRoot: string, archivePath: string): string => {
  if (!/^(documents|models)\//u.test(archivePath)) throw new Error('restore-file-class-invalid');
  const destination = resolve(stagingRoot, archivePath);
  const root = resolve(stagingRoot);
  if (!destination.startsWith(`${root}${sep}`)) throw new Error('restore-path-escaped-staging');
  return destination;
};

const writeStagedFile = async (
  stagingRoot: string,
  archivePath: string,
  content: AsyncIterable<Uint8Array>,
): Promise<void> => {
  const path = safeStagingPath(stagingRoot, archivePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  try {
    for await (const chunk of content) await handle.write(chunk);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

interface ActivatedFiles {
  readonly restored: readonly { readonly target: string; readonly retained: string | null }[];
}

const activateStagedFiles = async (
  dataRoot: string,
  stagingRoot: string,
  operationId: number,
  mode: 'replace' | 'merge',
): Promise<ActivatedFiles> => {
  const retainedRoot = join(resolve(dataRoot), 'restore-retained', String(operationId));
  const restored: Array<{ target: string; retained: string | null }> = [];
  await mkdir(retainedRoot, { recursive: true, mode: 0o700 });
  try {
    for (const family of ['documents', 'models'] as const) {
      const staged = join(stagingRoot, family);
      const target = join(resolve(dataRoot), family);
      try {
        if (!(await lstat(staged)).isDirectory()) throw new Error('restore-staging-family-invalid');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
      if (mode === 'merge') {
        const moveFiles = async (directory: string): Promise<void> => {
          for (const child of await readdir(directory, { withFileTypes: true })) {
            const source = join(directory, child.name);
            if (child.isDirectory()) {
              await moveFiles(source);
              continue;
            }
            if (!child.isFile()) throw new Error('restore-staging-family-invalid');
            const relativePath = relative(staged, source);
            const destination = resolve(target, relativePath);
            if (!destination.startsWith(`${resolve(target)}${sep}`))
              throw new Error('restore-path-escaped-staging');
            try {
              await lstat(destination);
              throw new Error('portable-file-conflict');
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error;
            }
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
            await rename(source, destination);
            restored.push({ target: destination, retained: null });
          }
        };
        await moveFiles(staged);
        continue;
      }
      const retained = join(retainedRoot, family);
      let moved = false;
      try {
        await rename(target, retained);
        moved = true;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      await rename(staged, target);
      restored.push({ target, retained: moved ? retained : null });
    }
    return { restored };
  } catch (error) {
    for (const item of restored.reverse()) {
      await rm(item.target, { recursive: true, force: true });
      if (item.retained !== null) await rename(item.retained, item.target);
    }
    throw error;
  }
};

const rollbackFiles = async (activation: ActivatedFiles): Promise<void> => {
  for (const item of [...activation.restored].reverse()) {
    await rm(item.target, { recursive: true, force: true });
    if (item.retained !== null) await rename(item.retained, item.target);
  }
};

const restoreConsumer =
  (database: RestoreDatabaseTarget, stagingRoot: string): ArchiveEntryConsumer =>
  async (header, content) => {
    database.validateEntry?.(header.path, header.class);
    if (header.path === 'database/logical.dump') {
      await database.consumeFullDump(content);
      return;
    }
    if (header.path === 'database/secrets.ndjson') {
      await database.consumeSecrets(jsonRows(content));
      return;
    }
    const table = /^database\/tables\/([a-z][a-z0-9_]*)\.ndjson$/u.exec(header.path)?.[1];
    if (table !== undefined) {
      await database.consumePortableTable(table, jsonRows(content));
      return;
    }
    await writeStagedFile(stagingRoot, header.path, content);
  };

export const resetInstallationLocalState = async (database: Pick<Pool, 'query'>): Promise<void> => {
  await database.query('DELETE FROM noderag.session');
  await database.query(
    `UPDATE noderag.job
     SET state = CASE WHEN state IN ('pending','leased','retry_wait','paused') THEN 'failed' ELSE state END,
         lease_owner = NULL, leased_until = NULL, heartbeat_at = NULL,
         error_class = CASE WHEN state IN ('pending','leased','retry_wait','paused') THEN 'indeterminate' ELSE error_class END,
         structured_error = CASE WHEN state IN ('pending','leased','retry_wait','paused')
           THEN '{"code":"restore-review-required"}'::jsonb ELSE structured_error END,
         finished_at = CASE WHEN state IN ('pending','leased','retry_wait','paused') THEN now() ELSE finished_at END,
         updated_at = now()`,
  );
  await database.query('UPDATE noderag.gateway SET enabled = false, bound_at = NULL');
  await database.query(
    `UPDATE noderag.settings
     SET vision_enabled = false, ollama_base_url = NULL, ollama_secret_id = NULL,
         updated_by = NULL, updated_at = now()`,
  );
  await database.query('UPDATE noderag.source SET schedule_enabled = false, next_crawl_at = NULL');
  await database.query('UPDATE noderag.backup_schedule SET enabled = false, next_run_at = NULL');
};

const failRestore = async (pool: Pool, operationId: number, error: unknown): Promise<void> => {
  const code = error instanceof Error ? error.message.split(':', 1)[0] : 'restore-failed';
  await pool.query(
    `UPDATE noderag.restore_operation
     SET state = 'failed', error_code = $2,
         failure_detail = jsonb_build_object('errorName', $3::text), finished_at = now()
     WHERE id = $1`,
    [
      operationId,
      code?.slice(0, 160) ?? 'restore-failed',
      error instanceof Error ? error.name : 'unknown',
    ],
  );
};

export const executeRestore = async (
  options: RestoreExecutionOptions,
): Promise<RestoreInspection> => {
  if (options.confirmation !== (options.expectedConfirmation ?? restoreConfirmationPhrase))
    throw new Error('restore-confirmation-mismatch');
  assertRestorePathOutsideData(options.dataRoot, options.sidecarPath);
  await options.pool.query(
    `UPDATE noderag.restore_operation
     SET state = 'inspecting', sidecar_path = $2, confirmation = $3,
         started_at = now(), error_code = NULL, failure_detail = '{}'::jsonb
     WHERE id = $1`,
    [options.operationId, resolve(options.sidecarPath), options.confirmation],
  );
  try {
    const { inspection, verified } = await inspectRestoreArchive(
      options.sidecarPath,
      options.passphrase,
      options.compatibility,
      options.archivedModelDimensions,
    );
    const requiredBytes = requiredRestoreCapacity(verified.manifest.entries);
    const space = await statfs(resolve(options.dataRoot), { bigint: true });
    assertRestoreCapacity(space.bavail * space.bsize, requiredBytes);
    if (!(await options.database.isBlank())) throw new Error('restore-target-not-blank');
    await options.pool.query(
      `UPDATE noderag.restore_operation
       SET state = 'ready', inspection = $2, source_manifest = $3 WHERE id = $1`,
      [options.operationId, inspection, verified.manifest],
    );
    return await withMaintenance(options.pool, 'restore', options.operationId, async () => {
      const stagingRoot = join(
        resolve(options.dataRoot),
        'restore-staging',
        String(options.operationId),
      );
      await rm(stagingRoot, { recursive: true, force: true });
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      await options.database.prepare(options.operationId, verified.manifest);
      await options.pool.query(
        `UPDATE noderag.restore_operation SET state = 'staging', staging_path = $2 WHERE id = $1`,
        [options.operationId, stagingRoot],
      );
      let activation: ActivatedFiles = { restored: [] };
      try {
        const restored = await verifyEncryptedArchive(
          options.sidecarPath,
          options.passphrase,
          restoreConsumer(options.database, stagingRoot),
        );
        await options.pool.query(
          `UPDATE noderag.restore_operation SET state = 'verifying' WHERE id = $1`,
          [options.operationId],
        );
        const verification = await options.database.verify(restored.manifest);
        activation = await activateStagedFiles(
          options.dataRoot,
          stagingRoot,
          options.operationId,
          options.database.fileActivationMode ?? 'replace',
        );
        await options.pool.query(
          `UPDATE noderag.restore_operation SET state = 'activating', verification = $2 WHERE id = $1`,
          [options.operationId, verification],
        );
        await options.database.activate(options.operationId, verification);
        if (options.database.resetInstallationLocalState !== false)
          await withTransaction(options.pool, resetInstallationLocalState);
        if (options.database.commitsOperationState !== true)
          await options.pool.query(
            `UPDATE noderag.restore_operation
             SET state = 'succeeded', activated_at = now(), finished_at = now() WHERE id = $1`,
            [options.operationId],
          );
        await options.database.cleanup(false).catch(() => undefined);
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        return inspection;
      } catch (error) {
        await options.database.rollback().catch(() => undefined);
        await rollbackFiles(activation).catch(() => undefined);
        await options.database.cleanup(true).catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    await failRestore(options.pool, options.operationId, error);
    throw error;
  }
};

export const assertRestorePathOutsideData = (dataRoot: string, sidecarPath: string): void => {
  const path = relative(resolve(dataRoot), resolve(sidecarPath));
  if (path === '' || (!path.startsWith(`..${sep}`) && path !== '..'))
    throw new Error('restore-archive-inside-active-data');
};
