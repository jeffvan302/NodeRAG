import { describe, expect, it } from 'vitest';
import { resolveAppUrl } from './url.js';

describe('resolveAppUrl', () => {
  it('retains a DSM Web Station alias for application routes', () => {
    expect(resolveAppUrl('/v1/setup/status', 'https://nas.example/noderag/')).toBe(
      'https://nas.example/noderag/v1/setup/status',
    );
  });

  it('continues to support a root-mounted local testbed', () => {
    expect(resolveAppUrl('/ready', 'http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787/ready');
  });

  it('ignores a page hash and preserves query strings', () => {
    expect(resolveAppUrl('/v1/documents?limit=100', 'https://nas.example/noderag/#documents')).toBe(
      'https://nas.example/noderag/v1/documents?limit=100',
    );
  });
});
