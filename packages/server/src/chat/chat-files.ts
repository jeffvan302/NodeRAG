import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, open, realpath, rm } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import type { Pool } from 'pg';
import { databaseInteger, withTransaction } from '../store/database.js';
import { ChatArtifactService } from './artifacts.js';

export type ChatFileExtension = 'png' | 'jpg' | 'gif' | 'webp';

export class ChatFileError extends Error {
  constructor(
    readonly code:
      | 'chat_file_not_found'
      | 'chat_file_name_invalid'
      | 'chat_file_type_unsupported'
      | 'chat_file_signature_invalid'
      | 'chat_file_empty'
      | 'chat_file_too_large'
      | 'chat_file_quota_exceeded'
      | 'chat_file_storage_unsafe'
      | 'chat_file_storage_unavailable'
      | 'chat_file_disk_full',
    readonly status: 400 | 404 | 413 | 415 | 422 | 507,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'ChatFileError';
  }
}

interface ChatFileRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly original_filename: string;
  readonly extension: ChatFileExtension;
  readonly mime_type: string;
  readonly content_sha256: Buffer;
  readonly byte_length: unknown;
  readonly storage_relative_path: string;
  readonly state: 'active' | 'deleted';
  readonly created_by_principal_id: unknown;
  readonly created_at: Date;
  readonly deleted_at: Date | null;
}

