import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { SqlClient } from '../store/database.js';

export interface SecretMetadata {
  readonly provider: string;
  readonly name: string;
  readonly exists: true;
  readonly fingerprint: string;
  readonly updatedAt: Date;
}

export const loadOrCreateSecretRoot = async (path: string): Promise<Buffer> => {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(absolute, 'wx', 0o600);
    try {
      await handle.writeFile(randomBytes(32));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const information = await lstat(absolute);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error('Secret root must be a regular non-symbolic file.');
  }
  await chmod(absolute, 0o600);
  const root = await readFile(absolute);
  if (root.byteLength !== 32) throw new Error('Secret root file must contain exactly 32 bytes.');
  return root;
};

export class SecretVault {
  readonly #rootKey: Buffer;
  readonly #keyVersion: number;

  constructor(rootKey: Uint8Array, keyVersion = 1) {
    if (rootKey.byteLength !== 32) throw new Error('Secret root must contain exactly 32 bytes.');
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1)
      throw new Error('Invalid key version.');
    this.#rootKey = Buffer.from(rootKey);
    this.#keyVersion = keyVersion;
  }

  fingerprint(secret: string): string {
    return createHmac('sha256', this.#rootKey).update(secret, 'utf8').digest('hex').slice(0, 16);
  }

  async store(
    database: SqlClient,
    provider: string,
    name: string,
    plaintext: string,
    updatedBy: number,
  ): Promise<SecretMetadata> {
    if (plaintext.length === 0) throw new Error('Secret cannot be empty.');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#rootKey, nonce);
    cipher.setAAD(Buffer.from(`${provider}\0${name}\0${this.#keyVersion}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const fingerprint = this.fingerprint(plaintext);
    const result = await database.query<{ updated_at: Date }>(
      `INSERT INTO noderag.encrypted_secret
         (provider, name, key_version, nonce, ciphertext, auth_tag, fingerprint, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (provider, name) DO UPDATE
       SET key_version = EXCLUDED.key_version, nonce = EXCLUDED.nonce,
           ciphertext = EXCLUDED.ciphertext, auth_tag = EXCLUDED.auth_tag,
           fingerprint = EXCLUDED.fingerprint, updated_at = now(),
           updated_by = EXCLUDED.updated_by
       RETURNING updated_at`,
      [provider, name, this.#keyVersion, nonce, ciphertext, authTag, fingerprint, updatedBy],
    );
    const updatedAt = result.rows[0]?.updated_at;
    if (updatedAt === undefined) throw new Error('Secret persistence returned no row.');
    return { provider, name, exists: true, fingerprint, updatedAt };
  }

  async reveal(database: SqlClient, provider: string, name: string): Promise<string | null> {
    const found = await database.query<{
      key_version: number;
      nonce: Buffer;
      ciphertext: Buffer;
      auth_tag: Buffer;
    }>(
      `SELECT key_version, nonce, ciphertext, auth_tag
       FROM noderag.encrypted_secret WHERE provider = $1 AND name = $2`,
      [provider, name],
    );
    const row = found.rows[0];
    if (row === undefined) return null;
    if (row.key_version !== this.#keyVersion) throw new Error('Unsupported secret key version.');
    const decipher = createDecipheriv('aes-256-gcm', this.#rootKey, row.nonce);
    decipher.setAAD(Buffer.from(`${provider}\0${name}\0${row.key_version}`, 'utf8'));
    decipher.setAuthTag(row.auth_tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  }

  matchesFingerprint(secret: string, fingerprint: string): boolean {
    const actual = Buffer.from(this.fingerprint(secret), 'utf8');
    const expected = Buffer.from(fingerprint, 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
