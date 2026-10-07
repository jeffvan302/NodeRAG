import { afterEach, describe, expect, it, vi } from 'vitest';

describe('browser API authentication recovery', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('clears a stale CSRF token and requests a fresh sign-in', async () => {
    const values = new Map([['noderag.csrf', 'stale-csrf-token']]);
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    };
    const dispatchEvent = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { status: 403, code: 'csrf_rejected', title: 'csrf rejected' },
        { status: 403 },
      ),
    );
    vi.stubGlobal('sessionStorage', storage);
    vi.stubGlobal('window', {
      location: { href: 'http://nas.local/noderag/' },
      dispatchEvent,
    });
    vi.stubGlobal('fetch', fetch);

    const { api, authenticationRequiredEvent } = await import('./api.js');
    await expect(api('/v1/admin/test', { method: 'POST' })).rejects.toMatchObject({
      detail: { code: 'csrf_rejected' },
    });

    expect(storage.removeItem).toHaveBeenCalledWith('noderag.csrf');
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect((dispatchEvent.mock.calls[0]?.[0] as Event).type).toBe(authenticationRequiredEvent);
    const request = fetch.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get('x-csrf-token')).toBe('stale-csrf-token');
  });
});
