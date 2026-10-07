import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  downloadModelArtifact,
  importModelArtifact,
  modelDownloadHostAllowed,
} from '../src/storage/model-artifacts.js';
import { DefaultModelInstaller } from '../src/storage/default-model.js';
import { probeStorage, storageProbeProblemCode } from '../src/storage/probe.js';
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
    expect(result.managedPath).toBe(result.resolvedPath);
    expect(result.managedSubdirectory).toBe(false);
    expect(result.mode).toMatch(/^0[0-7]{3}$/);
    expect(BigInt(result.availableBytes)).toBeGreaterThan(0n);
  });

  it('preserves an existing shared folder and uses a dedicated managed subfolder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-storage-acl-'));
    const selected = join(root, 'shared-documents');
    await mkdir(selected, { mode: 0o755 });
    await chmod(selected, 0o755);
    const result = await probeStorage(selected, {
      policy: 'testbed',
      protectExistingDirectory: true,
      rebuildReserveBytes: 0n,
    });
    const resolvedSelected = await realpath(selected);
    expect(result.selectedPath).toBe(resolvedSelected);
    expect(result.managedPath).toBe(join(resolvedSelected, '.noderag-managed'));
    expect(result.managedSubdirectory).toBe(true);
    expect(result.warnings).toContain('managed-subdirectory-created');
    if (process.platform !== 'win32') {
      expect((await lstat(selected)).mode & 0o777).toBe(0o755);
      expect((await lstat(result.managedPath)).mode & 0o777).toBe(0o700);
    } else {
      expect((await lstat(result.managedPath)).isDirectory()).toBe(true);
    }
  });

  it('returns actionable storage problem codes for operating-system failures', () => {
    expect(storageProbeProblemCode(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(
      'storage_permission_denied',
    );
    expect(storageProbeProblemCode(Object.assign(new Error('full'), { code: 'ENOSPC' }))).toBe(
      'storage_capacity_insufficient',
    );
    expect(storageProbeProblemCode(new Error('storage_filesystem_unsupported'))).toBe(
      'storage_filesystem_unsupported',
    );
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

  it('follows only allowlisted HTTPS redirects for model downloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-download-redirect-'));
    const bytes = Buffer.from('redirected-model-artifact');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const visited: string[] = [];
    const fetcher = async (input: URL | RequestInfo) => {
      const url = String(input);
      visited.push(url);
      return url.includes('models.example.test')
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.example.test/signed/model.onnx' },
          })
        : new Response(bytes, { status: 200 });
    };

    await expect(
      downloadModelArtifact({
        urls: ['https://models.example.test/model.onnx'],
        allowedHosts: ['models.example.test', 'cdn.example.test'],
        destinationRoot: root,
        name: 'model.onnx',
        expectedSha256: sha256,
        fetcher: fetcher as typeof fetch,
      }),
    ).resolves.toMatchObject({ name: 'model.onnx', sha256 });
    expect(visited).toEqual([
      'https://models.example.test/model.onnx',
      'https://cdn.example.test/signed/model.onnx',
    ]);
  });

  it('allows a bounded provider CDN suffix without accepting look-alike domains', () => {
    const allowed = ['huggingface.co', '.aws.cdn.hf.co'];
    expect(modelDownloadHostAllowed('huggingface.co', allowed)).toBe(true);
    expect(modelDownloadHostAllowed('us.aws.cdn.hf.co', allowed)).toBe(true);
    expect(modelDownloadHostAllowed('eu.aws.cdn.hf.co', allowed)).toBe(true);
    expect(modelDownloadHostAllowed('aws.cdn.hf.co.attacker.example', allowed)).toBe(false);
    expect(modelDownloadHostAllowed('notaws.cdn.hf.co', allowed)).toBe(false);
  });

  it('downloads and marks a complete default model without blocking status requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-default-model-'));
    const bytes = Buffer.from('small-default-model');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const records: string[] = [];
    const installer = new DefaultModelInstaller({
      root,
      allowedHosts: ['models.example.test'],
      files: [
        {
          name: 'model.onnx',
          bytes: bytes.length,
          sha256,
          urls: ['https://models.example.test/model.onnx'],
        },
      ],
      fetcher: (async () => new Response(bytes, { status: 200 })) as typeof fetch,
    });

    expect(await installer.status()).toMatchObject({ state: 'missing', progress: 0 });
    installer.start(async (artifact) => void records.push(artifact.name));
    await installer.waitForIdle();
    expect(await installer.status()).toMatchObject({ state: 'ready', progress: 100 });
    expect(records).toEqual(['model.onnx']);
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
