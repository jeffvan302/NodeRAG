import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeterministicRuntime } from '../../embedder/src/runtime.js';
import { startEmbedderServer } from '../../embedder/src/server.js';
import { FramedEmbedderClient } from '../src/embedder/client.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('framed embedder client and server', () => {
  it('serves count and embedding requests through one long-lived runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-embedder-'));
    const socket =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\noderag-${crypto.randomUUID()}`
        : join(root, 'embed.sock');
    const server = await startEmbedderServer(socket, createDeterministicRuntime());
    const client = new FramedEmbedderClient(socket);
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(() => server.close());
    cleanup.push(() => client.close());
    expect(await client.countTokens(['one two three'])).toEqual([3]);
    const embedded = await client.embed(['one two three'], 8, 0);
    expect(embedded.vectors[0]).toHaveLength(1024);
    const selected = await client.embed(['one two three'], 8, 0, {
      manifestDigest: 'ab'.repeat(32),
      dimensions: 3,
    });
    expect(selected.vectors[0]).toHaveLength(3);
    expect(embedded.tokenCounts).toEqual([3]);
    expect(await client.runtimeStatus()).toEqual({
      availableProcessors: 32,
      threads: 1,
      generation: 0,
    });
    expect(await client.configureThreads(4)).toEqual({
      availableProcessors: 32,
      threads: 4,
      generation: 1,
    });
    expect(await client.runtimeStatus()).toEqual({
      availableProcessors: 32,
      threads: 4,
      generation: 1,
    });
  });

  it('splits oversized work into protocol-safe frames while preserving result order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noderag-embedder-batches-'));
    const socket =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\noderag-${crypto.randomUUID()}`
        : join(root, 'embed.sock');
    const server = await startEmbedderServer(socket, createDeterministicRuntime());
    const client = new FramedEmbedderClient(socket);
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(() => server.close());
    cleanup.push(() => client.close());

    const texts = Array.from(
      { length: 20 },
      (_, index) => `calibration passage ${String(index + 1)} with predictable tokens`,
    );
    const tokenCounts = await client.countTokens(texts);
    const embedded = await client.embed(texts, 32, 0);

    expect(tokenCounts).toEqual(new Array(20).fill(6));
    expect(embedded.tokenCounts).toEqual(tokenCounts);
    expect(embedded.vectors).toHaveLength(20);
    expect(embedded.vectors.every((vector) => vector.length === 1024)).toBe(true);
    expect(embedded.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
  });
});
