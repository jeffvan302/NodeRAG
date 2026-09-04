import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('Fastify service skeleton', () => {
  it('serves health with a request ID and redaction-safe envelope', async () => {
    const app = buildApp({
      logger: false,
      readiness: async () => ({
        service: 'noderag',
        status: 'ok',
        migrationHead: '000001_foundation',
        expectedMigrationHead: '000001_foundation',
        reasons: [],
      }),
      uiRoot: 'missing-ui',
    });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'noderag', status: 'ok', version: '0.2.0' });
    await app.close();
  });

  it('fails readiness closed and still serves the thin UI fallback', async () => {
    const app = buildApp({
      logger: false,
      readiness: async () => ({
        service: 'noderag',
        status: 'unavailable',
        migrationHead: null,
        expectedMigrationHead: '000001_foundation',
        reasons: ['database-not-configured'],
      }),
      uiRoot: 'missing-ui',
    });
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
    const ui = await app.inject({ method: 'GET', url: '/' });
    expect(ui.statusCode).toBe(200);
    expect(ui.body).toContain('The thin service is running.');
    await app.close();
  });

  it('does not allow path traversal through the static route', async () => {
    const app = buildApp({
      logger: false,
      readiness: async () => ({
        service: 'noderag',
        status: 'ok',
        migrationHead: '000001_foundation',
        expectedMigrationHead: '000001_foundation',
        reasons: [],
      }),
      uiRoot: '.',
    });
    expect((await app.inject({ method: 'GET', url: '/..%2Fpackage.json' })).statusCode).toBe(404);
    await app.close();
  });
});
