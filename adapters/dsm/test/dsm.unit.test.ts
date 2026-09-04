import { describe, expect, it } from 'vitest';
import { createDsmAdapterContract } from '../src/index.js';

describe('DSM adapter contract', () => {
  it('accepts only explicit absolute DSM paths', () => {
    const adapter = createDsmAdapterContract({
      packageRoot: '/var/packages/noderag/target',
      packageDataRoot: '/var/packages/noderag/var',
      temporaryRoot: '/var/packages/noderag/tmp',
      nodeBinary: '/var/packages/Node.js_v22/target/usr/local/bin/node',
      port: 8787,
    });
    expect(adapter.kind).toBe('dsm');
    expect(adapter.resources.port).toBe(8787);
    expect(adapter.backgroundScheduling).toEqual({
      workerNice: 10,
      workerIoClass: 2,
      workerIoPriority: 7,
      embedderNice: 5,
    });
  });

  it('rejects host-relative paths instead of guessing DSM state', () => {
    expect(() =>
      createDsmAdapterContract({
        packageRoot: 'relative',
        packageDataRoot: '/var/packages/noderag/var',
        temporaryRoot: '/var/packages/noderag/tmp',
        nodeBinary: '/node',
        port: 8787,
      }),
    ).toThrow('packageRoot must be an absolute DSM path');
  });
});
