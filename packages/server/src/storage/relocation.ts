import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { probeStorage, type StorageProbeOptions } from './probe.js';

interface ManifestEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface RelocationLifecycle {
  enterMaintenance(): Promise<void>;
  checkpoint(): Promise<void>;
  backup(): Promise<void>;
  stopDependentService(): Promise<void>;
  repoint(activePath: string, retainedPath: string): Promise<void>;
  restartDependentService(): Promise<void>;
  integrityCheck(activePath: string): Promise<void>;
  rollback?(restoredPath: string, failedCopyPath: string): Promise<void>;
  leaveMaintenance(): Promise<void>;
}

const hashFile = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
};

const manifest = async (root: string): Promise<readonly ManifestEntry[]> => {
  const entries: ManifestEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, item.name);
      if (item.isSymbolicLink()) throw new Error('relocation_symlink_forbidden');
      if (item.isDirectory()) await visit(path);
      else if (item.isFile()) {
        const info = await lstat(path);
        entries.push({
          path: relative(root, path).split(sep).join('/'),
          bytes: info.size,
          sha256: await hashFile(path),
        });
      }
    }
  };
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
};

export const relocateStorage = async (options: {
  readonly source: string;
  readonly destinationParent: string;
  readonly name: string;
  readonly probe?: StorageProbeOptions;
  readonly lifecycle?: RelocationLifecycle;
}): Promise<{
  readonly activePath: string;
  readonly retainedPath: string;
  readonly manifest: readonly ManifestEntry[];
}> => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(options.name))
    throw new Error('relocation_name_invalid');
  const source = resolve(options.source);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())
    throw new Error('relocation_source_invalid');
  await options.lifecycle?.enterMaintenance();
  const destination = resolve(options.destinationParent, options.name);
  const staging = `${destination}.copying-${randomUUID()}`;
  const retained = `${source}.retained-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  const lockPath = resolve(options.destinationParent, '.noderag-relocation.lock');
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let activated = false;
  try {
    await probeStorage(options.destinationParent, options.probe);
    lock = await open(lockPath, 'wx', 0o600);
    await options.lifecycle?.checkpoint();
    await options.lifecycle?.backup();
    await mkdir(staging, { recursive: false, mode: 0o700 });
    await cp(source, staging, { recursive: true, force: false, errorOnExist: true });
    const [before, after] = await Promise.all([manifest(source), manifest(staging)]);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error('relocation_manifest_mismatch');
    await options.lifecycle?.stopDependentService();
    await rename(source, retained);
    try {
      await rename(staging, destination);
    } catch (error) {
      await rename(retained, source);
      throw error;
    }
    activated = true;
    await options.lifecycle?.repoint(destination, retained);
    await options.lifecycle?.restartDependentService();
    await options.lifecycle?.integrityCheck(destination);
    return { activePath: destination, retainedPath: retained, manifest: after };
  } catch (error) {
    if (activated) {
      const failed = `${destination}.failed-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
      await rename(destination, failed);
      await rename(retained, source);
      await options.lifecycle?.rollback?.(source, failed);
    }
    throw error;
  } finally {
    await lock?.close();
    await rm(lockPath, { force: true });
    await rm(staging, { recursive: true, force: true });
    await options.lifecycle?.leaveMaintenance();
  }
};
