import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, statfs } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

export interface StagedUpload {
  readonly temporaryPath: string;
  readonly bytes: number;
  readonly sha256: Buffer;
}

export interface ManagedDocumentPaths {
  readonly originalAbsolute: string;
  readonly originalRelative: string;
  readonly markdownAbsolute: string;
  readonly markdownRelative: string;
}

const fsyncDirectory = async (path: string): Promise<void> => {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
};

export class DocumentFileStore {
  readonly root: string;
  private readonly temporaryRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.temporaryRoot = join(this.root, 'tmp');
  }

  async initialize(): Promise<void> {
    await mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
  }

  paths(documentId: number, extension = 'md'): ManagedDocumentPaths {
    if (!Number.isSafeInteger(documentId) || documentId < 1)
      throw new Error('Invalid document id.');
    if (!/^[a-z0-9]{1,8}$/u.test(extension)) throw new Error('Invalid managed extension.');
    const bucket = String(Math.floor(documentId / 1000)).padStart(6, '0');
    const directory = join(this.root, 'documents', bucket, String(documentId));
    const originalAbsolute = join(directory, `original.${extension}`);
    const markdownAbsolute = join(directory, 'canonical.md');
    const asRelative = (absolute: string): string => {
      const value = relative(this.root, absolute);
      if (value.startsWith('..') || value.includes(`${sep}..${sep}`)) {
        throw new Error('Managed document path escaped its root.');
      }
      return value.split(sep).join('/');
    };
    return {
      originalAbsolute,
      originalRelative: asRelative(originalAbsolute),
      markdownAbsolute,
      markdownRelative: asRelative(markdownAbsolute),
    };
  }

  async stageUpload(
    stream: Readable,
    maximumBytes: number,
    minimumFreeBytes: number,
  ): Promise<StagedUpload> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error('Invalid upload size limit.');
    }
    await this.initialize();
    const space = await statfs(this.root, { bigint: true });
    const available = space.bavail * space.bsize;
    if (available < BigInt(maximumBytes + minimumFreeBytes))
      throw new Error('insufficient-disk-space');
    const temporaryPath = join(this.temporaryRoot, `${randomUUID()}.upload`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    let bytes = 0;
    const hash = createHash('sha256');
    try {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        bytes += chunk.byteLength;
        if (bytes > maximumBytes) throw new Error('upload-too-large');
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (bytes === 0) throw new Error('empty-upload');
      await handle.sync();
      return { temporaryPath, bytes, sha256: hash.digest() };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
  }

  async promoteOriginal(
    staged: StagedUpload,
    documentId: number,
    extension: string,
  ): Promise<ManagedDocumentPaths> {
    const paths = this.paths(documentId, extension);
    await mkdir(dirname(paths.originalAbsolute), { recursive: true, mode: 0o700 });
    await rename(staged.temporaryPath, paths.originalAbsolute);
    await fsyncDirectory(dirname(paths.originalAbsolute));
    return paths;
  }

  async writeCanonicalMarkdown(
    documentId: number,
    markdown: string,
  ): Promise<{ bytes: number; sha256: Buffer }> {
    const paths = this.paths(documentId);
    await mkdir(dirname(paths.markdownAbsolute), { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      dirname(paths.markdownAbsolute),
      `.${basename(paths.markdownAbsolute)}.${randomUUID()}.tmp`,
    );
    const encoded = Buffer.from(markdown, 'utf8');
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.write(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, paths.markdownAbsolute);
    await fsyncDirectory(dirname(paths.markdownAbsolute));
    return { bytes: encoded.byteLength, sha256: createHash('sha256').update(encoded).digest() };
  }

  openOriginal(documentId: number, extension: string) {
    return createReadStream(this.paths(documentId, extension).originalAbsolute);
  }
}

export const validatedMarkdownMetadata = (
  filename: string,
  mimeType: string,
): { readonly name: string; readonly extension: 'md'; readonly mimeType: string } => {
  if (filename !== basename(filename) || filename.includes('\0'))
    throw new Error('invalid-filename');
  if (extname(filename).toLowerCase() !== '.md') throw new Error('unsupported-extension');
  const normalizedMime = mimeType.split(';', 1)[0]?.trim().toLowerCase();
  if (normalizedMime !== 'text/markdown' && normalizedMime !== 'text/plain') {
    throw new Error('unsupported-mime-type');
  }
  return { name: filename, extension: 'md', mimeType: normalizedMime };
};
