import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { GatewayControl } from './admin-routes.js';

interface GatewayRow {
  readonly id: number;
  readonly port: number;
}

interface BoundGateway {
  readonly port: number;
  readonly app: FastifyInstance;
}

export type GatewayAppFactory = (gatewayId: number) => FastifyInstance;

export class GatewayListenerManager implements GatewayControl {
  readonly #bound = new Map<number, BoundGateway>();

  constructor(
    private readonly pool: Pool,
    private readonly host: string,
    private readonly factory: GatewayAppFactory,
  ) {}

  async reconcile(): Promise<
    readonly {
      readonly id: number;
      readonly port: number;
      readonly status: 'bound' | 'conflict' | 'error';
      readonly error?: string;
    }[]
  > {
    const configured = await this.pool.query<GatewayRow>(
      `SELECT id, port FROM noderag.gateway
       WHERE enabled AND require_auth AND port IS NOT NULL ORDER BY id`,
    );
    const desired = new Map(configured.rows.map((row) => [row.id, row]));
    for (const [id, bound] of this.#bound) {
      if (desired.get(id)?.port === bound.port) continue;
      await bound.app.close();
      this.#bound.delete(id);
    }
    const statuses: Array<{
      id: number;
      port: number;
      status: 'bound' | 'conflict' | 'error';
      error?: string;
    }> = [];
    for (const row of configured.rows) {
      if (this.#bound.has(row.id)) {
        statuses.push({ id: row.id, port: row.port, status: 'bound' });
        continue;
      }
      const app = this.factory(row.id);
      try {
        await app.listen({ host: this.host, port: row.port });
        this.#bound.set(row.id, { port: row.port, app });
        await this.pool.query(
          `UPDATE noderag.gateway SET bound_at=now(),last_bind_error=NULL WHERE id=$1`,
          [row.id],
        );
        statuses.push({ id: row.id, port: row.port, status: 'bound' });
      } catch (error) {
        await app.close().catch(() => undefined);
        const code =
          error instanceof Error && 'code' in error ? String(error.code) : 'gateway-bind-failed';
        const status = code === 'EADDRINUSE' ? 'conflict' : 'error';
        await this.pool.query(
          `UPDATE noderag.gateway SET bound_at=NULL,last_bind_error=$2 WHERE id=$1`,
          [row.id, code],
        );
        statuses.push({ id: row.id, port: row.port, status, error: code });
      }
    }
    return statuses;
  }

  async close(): Promise<void> {
    const apps = [...this.#bound.values()].map(({ app }) => app.close());
    this.#bound.clear();
    await Promise.all(apps);
  }
}
