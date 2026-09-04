import unzipper, { type File as ZipEntry } from 'unzipper';
import type { Readable } from 'node:stream';
import type { ExtractionOptions } from './contract.js';

export interface OfficeArchive {
  readonly entries: ReadonlyMap<string, ZipEntry>;
  read(path: string): Promise<Buffer>;
  stream(path: string): Readable;
  text(path: string): Promise<string>;
}

const safeArchivePath = (path: string): boolean =>
  !path.startsWith('/') &&
  !path.startsWith('\\') &&
  !/^[a-z]:/iu.test(path) &&
  !path.split('/').includes('..') &&
  !path.includes('\0');

export const openOfficeArchive = async (
  bytes: Uint8Array,
  options: ExtractionOptions = {},
): Promise<OfficeArchive> => {
  const directory = await unzipper.Open.buffer(Buffer.from(bytes));
  const maximumEntries = options.maximumZipEntries ?? 20_000;
  const maximumUncompressed = options.maximumUncompressedBytes ?? 1024 * 1024 * 1024;
  if (directory.files.length > maximumEntries) throw new Error('office-archive-entry-limit');
  let uncompressed = 0;
  const entries = new Map<string, ZipEntry>();
  for (const entry of directory.files) {
    if (!safeArchivePath(entry.path)) throw new Error('unsafe-office-archive-path');
    if ((entry.flags & 1) !== 0) throw new Error('encrypted-office-archive-unsupported');
    uncompressed += entry.uncompressedSize;
    if (uncompressed > maximumUncompressed) throw new Error('office-archive-size-limit');
    if (entry.compressedSize > 0 && entry.uncompressedSize > 10 * 1024 * 1024) {
      if (entry.uncompressedSize / entry.compressedSize > 1000) {
        throw new Error('office-archive-compression-ratio-limit');
      }
    }
    if (entry.type === 'File') entries.set(entry.path.replaceAll('\\', '/'), entry);
  }
  const read = async (path: string): Promise<Buffer> => {
    const entry = entries.get(path);
    if (entry === undefined) throw new Error(`office-entry-missing:${path}`);
    return entry.buffer();
  };
  return {
    entries,
    read,
    stream: (path: string) => {
      const entry = entries.get(path);
      if (entry === undefined) throw new Error(`office-entry-missing:${path}`);
      return entry.stream();
    },
    text: async (path: string) => (await read(path)).toString('utf8'),
  };
};
