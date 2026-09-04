import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { downloadModelArtifact, importModelArtifact } from '../src/storage/model-artifacts.js';
import { probeStorage } from '../src/storage/probe.js';
import { relocateStorage } from '../src/storage/relocation.js';
import { recentStructuredErrors } from '../src/api/durability-routes.js';

describe('M10 storage and model lifecycle', () => {
  it('probes a testbed path with durable write/read and capacity evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-storage-'));
    const result = await probeStorage(join(root, 'managed'), {
      policy: 'testbed',
      rebuildReserveBytes: 0n,
    });
    expect(result.writable).toBe(true);
    expect(result.fsyncVerified).toBe(true);
    expect(result.mode).toMatch(/^0[0-7]{3}$/);
    expect(BigInt(result.availableBytes)).toBeGreaterThan(0n);
  });

  it('imports a model only from an allowed root and verifies SHA before rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-model-'));
    const incoming = join(root, 'incoming');
    const destination = join(root, 'models');
    await mkdir(incoming);
    const bytes = Buffer.from('model-test-artifact');
    const source = join(incoming, 'model.onnx');
    await writeFile(source, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await expect(
      importModelArtifact({
        sourcePath: source,
        destinationRoot: destination,
        allowedRoots: [incoming],
        name: 'model.onnx',
        expectedSha256: sha256,
      }),
    ).resolves.toEqual({ name: 'model.onnx', bytes: bytes.length, sha256 });
    expect(await readFile(join(destination, 'model.onnx'))).toEqual(bytes);
  });

  it('resumes a checksummed HTTPS model download from its partial file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-download-'));
    const bytes = Buffer.from('resumable-model-artifact');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(root, 'model.onnx.partial'), bytes.subarray(0, 9));
    const fetcher = async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['Range']).toBe('bytes=9-');
      return new Response(bytes.subarray(9), { status: 206 });
    };
    await expect(
      downloadModelArtifact({
        urls: ['https://models.example.test/model.onnx'],
        allowedHosts: ['models.example.test'],
        destinationRoot: root,
        name: 'model.onnx',
        expectedSha256: sha256,
        fetcher: fetcher as typeof fetch,
      }),
    ).resolves.toEqual({ name: 'model.onnx', bytes: bytes.length, sha256 });
    expect(await readFile(join(root, 'model.onnx'))).toEqual(bytes);
  });

  it('copies, verifies, activates, and retains the old tree during relocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-relocate-'));
    const source = join(root, 'documents');
    const destinationParent = join(root, 'volume');
    await mkdir(source);
    await writeFile(join(source, 'canonical.md'), '# retained\n');
    const lifecycle: string[] = [];
    const result = await relocateStorage({
      source,
      destinationParent,
      name: 'documents-active',
      probe: { policy: 'testbed', rebuildReserveBytes: 0n },
      lifecycle: {
        enterMaintenance: async () => void lifecycle.push('maintenance'),
        checkpoint: async () => void lifecycle.push('checkpoint'),
        backup: async () => void lifecycle.push('backup'),
        stopDependentService: async () => void lifecycle.push('stop'),
        repoint: async () => void lifecycle.push('repoint'),
        restartDependentService: async () => void lifecycle.push('restart'),
        integrityCheck: async () => void lifecycle.push('integrity'),
        leaveMaintenance: async () => void lifecycle.push('leave'),
      },
    });
    expect(await readFile(join(result.activePath, 'canonical.md'), 'utf8')).toBe('# retained\n');
    expect(await readFile(join(result.retainedPath, 'canonical.md'), 'utf8')).toBe('# retained\n');
    expect(result.manifest).toHaveLength(1);
    expect(lifecycle).toEqual([
      'maintenance',
      'checkpoint',
      'backup',
      'stop',
      'repoint',
      'restart',
      'integrity',
      'leave',
    ]);
  });

  it('exposes only allowlisted structured error fields from package logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-logs-'));
    await writeFile(
      join(root, 'worker.log'),
      `${JSON.stringify({ level: 50, time: 42, errorName: 'Error', code: 'worker_failed', msg: 'document body and token_secret' })}\n`,
    );
    await expect(recentStructuredErrors(root)).resolves.toEqual([
      { service: 'worker', time: 42, level: 50, code: 'worker_failed', errorName: 'Error' },
    ]);
  });

  it('restores the source and releases maintenance when post-activation integrity fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-rollback-'));
    const source = join(root, 'cache');
    const destinationParent = join(root, 'volume');
    await mkdir(source);
    await writeFile(join(source, 'entry.bin'), 'cache');
    const events: string[] = [];
    await expect(
      relocateStorage({
        source,
        destinationParent,
        name: 'cache-active',
        probe: { policy: 'testbed', rebuildReserveBytes: 0n },
        lifecycle: {
          enterMaintenance: async () => void events.push('maintenance'),
          checkpoint: async () => void 0,
          backup: async () => void 0,
          stopDependentService: async () => void 0,
          repoint: async () => void 0,
          restartDependentService: async () => void 0,
          integrityCheck: async () => {
            throw new Error('integrity-failed');
          },
          rollback: async () => void events.push('rollback'),
          leaveMaintenance: async () => void events.push('leave'),
        },
      }),
    ).rejects.toThrow('integrity-failed');
    expect(await readFile(join(source, 'entry.bin'), 'utf8')).toBe('cache');
    expect(events).toEqual(['maintenance', 'rollback', 'leave']);
  });
});
