import { describe, expect, it } from 'vitest';
import { forwardedBrowserOrigin } from '../src/api/authentication.js';

describe('forwarded browser origin', () => {
  it('accepts a public HTTPS origin only from the loopback DSM proxy', () => {
    expect(
      forwardedBrowserOrigin({
        peerAddress: '127.0.0.1',
        forwardedHost: 'vanweb.synology.me',
        forwardedProto: 'https',
      }),
    ).toBe('https://vanweb.synology.me');
    expect(
      forwardedBrowserOrigin({
        peerAddress: '::ffff:127.0.0.1',
        forwardedHost: '10.240.0.241:5001',
        forwardedProto: 'https',
      }),
    ).toBe('https://10.240.0.241:5001');
  });

  it('does not trust forwarded headers from a non-loopback peer', () => {
    expect(
      forwardedBrowserOrigin({
        peerAddress: '10.240.0.99',
        forwardedHost: 'vanweb.synology.me',
        forwardedProto: 'https',
      }),
    ).toBeNull();
  });

  it('rejects ambiguous and malformed forwarded origins', () => {
    for (const [forwardedHost, forwardedProto] of [
      ['vanweb.synology.me, attacker.example', 'https'],
      ['vanweb.synology.me/path', 'https'],
      ['vanweb.synology.me', 'https, http'],
      ['vanweb.synology.me', 'javascript'],
    ] as const) {
      expect(
        forwardedBrowserOrigin({
          peerAddress: '::1',
          forwardedHost,
          forwardedProto,
        }),
      ).toBeNull();
    }
  });
});
