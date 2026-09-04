import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { withTransaction } from '../store/database.js';

export type MaintenanceKind = 'backup' | 'restore' | 'upgrade';

export interface MaintenanceLease {
  readonly kind: MaintenanceKind;
  readonly operationId: number;
  readonly ownerToken: string;
}

export const enterMaintenance = async (
  pool: Pool,
  kind: MaintenanceKind,
  operationId: number,
): Promise<MaintenanceLease> => {
  if (!Number.isSafeInteger(operationId) || operationId < 1)
    throw new Error('invalid-maintenance-operation-id');
  const ownerToken = randomUUID();
  await withTransaction(pool, async (database) => {
    const barrier = await database.query<{ state: string }>(
      'SELECT state FROM noderag.maintenance_barrier WHERE id = true FOR UPDATE',
    );
    if (barrier.rows[0]?.state !== 'inactive') throw new Error('maintenance-already-active');
    await database.query(
      `UPDATE noderag.maintenance_barrier
       SET state = 'entering', kind = $1, operation_id = $2, owner_token = $3,
           entered_at = now(), quiesced_at = NULL, updated_at = now()
       WHERE id = true`,
      [kind, operationId, ownerToken],
    );
    await database.query(
      `UPDATE noderag.setup_state SET state = 'maintenance', updated_at = now() WHERE id = 1`,
    );
  });
  return { kind, operationId, ownerToken };
};

export const waitForMutationDrain = async (
  pool: Pool,
  lease: MaintenanceLease,
  timeoutMilliseconds = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (true) {
    const active = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM noderag.job
       WHERE state = 'leased' AND kind IN ('crawl','extract','vision','chunk','embed','rebuild','purge')`,
    );
    if (Number(active.rows[0]?.count ?? '0') === 0) break;
    if (Date.now() >= deadline) throw new Error('maintenance-drain-timeout');
    await delay(100);
  }
  const updated = await pool.query(
    `UPDATE noderag.maintenance_barrier
     SET state = 'quiesced', quiesced_at = now(), updated_at = now()
     WHERE id = true AND owner_token = $1 AND state = 'entering'`,
    [lease.ownerToken],
  );
  if (updated.rowCount !== 1) throw new Error('maintenance-lease-lost');
};

export const releaseMaintenance = async (pool: Pool, lease: MaintenanceLease): Promise<void> => {
  await withTransaction(pool, async (database) => {
    const released = await database.query(
      `UPDATE noderag.maintenance_barrier
       SET state = 'inactive', kind = NULL, operation_id = NULL, owner_token = NULL,
           entered_at = NULL, quiesced_at = NULL, updated_at = now()
       WHERE id = true AND owner_token = $1`,
      [lease.ownerToken],
    );
    if (released.rowCount !== 1) throw new Error('maintenance-lease-lost');
    await database.query(
      `UPDATE noderag.setup_state SET state = 'operational', updated_at = now()
       WHERE id = 1 AND state = 'maintenance'`,
    );
  });
};

export const withMaintenance = async <T>(
  pool: Pool,
  kind: MaintenanceKind,
  operationId: number,
  operation: (lease: MaintenanceLease) => Promise<T>,
): Promise<T> => {
  const lease = await enterMaintenance(pool, kind, operationId);
  try {
    await waitForMutationDrain(pool, lease);
    return await operation(lease);
  } finally {
    await releaseMaintenance(pool, lease);
  }
};

export const recoverAbandonedMaintenance = async (pool: Pool): Promise<number> =>
  withTransaction(pool, async (database) => {
    const barrier = await database.query<{
      state: string;
      kind: string | null;
      operation_id: string | null;
    }>(
      'SELECT state, kind, operation_id FROM noderag.maintenance_barrier WHERE id = true FOR UPDATE',
    );
    const row = barrier.rows[0];
    if (row === undefined || row.state === 'inactive') return 0;
    if (row.kind === 'backup')
      await database.query(
        `UPDATE noderag.backup_operation
         SET state = 'failed', error_code = 'process-interrupted', finished_at = now(),
             failure_detail = '{"recovery":"startup-sweep"}'::jsonb
         WHERE id = $1 AND state IN ('queued','running','verifying')`,
        [row.operation_id],
      );
    if (row.kind === 'restore')
      await database.query(
        `UPDATE noderag.restore_operation
         SET state = 'failed', error_code = 'process-interrupted', finished_at = now(),
             failure_detail = '{"recovery":"startup-sweep"}'::jsonb
         WHERE id = $1 AND state NOT IN ('succeeded','failed','cancelled')`,
        [row.operation_id],
      );
    if (row.kind === 'upgrade')
      await database.query(
        `UPDATE noderag.upgrade_rehearsal
         SET state = 'failed', finished_at = now(),
             failure_detail = '{"code":"process-interrupted","recovery":"startup-sweep"}'::jsonb
         WHERE id = $1 AND state NOT IN ('succeeded','failed','rolled_back')`,
        [row.operation_id],
      );
    await database.query(
      `UPDATE noderag.maintenance_barrier
       SET state = 'inactive', kind = NULL, operation_id = NULL, owner_token = NULL,
           entered_at = NULL, quiesced_at = NULL, updated_at = now() WHERE id = true`,
    );
    await database.query(
      `UPDATE noderag.setup_state SET state = 'operational', updated_at = now()
       WHERE id = 1 AND state = 'maintenance'`,
    );
    return 1;
  });
