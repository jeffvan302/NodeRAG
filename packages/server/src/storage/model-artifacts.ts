import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

export const sha256File = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
};

export const modelDownloadHostAllowed = (
  hostname: string,
  allowedHosts: readonly string[],
): boolean =>
  allowedHosts.some(
    (allowed) => hostname === allowed || (allowed.startsWith('.') && hostname.endsWith(allowed)),
  );

const fetchWithAllowedRedirects = async (
  initial: URL,
  allowedHosts: readonly string[],
  headers: Record<string, string>,
  fetcher: typeof fetch,
): Promise<Response> => {
  let current = initial;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    if (
      current.protocol !== 'https:' ||
      !modelDownloadHostAllowed(current.hostname, allowedHosts)
    ) {
      throw new Error('model_download_url_forbidden');
    }
    const response = await fetcher(current, { redirect: 'manual', headers });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (location === null) throw new Error('model_download_redirect_invalid');
    if (redirect === 5) throw new Error('model_download_redirect_limit');
    current = new URL(location, current);
  }
  throw new Error('model_download_redirect_limit');
};

const safeName = (name: string): string => {
  const leaf = basename(name);
  if (leaf !== name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(leaf)) {
    throw new Error('model_artifact_name_invalid');
  }
  return leaf;
};

const contained = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

export interface ModelArtifactResult {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const importModelArtifact = async (options: {
  readonly sourcePath: string;
  readonly destinationRoot: string;
  readonly allowedRoots: readonly string[];
  readonly name: string;
  readonly expectedSha256: string;
}): Promise<ModelArtifactResult> => {
  const name = safeName(options.name);
  const source = await realpath(resolve(options.sourcePath));
  const allowed = await Promise.all(options.allowedRoots.map((root) => realpath(resolve(root))));
  if (!allowed.some((root) => contained(root, source)))
    throw new Error('model_import_source_forbidden');
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
    throw new Error('model_import_not_regular');
  await mkdir(options.destinationRoot, { recursive: true, mode: 0o700 });
  const destination = resolve(options.destinationRoot, name);
  const partial = `${destination}.partial`;
  await rm(partial, { force: true });
  await pipeline(
    createReadStream(source),
    createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
  );
  const actual = await sha256File(partial);
  if (actual !== options.expectedSha256.toLowerCase()) {
    await rm(partial, { force: true });
    throw new Error('model_checksum_mismatch');
  }
  await rename(partial, destination);
  return { name, bytes: sourceInfo.size, sha256: actual };
};

export const downloadModelArtifact = async (options: {
  readonly urls: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly destinationRoot: string;
  readonly name: string;
  readonly expectedSha256: string;
  readonly fetcher?: typeof fetch;
}): Promise<ModelArtifactResult> => {
  const name = safeName(options.name);
  await mkdir(options.destinationRoot, { recursive: true, mode: 0o700 });
  const destination = resolve(options.destinationRoot, name);
  const partial = `${destination}.partial`;
  let existing = 0;
  try {
    existing = (await lstat(partial)).size;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const fetcher = options.fetcher ?? fetch;
  let lastError: unknown = new Error('model_download_failed');
  for (const raw of options.urls) {
    try {
      const response = await fetchWithAllowedRedirects(
        new URL(raw),
        options.allowedHosts,
        existing > 0 ? { Range: `bytes=${String(existing)}-` } : {},
        fetcher,
      );
      if (!response.ok || response.body === null)
        throw new Error(`model_download_http_${response.status}`);
      const append = existing > 0 && response.status === 206;
      if (!append) {
        existing = 0;
        await rm(partial, { force: true });
      }
      await pipeline(
        response.body,
        createWriteStream(partial, { flags: append ? 'a' : 'wx', mode: 0o600 }),
      );
      const actual = await sha256File(partial);
      if (actual !== options.expectedSha256.toLowerCase())
        throw new Error('model_checksum_mismatch');
      await rename(partial, destination);
      return { name, bytes: (await lstat(destination)).size, sha256: actual };
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message === 'model_checksum_mismatch') {
        await rm(partial, { force: true });
        existing = 0;
      } else {
        existing = await lstat(partial)
          .then((info) => info.size)
          .catch(() => 0);
      }
    }
  }
  throw lastError;
};

export const readModelArtifact = async (root: string, name: string): Promise<Buffer> =>
  readFile(resolve(root, safeName(name)));
