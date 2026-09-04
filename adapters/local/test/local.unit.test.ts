import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalAdapter } from '../src/index.js';

describe('local platform adapter', () => {
  it('keeps all managed paths below the selected root', () => {
    const root = resolve('test-runtime');
    const adapter = createLocalAdapter({ root, port: 8787 });
    expect(adapter.kind).toBe('local');
    for (const path of Object.values(adapter.paths)) {
      expect(path === root || path.startsWith(`${root}\\`) || path.startsWith(`${root}/`)).toBe(
        true,
      );
    }
    expect(adapter.backgroundScheduling).toEqual({
      workerNice: 10,
      workerIoClass: 2,
      workerIoPriority: 7,
      embedderNice: 5,
    });
  });

  it('rejects an invalid port', () => {
    expect(() => createLocalAdapter({ root: '.', port: 0 })).toThrow('Invalid local port');
  });
});
