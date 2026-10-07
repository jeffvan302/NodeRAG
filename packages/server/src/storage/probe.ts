import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

const gibibyte = 1024n * 1024n * 1024n;
const supportedMagic = new Map<bigint, string>([
  [0xef53n, 'ext4'],
  [0x9123683en, 'btrfs'],
]);

export interface StorageProbeOptions {
  readonly policy?: 'dsm' | 'testbed';
  readonly protectExistingDirectory?: boolean;
  readonly projectedBytes?: bigint;
  readonly rebuildReserveBytes?: bigint;
  readonly encryptedRoots?: readonly string[];
  readonly requireEncrypted?: boolean;
  readonly syncRoots?: readonly string[];
  readonly indexingRoots?: readonly string[];
}

const probeProblemCodes = new Set([
  'storage_capacity_insufficient',
  'storage_encryption_required',
  'storage_filesystem_unsupported',
  'storage_managed_subdirectory_invalid',
  'storage_path_must_be_absolute',
  'storage_path_must_be_under_volume',
  'storage_path_not_directory',
  'storage_read_after_fsync_failed',
]);

export const storageProbeProblemCode = (error: unknown): string => {
  if (error instanceof Error && probeProblemCodes.has(error.message)) return error.message;
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (['EACCES', 'EPERM', 'EROFS'].includes(code)) return 'storage_permission_denied';
  if (['EDQUOT', 'ENOSPC'].includes(code)) return 'storage_capacity_insufficient';
  if (['EEXIST', 'ENOTDIR'].includes(code)) return 'storage_path_not_directory';
  return 'storage_probe_failed';
};

const existingPath = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
};

const contains = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const roots = (values: readonly string[] = []): readonly string[] =>
  values.map((value) => resolve(value));

export const probeStorage = async (managedPath: string, options: StorageProbeOptions = {}) => {
  if (!isAbsolute(managedPath)) throw new Error('storage_path_must_be_absolute');
  const requested = resolve(managedPath);
  const existing = await existingPath(requested);
  if (existing !== null && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error('storage_path_not_directory');
  }
  if (existing === null) await mkdir(requested, { recursive: true, mode: 0o700 });
  const selectedPath = await realpath(requested);
  if (options.policy === 'dsm' && !/^\/volume[1-9][0-9]*(?:\/|$)/u.test(selectedPath)) {
    throw new Error('storage_path_must_be_under_volume');
  }
  const protectExistingDirectory = options.protectExistingDirectory ?? options.policy === 'dsm';
  const useManagedSubdirectory =
    protectExistingDirectory && existing !== null && basename(selectedPath) !== '.noderag-managed';
  let target = selectedPath;
  if (useManagedSubdirectory) {
    const child = resolve(selectedPath, '.noderag-managed');
    const childBefore = await existingPath(child);
    if (childBefore !== null && (!childBefore.isDirectory() || childBefore.isSymbolicLink())) {
      throw new Error('storage_managed_subdirectory_invalid');
    }
    if (childBefore === null) await mkdir(child, { mode: 0o700 });
    target = await realpath(child);
  }
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('storage_path_not_directory');
  if (existing === null || useManagedSubdirectory || basename(target) === '.noderag-managed') {
    await chmod(target, 0o700);
  }
  const mode = (await lstat(target)).mode & 0o777;

  const probe = resolve(target, `.noderag-storage-probe-${randomUUID()}`);
  const renamed = `${probe}.verified`;
  const payload = `NodeRag storage probe ${randomUUID()}\n`;
  const handle = await open(probe, 'wx', 0o600);
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(probe, renamed);
  const readBack = await readFile(renamed, 'utf8');
  await rm(renamed, { force: true });
  if (readBack !== payload) throw new Error('storage_read_after_fsync_failed');

  const capacity = await statfs(target, { bigint: true });
  const availableBytes = capacity.bavail * capacity.bsize;
  const totalBytes = capacity.blocks * capacity.bsize;
  const filesystem =
    supportedMagic.get(capacity.type) ?? `unsupported-0x${capacity.type.toString(16)}`;
  if (options.policy === 'dsm' && !supportedMagic.has(capacity.type)) {
    throw new Error('storage_filesystem_unsupported');
  }
  const projectedBytes = options.projectedBytes ?? 0n;
  const rebuildReserveBytes = options.rebuildReserveBytes ?? 10n * gibibyte;
  if (availableBytes < projectedBytes + rebuildReserveBytes) {
    throw new Error('storage_capacity_insufficient');
  }
  const encrypted = roots(options.encryptedRoots).some((root) => contains(root, target));
  if (options.requireEncrypted === true && !encrypted)
    throw new Error('storage_encryption_required');
  const warnings = [
    ...(useManagedSubdirectory ? ['managed-subdirectory-created'] : []),
    ...(mode === 0o700 || mode === 0o750 ? [] : ['posix-mode-not-enforced']),
    ...(roots(options.syncRoots).some((root) => contains(root, target))
      ? ['synology-drive-sync-root']
      : []),
    ...(roots(options.indexingRoots).some((root) => contains(root, target))
      ? ['synology-indexing-root']
      : []),
  ];
  return {
    requestedPath: managedPath,
    selectedPath,
    resolvedPath: target,
    managedPath: target,
    managedSubdirectory: useManagedSubdirectory,
    filesystem,
    encrypted,
    mode: mode.toString(8).padStart(4, '0'),
    writable: true,
    fsyncVerified: true,
    availableBytes: availableBytes.toString(),
    totalBytes: totalBytes.toString(),
    projectedBytes: projectedBytes.toString(),
    rebuildReserveBytes: rebuildReserveBytes.toString(),
    lowCapacity: availableBytes < 10n * gibibyte,
    warnings,
    parent: dirname(target),
  };
};
