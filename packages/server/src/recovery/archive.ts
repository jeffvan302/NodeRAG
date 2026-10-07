import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';

const archiveMagic = 'NODERAG-ARCHIVE-V1';
const archiveAad = Buffer.from('noderag:encrypted-recovery-archive:v1', 'utf8');
const maximumControlBytes = 256 * 1024;
const maximumChunkBytes = 64 * 1024 * 1024;

export type BackupProduct = 'full' | 'portable';
export type BackupDataClass =
  'source-of-truth' | 'behavioral-provenance' | 'derived' | 'secrets' | 'security-history';

export interface ArchiveEntrySource {
  readonly path: string;
  readonly class: BackupDataClass;
  readonly owner: string;
  readonly content: string | Uint8Array | AsyncIterable<Uint8Array>;
}

export interface ArchiveEntryManifest {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly class: BackupDataClass;
  readonly owner: string;
}

export interface BackupInnerManifest {
  readonly version: 1;
  readonly product: BackupProduct;
  readonly consistencyAt: string;
  readonly migrationHead: string;
  readonly postgresMajor: number;
  readonly nodeRagVersion?: string | undefined;
  readonly entries: readonly ArchiveEntryManifest[];
}

export interface BackupVolume {
  readonly index: number;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BackupSidecar {
  readonly version: 1;
  readonly product: BackupProduct;
  readonly createdAt: string;
  readonly archive: {
    readonly sha256: string;
    readonly bytes: number;
    readonly migrationHead: string;
    readonly postgresMajor: number;
    readonly nodeRagVersion?: string | undefined;
  };
  readonly encryption: {
    readonly algorithm: 'aes-256-gcm';
    readonly kdf: 'scrypt-v1';
    readonly salt: string;
    readonly nonce: string;
    readonly authTag: string;
    readonly keyFingerprint: string;
  };
  readonly volumes: readonly BackupVolume[];
}

const entryHeaderSchema = z
  .object({
    path: z.string().min(1).max(4096),
    class: z.enum([
      'source-of-truth',
      'behavioral-provenance',
      'derived',
      'secrets',
      'security-history',
    ]),
    owner: z.string().min(1).max(256),
  })
  .strict();

const entryFooterSchema = z
  .object({ bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();

const manifestEntrySchema = entryHeaderSchema.extend({
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const innerManifestSchema = z
  .object({
    version: z.literal(1),
    product: z.enum(['full', 'portable']),
    consistencyAt: z.string().datetime(),
    migrationHead: z.string().min(1),
    postgresMajor: z.number().int().positive(),
    nodeRagVersion: z.string().optional(),
    entries: z.array(manifestEntrySchema),
  })
  .strict();

const sidecarSchema = z
  .object({
    version: z.literal(1),
    product: z.enum(['full', 'portable']),
    createdAt: z.string().datetime(),
    archive: z
      .object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        bytes: z.number().int().positive(),
        migrationHead: z.string().min(1),
        postgresMajor: z.number().int().positive(),
        nodeRagVersion: z.string().optional(),
      })
      .strict(),
    encryption: z
      .object({
        algorithm: z.literal('aes-256-gcm'),
        kdf: z.literal('scrypt-v1'),
        salt: z.string().min(1),
        nonce: z.string().min(1),
        authTag: z.string().min(1),
        keyFingerprint: z.string().regex(/^[a-f0-9]{16}$/u),
      })
      .strict(),
    volumes: z.array(
      z
        .object({
          index: z.number().int().positive(),
          file: z.string().regex(/^[^/\\]+$/u),
          bytes: z.number().int().positive(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .strict(),
    ),
  })
  .strict();

const deriveKey = async (passphrase: string, salt: Uint8Array): Promise<Buffer> => {
  if (passphrase.length < 12) throw new Error('backup-passphrase-too-short');
  return new Promise((resolveKey, rejectKey) => {
    scrypt(
      passphrase,
      salt,
      32,
      { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error === null ? resolveKey(Buffer.from(key)) : rejectKey(error)),
    );
  });
};

const safeEntryPath = (path: string): string => {
  if (
    path.length === 0 ||
    path.length > 4096 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('unsafe-archive-entry-path');
  }
  if (!/^(database|documents|models|\.noderag-chat)\//u.test(path))
    throw new Error('unclassified-archive-entry-path');
  return path;
};

const asChunks = async function* (
  content: string | Uint8Array | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (typeof content === 'string') {
    yield Buffer.from(content, 'utf8');
    return;
  }
  if (content instanceof Uint8Array) {
    yield content;
    return;
  }
  for await (const chunk of content) yield chunk;
};

const control = (kind: 'ENTRY' | 'FOOTER' | 'MANIFEST', value: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.byteLength > maximumControlBytes) throw new Error('archive-control-record-too-large');
  return Buffer.concat([
    Buffer.from(`${kind} ${String(body.byteLength)}\n`, 'ascii'),
    body,
    Buffer.from('\n'),
  ]);
};

const uint32 = (value: number): Buffer => {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value);
  return buffer;
};

const plaintextArchive = async function* (
  entries: AsyncIterable<ArchiveEntrySource> | Iterable<ArchiveEntrySource>,
  identity: Omit<BackupInnerManifest, 'version' | 'entries'>,
): AsyncGenerator<Uint8Array> {
  yield Buffer.from(`${archiveMagic}\n`, 'ascii');
  const manifestEntries: ArchiveEntryManifest[] = [];
  const paths = new Set<string>();
  for await (const entry of entries) {
    const path = safeEntryPath(entry.path);
    if (paths.has(path)) throw new Error('duplicate-archive-entry-path');
    paths.add(path);
    const header = entryHeaderSchema.parse({ path, class: entry.class, owner: entry.owner });
    yield control('ENTRY', header);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const value of asChunks(entry.content)) {
      const chunk = Buffer.from(value);
      if (chunk.byteLength === 0) continue;
      for (let offset = 0; offset < chunk.byteLength; offset += maximumChunkBytes) {
        const part = chunk.subarray(offset, Math.min(chunk.byteLength, offset + maximumChunkBytes));
        yield uint32(part.byteLength);
        yield part;
        hash.update(part);
        bytes += part.byteLength;
      }
    }
    yield uint32(0);
    const footer = { bytes, sha256: hash.digest('hex') };
    yield control('FOOTER', footer);
    manifestEntries.push({ ...header, ...footer });
  }
  const manifest = innerManifestSchema.parse({ version: 1, ...identity, entries: manifestEntries });
  yield control('MANIFEST', manifest);
};

export interface WriteEncryptedArchiveOptions {
  readonly destinationDirectory: string;
  readonly baseName: string;
  readonly passphrase: string;
  readonly product: BackupProduct;
  readonly consistencyAt: string;
  readonly migrationHead: string;
  readonly postgresMajor: number;
  readonly nodeRagVersion?: string;
  readonly entries: AsyncIterable<ArchiveEntrySource> | Iterable<ArchiveEntrySource>;
  readonly volumeBytes?: number;
}

export const writeEncryptedArchive = async (
  options: WriteEncryptedArchiveOptions,
): Promise<{ readonly sidecarPath: string; readonly sidecar: BackupSidecar }> => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(options.baseName))
    throw new Error('invalid-archive-base-name');
  const volumeBytes = options.volumeBytes ?? 5 * 1024 ** 3;
  if (!Number.isSafeInteger(volumeBytes) || volumeBytes < 1024)
    throw new Error('invalid-backup-volume-size');
  const destination = resolve(options.destinationDirectory);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveKey(options.passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(archiveAad);
  const identity = {
    product: options.product,
    consistencyAt: options.consistencyAt,
    migrationHead: options.migrationHead,
    postgresMajor: options.postgresMajor,
    ...(options.nodeRagVersion === undefined ? {} : { nodeRagVersion: options.nodeRagVersion }),
  } satisfies Omit<BackupInnerManifest, 'version' | 'entries'>;
  const plaintext = Readable.from(plaintextArchive(options.entries, identity));
  cipher.on('error', () => undefined);
  plaintext.once('error', (error) => cipher.destroy(error));
  const encrypted = plaintext.pipe(cipher);
  const archiveHash = createHash('sha256');
  const volumes: BackupVolume[] = [];
  const created: string[] = [];
  let archiveBytes = 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let volumeHash = createHash('sha256');
  let volumeWritten = 0;
  let temporaryPath = '';
  let finalPath = '';
  let volumeIndex = 0;

  const startVolume = async (): Promise<void> => {
    volumeIndex += 1;
    const suffix = String(volumeIndex).padStart(4, '0');
    finalPath = join(destination, `${options.baseName}.nrag.${suffix}`);
    temporaryPath = `${finalPath}.partial`;
    handle = await open(temporaryPath, 'wx', 0o600);
    created.push(temporaryPath);
    volumeHash = createHash('sha256');
    volumeWritten = 0;
  };
  const finishVolume = async (): Promise<void> => {
    if (handle === undefined || volumeWritten === 0) return;
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, finalPath);
    created.push(finalPath);
    volumes.push({
      index: volumeIndex,
      file: basename(finalPath),
      bytes: volumeWritten,
      sha256: volumeHash.digest('hex'),
    });
  };

  try {
    await startVolume();
    for await (const value of encrypted) {
      const chunk = Buffer.from(value as Uint8Array);
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (handle === undefined) await startVolume();
        const take = Math.min(volumeBytes - volumeWritten, chunk.byteLength - offset);
        const part = chunk.subarray(offset, offset + take);
        await handle?.write(part);
        archiveHash.update(part);
        volumeHash.update(part);
        archiveBytes += part.byteLength;
        volumeWritten += part.byteLength;
        offset += take;
        if (volumeWritten === volumeBytes) await finishVolume();
      }
    }
    await finishVolume();
    if (volumes.length === 0) throw new Error('empty-backup-archive');
    const sidecar = sidecarSchema.parse({
      version: 1,
      product: options.product,
      createdAt: new Date().toISOString(),
      archive: {
        sha256: archiveHash.digest('hex'),
        bytes: archiveBytes,
        migrationHead: options.migrationHead,
        postgresMajor: options.postgresMajor,
        ...(options.nodeRagVersion === undefined ? {} : { nodeRagVersion: options.nodeRagVersion }),
      },
      encryption: {
        algorithm: 'aes-256-gcm',
        kdf: 'scrypt-v1',
        salt: salt.toString('base64'),
        nonce: nonce.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        keyFingerprint: createHash('sha256').update(key).digest('hex').slice(0, 16),
      },
      volumes,
    });
    const sidecarPath = join(destination, `${options.baseName}.sidecar.json`);
    const sidecarTemporary = `${sidecarPath}.partial`;
    await writeFile(sidecarTemporary, `${JSON.stringify(sidecar, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    created.push(sidecarTemporary);
    await rename(sidecarTemporary, sidecarPath);
    created.push(sidecarPath);
    key.fill(0);
    return { sidecarPath, sidecar };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    key.fill(0);
    for (const path of created.reverse()) await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
};

class ByteReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #buffer = Buffer.alloc(0);
  #ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async #fill(bytes: number): Promise<void> {
    while (this.#buffer.byteLength < bytes && !this.#ended) {
      const next = await this.#iterator.next();
      if (next.done) this.#ended = true;
      else this.#buffer = Buffer.concat([this.#buffer, Buffer.from(next.value)]);
    }
  }

  async read(bytes: number): Promise<Buffer> {
    await this.#fill(bytes);
    if (this.#buffer.byteLength < bytes) throw new Error('truncated-backup-archive');
    const value = this.#buffer.subarray(0, bytes);
    this.#buffer = this.#buffer.subarray(bytes);
    return value;
  }

  async line(): Promise<string> {
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline >= 0) return (await this.read(newline + 1)).subarray(0, newline).toString('utf8');
      if (this.#buffer.byteLength > maximumControlBytes)
        throw new Error('archive-control-record-too-large');
      const before = this.#buffer.byteLength;
      await this.#fill(before + 1);
      if (this.#buffer.byteLength === before && this.#ended)
        throw new Error('truncated-backup-archive');
    }
  }

  async eof(): Promise<boolean> {
    await this.#fill(1);
    return this.#ended && this.#buffer.byteLength === 0;
  }
}

const volumePaths = (sidecarPath: string, sidecar: BackupSidecar): readonly string[] => {
  const root = resolve(dirname(sidecarPath));
  const sorted = [...sidecar.volumes].sort((left, right) => left.index - right.index);
  if (sorted.some((volume, index) => volume.index !== index + 1))
    throw new Error('backup-volume-order-invalid');
  return sorted.map((volume) => {
    if (volume.file !== basename(volume.file)) throw new Error('unsafe-backup-volume-path');
    const path = resolve(root, volume.file);
    if (!path.startsWith(`${root}${sep}`)) throw new Error('unsafe-backup-volume-path');
    return path;
  });
};

const verifyEncryptedBytes = async (
  paths: readonly string[],
  sidecar: BackupSidecar,
): Promise<void> => {
  const whole = createHash('sha256');
  let wholeBytes = 0;
  for (const [index, path] of paths.entries()) {
    const expected = sidecar.volumes[index];
    if (expected === undefined) throw new Error('backup-volume-missing');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const value of createReadStream(path)) {
      const chunk = Buffer.from(value as Uint8Array);
      hash.update(chunk);
      whole.update(chunk);
      bytes += chunk.byteLength;
      wholeBytes += chunk.byteLength;
    }
    if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256)
      throw new Error(`backup-volume-digest-mismatch:${String(expected.index)}`);
  }
  if (wholeBytes !== sidecar.archive.bytes || whole.digest('hex') !== sidecar.archive.sha256)
    throw new Error('backup-archive-digest-mismatch');
};

const encryptedBytes = async function* (paths: readonly string[]): AsyncGenerator<Uint8Array> {
  for (const path of paths) for await (const chunk of createReadStream(path)) yield chunk as Buffer;
};

const readControl = async (reader: ByteReader, line: string, kind: string): Promise<unknown> => {
  const match = new RegExp(`^${kind} (\\d+)$`, 'u').exec(line);
  if (match === null) throw new Error(`invalid-${kind.toLowerCase()}-record`);
  const bytes = Number(match[1]);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maximumControlBytes)
    throw new Error('archive-control-record-too-large');
  const body = await reader.read(bytes);
  if ((await reader.read(1))[0] !== 0x0a) throw new Error('invalid-archive-control-terminator');
  return JSON.parse(body.toString('utf8')) as unknown;
};

export interface VerifiedArchive {
  readonly sidecar: BackupSidecar;
  readonly manifest: BackupInnerManifest;
  readonly entries: readonly ArchiveEntryManifest[];
}

export type ArchiveEntryConsumer = (
  header: Readonly<{ path: string; class: BackupDataClass; owner: string }>,
  content: AsyncIterable<Uint8Array>,
) => Promise<void>;

export const verifyEncryptedArchive = async (
  sidecarPath: string,
  passphrase: string,
  consume?: ArchiveEntryConsumer,
): Promise<VerifiedArchive> => {
  const sidecar = sidecarSchema.parse(
    JSON.parse(await readFile(resolve(sidecarPath), 'utf8')) as unknown,
  );
  const paths = volumePaths(sidecarPath, sidecar);
  await verifyEncryptedBytes(paths, sidecar);
  const salt = Buffer.from(sidecar.encryption.salt, 'base64');
  const key = await deriveKey(passphrase, salt);
  if (
    createHash('sha256').update(key).digest('hex').slice(0, 16) !==
    sidecar.encryption.keyFingerprint
  ) {
    key.fill(0);
    throw new Error('backup-passphrase-mismatch');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(sidecar.encryption.nonce, 'base64'),
  );
  decipher.setAAD(archiveAad);
  decipher.setAuthTag(Buffer.from(sidecar.encryption.authTag, 'base64'));
  const plaintext = Readable.from(encryptedBytes(paths)).pipe(decipher);
  const reader = new ByteReader(plaintext);
  const entries: ArchiveEntryManifest[] = [];
  const seen = new Set<string>();
  try {
    if ((await reader.line()) !== archiveMagic) throw new Error('unsupported-backup-archive');
    while (true) {
      const line = await reader.line();
      if (line.startsWith('MANIFEST ')) {
        const manifest = innerManifestSchema.parse(await readControl(reader, line, 'MANIFEST'));
        if (!(await reader.eof())) throw new Error('trailing-backup-archive-data');
        if (
          manifest.product !== sidecar.product ||
          manifest.migrationHead !== sidecar.archive.migrationHead ||
          manifest.postgresMajor !== sidecar.archive.postgresMajor ||
          manifest.nodeRagVersion !== sidecar.archive.nodeRagVersion
        )
          throw new Error('backup-sidecar-manifest-mismatch');
        if (JSON.stringify(manifest.entries) !== JSON.stringify(entries))
          throw new Error('backup-inner-manifest-mismatch');
        key.fill(0);
        return { sidecar, manifest, entries };
      }
      const header = entryHeaderSchema.parse(await readControl(reader, line, 'ENTRY'));
      safeEntryPath(header.path);
      if (seen.has(header.path)) throw new Error('duplicate-archive-entry-path');
      seen.add(header.path);
      const hash = createHash('sha256');
      let bytes = 0;
      let complete = false;
      const content = async function* (): AsyncGenerator<Uint8Array> {
        while (true) {
          const length = (await reader.read(4)).readUInt32BE();
          if (length === 0) {
            complete = true;
            return;
          }
          if (length > maximumChunkBytes) throw new Error('archive-chunk-too-large');
          const chunk = await reader.read(length);
          hash.update(chunk);
          bytes += chunk.byteLength;
          yield chunk;
        }
      };
      if (consume === undefined) for await (const _chunk of content()) void _chunk;
      else await consume(header, content());
      if (!complete) throw new Error('archive-entry-not-fully-consumed');
      const footerLine = await reader.line();
      const footer = entryFooterSchema.parse(await readControl(reader, footerLine, 'FOOTER'));
      if (footer.bytes !== bytes || footer.sha256 !== hash.digest('hex'))
        throw new Error(`backup-entry-digest-mismatch:${header.path}`);
      entries.push({ ...header, ...footer });
    }
  } catch (error) {
    key.fill(0);
    throw error;
  }
};
