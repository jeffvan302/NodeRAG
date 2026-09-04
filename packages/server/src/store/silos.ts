import type { SiloCapability } from '@noderag/shared';
import type { Pool } from 'pg';
import { withTransaction, type SqlClient } from './database.js';

export interface CreateSiloInput {
  readonly slug: string;
  readonly displayName: string;
  readonly description?: string;
  readonly creatingPrincipalId: number;
}

export interface SiloRecord {
  readonly id: number;
  readonly slug: string;
  readonly displayName: string;
}

const requireServerAdministrator = async (
  database: SqlClient,
  principalId: number,
): Promise<void> => {
  const result = await database.query(
    `SELECT 1
     FROM noderag.principal p
     JOIN noderag.app_user u ON u.principal_id = p.id
     WHERE p.id = $1 AND u.server_admin AND NOT p.disabled AND p.deleted_at IS NULL`,
    [principalId],
  );
  if (result.rowCount !== 1) throw new Error('server-admin-required');
};

const partitionName = (siloId: number): string => {
  if (!Number.isSafeInteger(siloId) || siloId < 1 || siloId > 32_767) {
    throw new Error('Invalid silo partition id.');
  }
  return `chunk_s${siloId}`;
};

export const createChunkPartition = async (database: SqlClient, siloId: number): Promise<void> => {
  const table = partitionName(siloId);
  await database.query(
    `CREATE TABLE noderag.${table} PARTITION OF noderag.chunk FOR VALUES IN (${siloId})`,
  );
  await database.query(
    `CREATE INDEX ${table}_embedding_hnsw_idx ON noderag.${table}
     USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64)`,
  );
  await database.query(
    `CREATE INDEX ${table}_search_vector_gin_idx ON noderag.${table} USING gin (search_vector)`,
  );
  await database.query(
    `CREATE INDEX ${table}_document_ordinal_idx ON noderag.${table} (document_id, ordinal)`,
  );
  await database.query(`ALTER TABLE noderag.${table} ENABLE ROW LEVEL SECURITY`);
  await database.query(`ALTER TABLE noderag.${table} FORCE ROW LEVEL SECURITY`);
  await database.query(
    `CREATE POLICY ${table}_silo_scope ON noderag.${table}
     USING (silo_id = ANY (noderag.current_silo_ids()))
     WITH CHECK (silo_id = ANY (noderag.current_silo_ids()))`,
  );
};

export const createSiloInTransaction = async (
  database: SqlClient,
  input: CreateSiloInput,
): Promise<SiloRecord> => {
  await requireServerAdministrator(database, input.creatingPrincipalId);
  const created = await database.query<{ id: number; slug: string; display_name: string }>(
    `INSERT INTO noderag.silo (slug, display_name, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, slug, display_name`,
    [input.slug, input.displayName, input.description ?? null, input.creatingPrincipalId],
  );
  const row = created.rows[0];
  if (row === undefined) throw new Error('Silo insertion returned no row.');
  await createChunkPartition(database, row.id);
  const capabilities: readonly SiloCapability[] = ['read', 'upload', 'delete'];
  await database.query(
    `INSERT INTO noderag.silo_grant (principal_id, silo_id, capability, granted_by)
       SELECT $1, $2, capability, $1 FROM unnest($3::text[]) capability`,
    [input.creatingPrincipalId, row.id, capabilities],
  );
  await database.query(
    `INSERT INTO noderag.silo_build_state (silo_id, build_id, state)
     SELECT $1, id, 'active' FROM noderag.build WHERE state = 'active'
     ON CONFLICT (silo_id, build_id) DO NOTHING`,
    [row.id],
  );
  await database.query(
    `INSERT INTO noderag.audit_log (principal_id, silo_id, action, result, detail)
       VALUES ($1, $2, 'silo.create', 'ok', jsonb_build_object('slug', $3::text))`,
    [input.creatingPrincipalId, row.id, row.slug],
  );
  return { id: row.id, slug: row.slug, displayName: row.display_name };
};

export const createSilo = async (pool: Pool, input: CreateSiloInput): Promise<SiloRecord> =>
  withTransaction(pool, (database) => createSiloInTransaction(database, input));

export const setSiloCapability = async (
  database: SqlClient,
  administratorId: number,
  principalId: number,
  siloId: number,
  capability: SiloCapability,
  enabled: boolean,
): Promise<void> => {
  await requireServerAdministrator(database, administratorId);
  if (enabled) {
    await database.query(
      `INSERT INTO noderag.silo_grant
         (principal_id, silo_id, capability, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (principal_id, silo_id, capability) DO NOTHING`,
      [principalId, siloId, capability, administratorId],
    );
  } else {
    await database.query(
      `DELETE FROM noderag.silo_grant
       WHERE principal_id = $1 AND silo_id = $2 AND capability = $3`,
      [principalId, siloId, capability],
    );
  }
  await database.query(
    `INSERT INTO noderag.audit_log (principal_id, silo_id, action, result, detail)
     VALUES ($1, $2, 'grant.change', 'ok',
             jsonb_build_object('targetPrincipalId', $3::bigint,
                                'capability', $4::text, 'enabled', $5::boolean))`,
    [administratorId, siloId, principalId, capability, enabled],
  );
};

export interface PurgeSiloInput {
  readonly siloId: number;
  readonly expectedSlug: string;
  readonly principalId: number;
  readonly allowDestructivePurge?: boolean;
}

export const purgeSilo = async (pool: Pool, input: PurgeSiloInput): Promise<void> => {
  if (input.allowDestructivePurge !== true) throw new Error('silo-purge-disabled-until-m05');
  await withTransaction(pool, async (database) => {
    await requireServerAdministrator(database, input.principalId);
    const silo = await database.query<{ slug: string }>(
      'SELECT slug FROM noderag.silo WHERE id = $1 FOR UPDATE',
      [input.siloId],
    );
    if (silo.rows[0]?.slug !== input.expectedSlug) throw new Error('silo-confirmation-mismatch');
    const table = partitionName(input.siloId);
    await database.query(`DROP TABLE noderag.${table}`);
    await database.query('DELETE FROM noderag.silo WHERE id = $1', [input.siloId]);
    await database.query(
      `INSERT INTO noderag.audit_log (principal_id, action, result, detail)
       VALUES ($1, 'silo.purge', 'ok', jsonb_build_object('siloId', $2::int, 'slug', $3::text))`,
      [input.principalId, input.siloId, input.expectedSlug],
    );
  });
};
