import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreateSecretRoot } from '../src/identity/secrets.js';

describe('package-local secret root', () => {
  it('creates one 32-byte root and reuses it without rotation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'noderag-secret-'));
    try {
      const path = join(directory, 'secrets', 'root.key');
      const first = await loadOrCreateSecretRoot(path);
      const second = await loadOrCreateSecretRoot(path);
      expect(first).toHaveLength(32);
      expect(second).toEqual(first);
      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
