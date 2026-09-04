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
    expect(embedded.tokenCounts).toEqual([3]);
  });
});
