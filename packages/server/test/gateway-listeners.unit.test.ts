import { createServer, type Server } from 'node:net';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayListenerManager } from '../src/api/gateway-listeners.js';

const listen = async (port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => resolve(server));
  });

const close = async (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );

describe('gateway listener reconciliation', () => {
  let occupied: Server | undefined;

  afterEach(async () => {
    if (occupied !== undefined) await close(occupied);
    occupied = undefined;
  });

  it('binds an available static-range port and records a conflict without crashing', async () => {
    let conflictPort: number | undefined;
    for (let port = 5300; port <= 5318; port += 1) {
      try {
        occupied = await listen(port);
        conflictPort = port;
        break;
      } catch {
        // Continue through the declared static range.
      }
    }
    if (conflictPort === undefined)
      throw new Error('No static-range port was available for the test.');
    let freePort: number | undefined;
    for (let port = conflictPort + 1; port <= 5319; port += 1) {
      try {
        const probe = await listen(port);
        await close(probe);
        freePort = port;
        break;
      } catch {
        // Continue through the declared static range.
      }
    }
    if (freePort === undefined)
      throw new Error('No second static-range port was available for the test.');

    const updates: unknown[][] = [];
    const pool = {
      query: async (sql: string, parameters?: unknown[]) => {
        if (sql.includes('SELECT id, port')) {
          return {
            rows: [
              { id: 1, port: conflictPort },
              { id: 2, port: freePort },
            ],
          };
        }
        updates.push(parameters ?? []);
        return { rows: [] };
      },
    };
    const manager = new GatewayListenerManager(pool as never, '127.0.0.1', () => {
      const app = Fastify({ logger: false });
      app.get('/health', async () => ({ status: 'ok' }));
      return app;
    });
    try {
      const statuses = await manager.reconcile();
      expect(statuses).toContainEqual({
        id: 1,
        port: conflictPort,
        status: 'conflict',
        error: 'EADDRINUSE',
      });
      expect(statuses).toContainEqual({ id: 2, port: freePort, status: 'bound' });
      expect(updates).toContainEqual([1, 'EADDRINUSE']);
      expect(updates).toContainEqual([2]);
    } finally {
      await manager.close();
    }
  });
});
