import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { probeStorage, type StorageProbeOptions } from '../storage/probe.js';

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('noderag-chat-store'),
    manifestId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

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

export interface ChatStorageProbeOptions extends StorageProbeOptions {
  readonly now?: () => Date;
  readonly manifestId?: () => string;
}

export const probeChatStorage = async (
  requestedPath: string,
  options: ChatStorageProbeOptions = {},
) => {
  const probe = await probeStorage(requestedPath, {
    ...options,
    protectExistingDirectory: false,
  });
  const root = await realpath(probe.managedPath);
  const requestedChatRoot = resolve(root, '.noderag-chat');
  if (!contains(root, requestedChatRoot)) throw new Error('chat_storage_containment_failed');
  const before = await existingPath(requestedChatRoot);
  if (before !== null && (!before.isDirectory() || before.isSymbolicLink())) {
    throw new Error('chat_storage_path_invalid');
  }
  if (before === null) await mkdir(requestedChatRoot, { mode: 0o700 });
  const chatRoot = await realpath(requestedChatRoot);
  if (!contains(root, chatRoot)) throw new Error('chat_storage_containment_failed');
  const information = await lstat(chatRoot);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error('chat_storage_path_invalid');
  }
  await chmod(chatRoot, 0o700);

  const manifestPath = resolve(chatRoot, 'manifest.json');
  const manifestBefore = await existingPath(manifestPath);
  if (manifestBefore !== null) {
    if (!manifestBefore.isFile() || manifestBefore.isSymbolicLink()) {
      throw new Error('chat_storage_manifest_invalid');
    }
    let manifest: z.infer<typeof manifestSchema>;
    try {
      manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    } catch {
      throw new Error('chat_storage_manifest_invalid');
    }
    return { ...probe, chatRoot, manifestPath, manifest, initialized: false };
  }

  const manifest = manifestSchema.parse({
    schemaVersion: 1,
    kind: 'noderag-chat-store',
    manifestId: options.manifestId?.() ?? randomUUID(),
    createdAt: (options.now?.() ?? new Date()).toISOString(),
  });
  const temporaryPath = resolve(chatRoot, `.manifest-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, manifestPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  } finally {
    await rm(temporaryPath, { force: true });
  }
  let persisted: z.infer<typeof manifestSchema>;
  try {
    persisted = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  } catch {
    throw new Error('chat_storage_manifest_invalid');
  }
  return { ...probe, chatRoot, manifestPath, manifest: persisted, initialized: true };
};
