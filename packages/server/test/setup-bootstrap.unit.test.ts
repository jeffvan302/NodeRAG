import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { setupStatus, verifySetupToken } from '../src/setup/bootstrap.js';
import type { SqlClient } from '../src/store/database.js';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

describe('M09 setup lifecycle', () => {
  it('accepts an active setup token and rejects the same token after expiry', async () => {
    const token = 'setup_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12';
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            state: 'unconfigured',
            setup_token_sha256: digest(token),
            setup_token_expires_at: new Date(Date.now() + 60_000),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            state: 'unconfigured',
            setup_token_sha256: digest(token),
            setup_token_expires_at: new Date(Date.now() - 1),
          },
        ],
      });
    const database = { query } as unknown as SqlClient;
    await expect(verifySetupToken(database, token)).resolves.toBe(true);
    await expect(verifySetupToken(database, token)).resolves.toBe(false);
  });

  it('reports durable step, progress, and an ISO token expiry without exposing a verifier', async () => {
    const expiresAt = new Date('2030-01-02T03:04:05.000Z');
    const database = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            state: 'unconfigured',
            token_issued: true,
            setup_token_expires_at: expiresAt,
            setup_step: 'verify-token',
            setup_progress: 0,
          },
        ],
      }),
    } as unknown as SqlClient;
    await expect(setupStatus(database)).resolves.toEqual({
      state: 'unconfigured',
      tokenIssued: true,
      tokenExpiresAt: expiresAt.toISOString(),
      step: 'verify-token',
      progress: 0,
    });
  });
});