export interface ChatFileMetadata {
  readonly originalFilename: string;
  readonly extension: ChatFileExtension;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

const contained = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const storageFailure = (error: unknown): never => {
  if (error instanceof ChatFileError) throw error;
  if (error instanceof Error && 'code' in error && error.code === 'ENOSPC') {
    throw new ChatFileError('chat_file_disk_full', 507, { cause: error });
  }
  throw new ChatFileError('chat_file_storage_unavailable', 507, { cause: error });
};

const signatureMatches = (extension: ChatFileExtension, bytes: Buffer): boolean => {
  if (extension === 'png') {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (extension === 'jpg') {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (extension === 'gif') {
    const signature = bytes.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
};

export const normalizeChatFileMetadata = (
  filename: string,
  suppliedMimeType: string,
  bytes: Buffer,
): ChatFileMetadata => {
  const originalFilename = filename.normalize('NFC').trim();
  if (
    originalFilename.length < 1 ||
    originalFilename.length > 255 ||
    basename(originalFilename) !== originalFilename ||
    originalFilename.includes('/') ||
    originalFilename.includes('\\') ||
    [...originalFilename].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new ChatFileError('chat_file_name_invalid', 400);
  }
  if (bytes.byteLength === 0) throw new ChatFileError('chat_file_empty', 400);
  const sourceExtension = extname(originalFilename).toLocaleLowerCase('en-US');
  const type =
    sourceExtension === '.png' && suppliedMimeType === 'image/png'
      ? ({ extension: 'png', mimeType: 'image/png' } as const)
      : ['.jpg', '.jpeg'].includes(sourceExtension) && suppliedMimeType === 'image/jpeg'
        ? ({ extension: 'jpg', mimeType: 'image/jpeg' } as const)
        : sourceExtension === '.gif' && suppliedMimeType === 'image/gif'
          ? ({ extension: 'gif', mimeType: 'image/gif' } as const)
          : sourceExtension === '.webp' && suppliedMimeType === 'image/webp'
            ? ({ extension: 'webp', mimeType: 'image/webp' } as const)
            : null;
  if (type === null) throw new ChatFileError('chat_file_type_unsupported', 415);
  if (!signatureMatches(type.extension, bytes)) {
    throw new ChatFileError('chat_file_signature_invalid', 415);
  }
  return { originalFilename, ...type };
};

const serialize = (row: ChatFileRow) => ({
  id: row.id,
  chatId: row.conversation_id,
  originalFilename: row.original_filename,
  extension: row.extension,
  mimeType: row.mime_type,
  sha256: row.content_sha256.toString('hex'),
  bytes: databaseInteger(row.byte_length, 'chat file byte length'),
  state: row.state,
  createdByPrincipalId: databaseInteger(row.created_by_principal_id, 'chat file principal id'),
  createdAt: row.created_at.toISOString(),
  deletedAt: row.deleted_at?.toISOString() ?? null,
  websitePath: `/chat/${row.conversation_id}/file/${row.id}.${row.extension}`,
});

const writeImmutable = async (path: string, content: Buffer): Promise<void> => {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600).catch(() => undefined);
};

export class ChatFileService {
  readonly #artifacts: ChatArtifactService;

  constructor(
    readonly pool: Pool,
    artifacts = new ChatArtifactService(pool),
  ) {
    this.#artifacts = artifacts;
  }

  async list(input: { conversationId: string; principalId: number }) {
    await this.#artifacts.storageContext(input);
    const result = await this.pool.query<ChatFileRow>(
      `SELECT * FROM noderag.chat_file
       WHERE conversation_id=$1 AND state='active'
       ORDER BY lower(original_filename),created_at,id`,
      [input.conversationId],
    );
    return { items: result.rows.map(serialize) };
  }

  async upload(input: {
    conversationId: string;
    principalId: number;
    filename: string;
    mimeType: string;
    content: Buffer;
  }) {
    const context = await this.#artifacts.storageContext(input);
    const metadata = normalizeChatFileMetadata(input.filename, input.mimeType, input.content);
    if (input.content.byteLength > context.maximumFileBytes) {
      throw new ChatFileError('chat_file_too_large', 413);
    }
    const id = randomUUID();
    const relativePath = `${id}.${metadata.extension}`;
    const destination = resolve(context.filesRoot, relativePath);
    if (!contained(context.filesRoot, destination)) {
      throw new ChatFileError('chat_file_storage_unsafe', 422);
    }
    const sha256 = createHash('sha256').update(input.content).digest();
    let created = false;
    try {
      return await withTransaction(this.pool, async (database) => {
        await database.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
          input.conversationId,
        ]);
        const usage = await database.query<{ bytes: unknown }>(
          `SELECT (
             COALESCE((SELECT sum(current_bytes) FROM noderag.chat_artifact
                       WHERE conversation_id=$1 AND state='active' AND artifact_kind='file'),0) +
             COALESCE((SELECT sum(byte_length) FROM noderag.chat_file
                       WHERE conversation_id=$1 AND state='active'),0)
           )::text AS bytes`,
          [input.conversationId],
        );
        const used = databaseInteger(usage.rows[0]?.bytes ?? 0, 'chat file quota used');
        if (used + input.content.byteLength > context.quotaBytes) {
          throw new ChatFileError('chat_file_quota_exceeded', 413);
        }
        await writeImmutable(destination, input.content);
        created = true;
        const inserted = await database.query<ChatFileRow>(
          `INSERT INTO noderag.chat_file
             (id,conversation_id,original_filename,extension,mime_type,content_sha256,
              byte_length,storage_relative_path,created_by_principal_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            id,
            input.conversationId,
            metadata.originalFilename,
            metadata.extension,
            metadata.mimeType,
            sha256,
            input.content.byteLength,
            relativePath,
            input.principalId,
          ],
        );
        return serialize(inserted.rows[0] as ChatFileRow);
      });
    } catch (error) {
      if (created) await rm(destination, { force: true }).catch(() => undefined);
      return storageFailure(error);
    }
  }

  async download(input: {
    conversationId: string;
    principalId: number;
    fileId: string;
    extension: string;
  }) {
    const context = await this.#artifacts.storageContext(input);
    const result = await this.pool.query<ChatFileRow>(
      `SELECT * FROM noderag.chat_file
       WHERE id=$1 AND conversation_id=$2 AND state='active'`,
      [input.fileId, input.conversationId],
    );
    const row = result.rows[0];
    if (row === undefined || row.extension !== input.extension) {
      throw new ChatFileError('chat_file_not_found', 404);
    }
    const expectedRelativePath = `${row.id}.${row.extension}`;
    if (row.storage_relative_path !== expectedRelativePath) {
      throw new ChatFileError('chat_file_storage_unsafe', 422);
    }
    const candidate = resolve(context.filesRoot, row.storage_relative_path);
    if (!contained(context.filesRoot, candidate)) {
      throw new ChatFileError('chat_file_storage_unsafe', 422);
    }
    try {
      const resolved = await realpath(candidate);
      if (!contained(context.filesRoot, resolved)) {
        throw new ChatFileError('chat_file_storage_unsafe', 422);
      }
      const information = await lstat(resolved);
      if (!information.isFile() || information.isSymbolicLink()) {
        throw new ChatFileError('chat_file_storage_unsafe', 422);
      }
      const handle = await open(resolved, 'r');
      let content: Buffer;
      try {
        content = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (
        content.byteLength !== databaseInteger(row.byte_length, 'chat file byte length') ||
        createHash('sha256').update(content).digest('hex') !== row.content_sha256.toString('hex')
      ) {
        throw new ChatFileError('chat_file_storage_unsafe', 422);
      }
      return { file: serialize(row), content };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new ChatFileError('chat_file_not_found', 404, { cause: error });
      }
      return storageFailure(error);
    }
  }

  async delete(input: { conversationId: string; principalId: number; fileId: string }) {
    const context = await this.#artifacts.storageContext(input);
    const row = await withTransaction(this.pool, async (database) => {
      const result = await database.query<ChatFileRow>(
        `SELECT * FROM noderag.chat_file
         WHERE id=$1 AND conversation_id=$2 AND state='active' FOR UPDATE`,
        [input.fileId, input.conversationId],
      );
      const current = result.rows[0];
      if (current === undefined) throw new ChatFileError('chat_file_not_found', 404);
      await database.query(
        `UPDATE noderag.chat_file SET state='deleted',deleted_at=now()
         WHERE id=$1 AND conversation_id=$2`,
        [input.fileId, input.conversationId],
      );
      return current;
    });
    const candidate = resolve(context.filesRoot, row.storage_relative_path);
    if (!contained(context.filesRoot, candidate)) {
      throw new ChatFileError('chat_file_storage_unsafe', 422);
    }
    await rm(candidate, { force: true }).catch(storageFailure);
    return { deleted: true, fileId: row.id };
  }
}
