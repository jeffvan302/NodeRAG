import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import * as unzipper from 'unzipper';
import type { DocumentFormat } from '../extract/contract.js';

export interface StagedUpload {
  readonly temporaryPath: string;
  readonly bytes: number;
  readonly sha256: Buffer;
}

export interface ManagedDocumentPaths {
  readonly directoryAbsolute: string;
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
      directoryAbsolute: directory,
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

  async replaceOriginal(
    staged: StagedUpload,
    documentId: number,
    extension: string,
  ): Promise<ManagedDocumentPaths> {
    const paths = this.paths(documentId, extension);
    await mkdir(dirname(paths.originalAbsolute), { recursive: true, mode: 0o700 });
    const previousPath = `${paths.originalAbsolute}.${randomUUID()}.previous`;
    let previousMoved = false;
    try {
      await rename(paths.originalAbsolute, previousPath);
      previousMoved = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    try {
      await rename(staged.temporaryPath, paths.originalAbsolute);
      await fsyncDirectory(dirname(paths.originalAbsolute));
      if (previousMoved) await rm(previousPath, { force: true });
      return paths;
    } catch (error) {
      if (previousMoved) await rename(previousPath, paths.originalAbsolute);
      throw error;
    }
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

  async writeExtractedImage(
    documentId: number,
    imageId: string,
    sequence: number,
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<string> {
    if (!/^[a-f0-9]{64}$/u.test(imageId)) throw new Error('Invalid managed image id.');
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error('Invalid managed image sequence.');
    }
    const extensions: Readonly<Record<string, string>> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
    };
    const extension = extensions[mediaType];
    if (extension === undefined) throw new Error('Unsupported managed image media type.');
    const documentDirectory = this.paths(documentId).directoryAbsolute;
    const imageDirectory = join(documentDirectory, 'images');
    const absolute = join(
      imageDirectory,
      `${String(sequence).padStart(5, '0')}-${imageId}.${extension}`,
    );
    await mkdir(imageDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${absolute}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, absolute);
    await fsyncDirectory(imageDirectory);
    const managed = relative(this.root, absolute);
    if (managed.startsWith('..') || managed.includes(`${sep}..${sep}`)) {
      throw new Error('Managed image path escaped its root.');
    }
    return managed.split(sep).join('/');
  }

  async resetExtractedImages(documentId: number): Promise<void> {
    const documentDirectory = this.paths(documentId).directoryAbsolute;
    const imageDirectory = join(documentDirectory, 'images');
    if (!imageDirectory.startsWith(`${documentDirectory}${sep}`)) {
      throw new Error('Refusing to reset images outside the managed document directory.');
    }
    await rm(imageDirectory, { recursive: true, force: true });
  }

  openOriginal(documentId: number, extension: string) {
    return createReadStream(this.paths(documentId, extension).originalAbsolute);
  }

  async removeDocument(documentId: number): Promise<void> {
    const directory = this.paths(documentId).directoryAbsolute;
    const expectedRoot = join(this.root, 'documents');
    if (!directory.startsWith(`${expectedRoot}${sep}`)) {
      throw new Error('Refusing to remove a document outside the managed root.');
    }
    await rm(directory, { recursive: true, force: true });
    await fsyncDirectory(dirname(directory));
  }

  async managedDocumentIds(): Promise<readonly number[]> {
    const documentsRoot = join(this.root, 'documents');
    const ids = new Set<number>();
    let buckets;
    try {
      buckets = await readdir(documentsRoot, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    for (const bucket of buckets) {
      if (!bucket.isDirectory() || !/^\d{6}$/u.test(bucket.name)) continue;
      const entries = await readdir(join(documentsRoot, bucket.name), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
        const id = Number(entry.name);
        if (Number.isSafeInteger(id) && id > 0) ids.add(id);
      }
    }
    return [...ids].sort((left, right) => left - right);
  }
}

const acceptedMimeTypes: Readonly<Record<DocumentFormat, readonly string[]>> = {
  md: ['text/markdown', 'text/plain'],
  txt: ['text/plain'],
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};

export interface ValidatedDocumentMetadata {
  readonly name: string;
  readonly extension: DocumentFormat;
  readonly mimeType: string;
}

export const validatedDocumentMetadata = (
  filename: string,
  mimeType: string,
): ValidatedDocumentMetadata => {
  if (filename !== basename(filename) || filename.includes('\0'))
    throw new Error('invalid-filename');
  const extension = extname(filename).toLowerCase().slice(1) as DocumentFormat;
  if (!(extension in acceptedMimeTypes)) throw new Error('unsupported-extension');
  const normalizedMime = mimeType.split(';', 1)[0]?.trim().toLowerCase();
  if (normalizedMime === undefined || !acceptedMimeTypes[extension].includes(normalizedMime)) {
    throw new Error('unsupported-mime-type');
  }
  return { name: filename, extension, mimeType: normalizedMime };
};

export const validatedMarkdownMetadata = (
  filename: string,
  mimeType: string,
): ValidatedDocumentMetadata => {
  const metadata = validatedDocumentMetadata(filename, mimeType);
  if (metadata.extension !== 'md') throw new Error('unsupported-extension');
  return metadata;
};

export const validateStagedDocumentSignature = async (
  staged: StagedUpload,
  format: DocumentFormat,
): Promise<void> => {
  if (format === 'txt' || format === 'md') return;
  const handle = await open(staged.temporaryPath, 'r');
  const signature = Buffer.alloc(8);
  try {
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    const prefix = signature.subarray(0, bytesRead);
    if (format === 'pdf') {
      if (!prefix.subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii'))) {
        throw new Error('document-signature-mismatch');
      }
      return;
    }
    if (prefix[0] !== 0x50 || prefix[1] !== 0x4b) throw new Error('document-signature-mismatch');
  } finally {
    await handle.close();
  }
  const archive = await unzipper.Open.file(staged.temporaryPath);
  const paths = new Set(archive.files.map((entry) => entry.path.replaceAll('\\', '/')));
  const expected = format === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
  if (!paths.has('[Content_Types].xml') || !paths.has(expected)) {
    throw new Error('document-package-mismatch');
  }
};
