import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  verifyEncryptedArchive,
  writeEncryptedArchive,
  type ArchiveEntrySource,
} from '../src/recovery/archive.js';
import {
  assertPortableValueSafe,
  includedTables,
  loadBackupClassification,
  preflightBackup,
  preflightRestoreCompatibility,
} from '../src/recovery/policy.js';
import {
  assertRestoreCapacity,
  assertRestorePathOutsideData,
  requiredRestoreCapacity,
} from '../src/recovery/restore.js';

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'noderag-recovery-'));
  roots.push(root);
  return root;
};

const entries = (): readonly ArchiveEntrySource[] => [
  {
    path: 'database/logical.dump',
    class: 'source-of-truth',
    owner: 'database:noderag',
    content: Buffer.from('typed logical database dump', 'utf8'),
  },
  {
    path: 'documents/000000/7/canonical.md',
    class: 'source-of-truth',
    owner: 'document:7',
    content: Buffer.alloc(3000, 0x5a),
  },
];

describe('encrypted recovery archives', () => {
  it('streams, splits, decrypts, and independently verifies every entry', async () => {
    const root = await temporaryRoot();
    const written = await writeEncryptedArchive({
      destinationDirectory: root,
      baseName: 'recovery-7',
      passphrase: 'correct horse battery staple',
      product: 'full',
      consistencyAt: '2026-09-04T12:00:00.000Z',
      migrationHead: '000018_research_page_references',
      postgresMajor: 17,
      nodeRagVersion: '0.2.0',
      entries: entries(),
      volumeBytes: 1024,
    });
    expect(written.sidecar.volumes.length).toBeGreaterThan(1);
    expect(written.sidecar.archive.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const restored = new Map<string, Buffer>();
    const verified = await verifyEncryptedArchive(
      written.sidecarPath,
      'correct horse battery staple',
      async (header, content) => {
        const chunks: Buffer[] = [];
        for await (const chunk of content) chunks.push(Buffer.from(chunk));
        restored.set(header.path, Buffer.concat(chunks));
      },
    );
    expect(verified.manifest.entries).toHaveLength(2);
    expect(restored.get('database/logical.dump')?.toString('utf8')).toBe(
      'typed logical database dump',
    );
    expect(restored.get('documents/000000/7/canonical.md')).toEqual(Buffer.alloc(3000, 0x5a));
  });

  it('rejects the wrong passphrase and tampered volume bytes before parsing', async () => {
    const root = await temporaryRoot();
    const written = await writeEncryptedArchive({
      destinationDirectory: root,
      baseName: 'tamper',
      passphrase: 'twelve characters minimum',
      product: 'portable',
      consistencyAt: '2026-09-04T12:00:00.000Z',
      migrationHead: '000018_research_page_references',
      postgresMajor: 17,
      entries: entries(),
    });
    await expect(
      verifyEncryptedArchive(written.sidecarPath, 'a different valid passphrase'),
    ).rejects.toThrow('backup-passphrase-mismatch');
    const volume = join(root, written.sidecar.volumes[0]?.file ?? 'missing');
    const bytes = await readFile(volume);
    const tamperIndex = Math.floor(bytes.length / 2);
    const original = bytes[tamperIndex];
    if (original === undefined) throw new Error('test volume unexpectedly empty');
    bytes[tamperIndex] = original ^ 0xff;
    await writeFile(volume, bytes);
    await expect(
      verifyEncryptedArchive(written.sidecarPath, 'twelve characters minimum'),
    ).rejects.toThrow('backup-volume-digest-mismatch');
  });

  it('rejects sidecar/inner-manifest drift and unsafe entry paths', async () => {
    const root = await temporaryRoot();
    await expect(
      writeEncryptedArchive({
        destinationDirectory: root,
        baseName: 'unsafe-path',
        passphrase: 'synthetic unsafe archive password',
        product: 'portable',
        consistencyAt: '2026-09-04T12:00:00.000Z',
        migrationHead: '000018_research_page_references',
        postgresMajor: 17,
        entries: [
          {
            path: '../escaped.txt',
            class: 'source-of-truth',
            owner: 'document:7',
            content: Buffer.from('blocked'),
          },
        ],
      }),
    ).rejects.toThrow('unsafe-archive-entry-path');
    const written = await writeEncryptedArchive({
      destinationDirectory: root,
      baseName: 'manifest-drift',
      passphrase: 'synthetic manifest drift password',
      product: 'full',
      consistencyAt: '2026-09-04T12:00:00.000Z',
      migrationHead: '000018_research_page_references',
      postgresMajor: 17,
      entries: entries(),
    });
    const sidecar = JSON.parse(await readFile(written.sidecarPath, 'utf8')) as {
      archive: { migrationHead: string };
    };
    sidecar.archive.migrationHead = '000012_untrusted_sidecar';
    await writeFile(written.sidecarPath, `${JSON.stringify(sidecar)}\n`, 'utf8');
    await expect(
      verifyEncryptedArchive(written.sidecarPath, 'synthetic manifest drift password'),
    ).rejects.toThrow('backup-sidecar-manifest-mismatch');
  });

  it('does not place passphrases or plaintext entry data in archive metadata', async () => {
    const root = await temporaryRoot();
    const passphrase = 'archive secret stays outside metadata';
    const written = await writeEncryptedArchive({
      destinationDirectory: root,
      baseName: 'metadata',
      passphrase,
      product: 'full',
      consistencyAt: '2026-09-04T12:00:00.000Z',
      migrationHead: '000018_research_page_references',
      postgresMajor: 17,
      entries: entries(),
    });
    const metadata = await readFile(written.sidecarPath, 'utf8');
    expect(metadata).not.toContain(passphrase);
    expect(metadata).not.toContain('typed logical database dump');
    expect(createHash('sha256').update(metadata).digest('hex')).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('propagates entry-source failure and removes partial archive volumes', async () => {
    const root = await temporaryRoot();
    const brokenEntries = async function* (): AsyncGenerator<ArchiveEntrySource> {
      yield {
        path: 'database/tables/document.ndjson',
        class: 'source-of-truth',
        owner: 'table:noderag.document',
        content: (async function* () {
          yield Buffer.from('{"id":1}\n', 'utf8');
          throw new Error('synthetic-entry-source-failed');
        })(),
      };
    };
    await expect(
      writeEncryptedArchive({
        destinationDirectory: root,
        baseName: 'broken-source',
        passphrase: 'synthetic broken archive passphrase',
        product: 'portable',
        consistencyAt: '2026-09-04T12:00:00.000Z',
        migrationHead: '000018_research_page_references',
        postgresMajor: 17,
        entries: brokenEntries(),
      }),
    ).rejects.toThrow('synthetic-entry-source-failed');
    expect(await readdir(root)).toEqual([]);
  });
});

describe('recovery policy', () => {
  it('classifies every declared table and keeps portable exports narrow', async () => {
    const policy = await loadBackupClassification();
    expect(policy.unknownPolicy).toBe('fail');
    const portable = includedTables(policy, 'portable').map((entry) => entry.table);
    expect(portable).toContain('document');
    expect(portable).toContain('model_manifest');
    expect(portable).not.toContain('research_collection');
    expect(portable).not.toContain('research_reference');
    expect(portable).not.toContain('encrypted_secret');
    expect(portable).not.toContain('session');
    expect(new Set(policy.tables.map((entry) => entry.table)).size).toBe(policy.tables.length);
  });

  it('fails portable verification on credentials and secret-shaped values', () => {
    expect(() => assertPortableValueSafe({ title: 'ordinary document' })).not.toThrow();
    expect(() => assertPortableValueSafe({ maximum_tokens: 1024 })).not.toThrow();
    expect(() => assertPortableValueSafe({ apiKey: 'not-even-a-real-key' })).toThrow(
      'portable-unclassified-secret-column',
    );
    expect(() =>
      assertPortableValueSafe({ value: 'postgres://user:secret@example.test/db' }),
    ).toThrow('portable-secret-shaped-value');
  });

  it('refuses incompatible archive, schema, database, and embedding dimensions', () => {
    const target = {
      supportedArchiveVersions: [1],
      migrationHead: '000018_research_page_references',
      postgresMajor: 17,
      modelDimensions: [1024],
    };
    expect(() =>
      preflightRestoreCompatibility(
        {
          archiveVersion: 1,
          migrationHead: target.migrationHead,
          postgresMajor: 17,
          modelDimensions: [1024],
        },
        target,
      ),
    ).not.toThrow();
    expect(() =>
      preflightRestoreCompatibility(
        {
          archiveVersion: 1,
          migrationHead: target.migrationHead,
          postgresMajor: 17,
          modelDimensions: [768],
        },
        target,
      ),
    ).toThrow('restore-model-dimensions-unsupported');
  });

  it('requires restore archives to remain outside active data roots', () => {
    expect(() =>
      assertRestorePathOutsideData('/srv/noderag/data', '/srv/backups/a.sidecar.json'),
    ).not.toThrow();
    expect(() =>
      assertRestorePathOutsideData('/srv/noderag/data', '/srv/noderag/data/backups/a.sidecar.json'),
    ).toThrow('restore-archive-inside-active-data');
  });

  it('enforces backup and restore capacity before any mutation', async () => {
    const root = await temporaryRoot();
    await expect(
      preflightBackup({
        destination: root,
        activeRoots: [],
        passphrase: 'synthetic capacity password',
        requiredFreeBytes: Number.MAX_SAFE_INTEGER,
        postgresClientMajor: 17,
        postgresServerMajor: 17,
      }),
    ).rejects.toThrow('backup-destination-insufficient-space');
    expect(
      requiredRestoreCapacity([
        { path: 'database/tables/document.ndjson', bytes: 500 },
        { path: 'documents/000000/7/canonical.md', bytes: 1000 },
        { path: 'models/model.onnx', bytes: 500 },
      ]),
    ).toBe(1800n);
    expect(() => assertRestoreCapacity(1799n, 1800n)).toThrow('restore-target-insufficient-space');
    expect(() => assertRestoreCapacity(1800n, 1800n)).not.toThrow();
  });
});
