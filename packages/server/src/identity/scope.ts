import {
  actionCapability,
  searchOnlyAllowedActions,
  type SiloAction,
  type SiloCapability,
} from '@noderag/shared';
import type { Pool } from 'pg';
import { withTransaction, type SqlClient } from '../store/database.js';

type CredentialKind = 'user' | 'api_key';

export interface ResolveScopeOptions {
  readonly gatewayId?: number;
  readonly requestedSiloIds?: readonly number[];
}

interface PrincipalRow {
  readonly kind: CredentialKind;
  readonly disabled: boolean;
  readonly deleted_at: Date | null;
  readonly search_only: boolean | null;
}

const normalizeIds = (ids: readonly number[]): readonly number[] => {
  const unique = new Set<number>();
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 1 || id > 32_767) {
      throw new Error(`Invalid silo id: ${String(id)}`);
    }
    unique.add(id);
  }
  return [...unique].sort((left, right) => left - right);
};

export class SiloScope {
  private constructor(
    readonly principalId: number,
    readonly action: SiloAction,
    readonly credentialKind: CredentialKind,
    readonly siloIds: readonly number[],
  ) {}

  static async resolve(
    database: SqlClient,
    principalId: number,
    action: SiloAction,
    options: ResolveScopeOptions = {},
  ): Promise<SiloScope> {
    if (!Number.isSafeInteger(principalId) || principalId < 1) {
      throw new Error('principalId must be a positive safe integer.');
    }
    const principal = await database.query<PrincipalRow>(
      `SELECT p.kind, p.disabled, p.deleted_at, k.search_only
       FROM noderag.principal p
       LEFT JOIN noderag.api_key k ON k.principal_id = p.id
       WHERE p.id = $1`,
      [principalId],
    );
    const row = principal.rows[0];
    if (row === undefined || row.disabled || row.deleted_at !== null) {
      return new SiloScope(principalId, action, row?.kind ?? 'user', []);
    }
    if (
      row.kind === 'api_key' &&
      row.search_only === true &&
      !searchOnlyAllowedActions.has(action)
    ) {
      return new SiloScope(principalId, action, row.kind, []);
    }

    const required = actionCapability[action];
    const grants = await database.query<{ silo_id: number }>(
      required === 'any'
        ? `SELECT DISTINCT silo_id FROM noderag.silo_grant
           WHERE principal_id = $1 ORDER BY silo_id`
        : `SELECT silo_id FROM noderag.silo_grant
           WHERE principal_id = $1 AND capability = $2 ORDER BY silo_id`,
      required === 'any' ? [principalId] : [principalId, required satisfies SiloCapability],
    );
    let ids = normalizeIds(grants.rows.map(({ silo_id }) => silo_id));

    if (options.gatewayId !== undefined) {
      const gateway = await database.query<{ silo_ids: number[] }>(
        `SELECT silo_ids FROM noderag.gateway
         WHERE id = $1 AND enabled AND require_auth`,
        [options.gatewayId],
      );
      const ceiling = new Set(normalizeIds(gateway.rows[0]?.silo_ids ?? []));
      ids = ids.filter((id) => ceiling.has(id));
    }
    if (options.requestedSiloIds !== undefined) {
      const requested = new Set(normalizeIds(options.requestedSiloIds));
      ids = ids.filter((id) => requested.has(id));
    }
    return new SiloScope(principalId, action, row.kind, ids);
  }

  includes(siloId: number): boolean {
    return this.siloIds.includes(siloId);
  }

  postgresArray(): string {
    return `{${this.siloIds.join(',')}}`;
  }
}

export const withSiloScope = async <T>(
  pool: Pool,
  scope: SiloScope,
  operation: (database: SqlClient) => Promise<T>,
): Promise<T> =>
  withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('app.silo_ids', $1, true)", [scope.postgresArray()]);
    return operation(client);
  });
