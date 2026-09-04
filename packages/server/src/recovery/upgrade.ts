import type { Pool } from 'pg';
import { withMaintenance } from './maintenance.js';

export interface UpgradePlan {
  readonly kind: 'same-major' | 'postgres-major';
  readonly fromPostgresMajor: number;
  readonly toPostgresMajor: number;
  readonly logicalDatabaseBytes: number;
  readonly requiredFreeBytes: number;
}

export const planUpgrade = (
  fromPostgresMajor: number,
  toPostgresMajor: number,
  logicalDatabaseBytes: number,
): UpgradePlan => {
  if (
    !Number.isSafeInteger(fromPostgresMajor) ||
    fromPostgresMajor < 1 ||
    !Number.isSafeInteger(toPostgresMajor) ||
    toPostgresMajor < 1 ||
    !Number.isSafeInteger(logicalDatabaseBytes) ||
    logicalDatabaseBytes < 0
  )
    throw new Error('upgrade-plan-invalid');
  const kind = fromPostgresMajor === toPostgresMajor ? 'same-major' : 'postgres-major';
  return {
    kind,
    fromPostgresMajor,
    toPostgresMajor,
    logicalDatabaseBytes,
    requiredFreeBytes: kind === 'postgres-major' ? logicalDatabaseBytes * 2 : logicalDatabaseBytes,
  };
};

export interface UpgradeDriver {
  createSafetyBackup(): Promise<number>;
  applyForwardMigrations(): Promise<void>;
  initializeNewCluster(): Promise<void>;
  restoreLogicalDump(): Promise<void>;
  verify(): Promise<Readonly<Record<string, unknown>>>;
  activate(): Promise<void>;
  rollback(): Promise<void>;
  retainPreviousState(): Promise<void>;
}

export interface UpgradeExecutionOptions {
  readonly pool: Pool;
  readonly operationId: number;
  readonly plan: UpgradePlan;
  readonly measuredFreeBytes: number;
  readonly expectedMigrationHead: string;
  readonly driver: UpgradeDriver;
}

export const executeUpgradeRehearsal = async (options: UpgradeExecutionOptions): Promise<void> => {
  if (options.measuredFreeBytes < options.plan.requiredFreeBytes) {
    await options.pool.query(
      `UPDATE noderag.upgrade_rehearsal
       SET state = 'failed', measured_free_bytes = $2, finished_at = now(),
           failure_detail = '{"code":"upgrade-insufficient-free-space"}'::jsonb
       WHERE id = $1`,
      [options.operationId, options.measuredFreeBytes],
    );
    throw new Error('upgrade-insufficient-free-space');
  }
  await options.pool.query(
    `UPDATE noderag.upgrade_rehearsal
     SET state = 'preflight', measured_free_bytes = $2, started_at = now()
     WHERE id = $1`,
    [options.operationId, options.measuredFreeBytes],
  );
  try {
    await withMaintenance(options.pool, 'upgrade', options.operationId, async () => {
      const backupId = await options.driver.createSafetyBackup();
      await options.pool.query(
        `UPDATE noderag.upgrade_rehearsal
         SET state = 'backed_up', safety_backup_id = $2 WHERE id = $1`,
        [options.operationId, backupId],
      );
      if (options.plan.kind === 'same-major') {
        await options.driver.applyForwardMigrations();
      } else {
        await options.driver.initializeNewCluster();
        await options.pool.query(
          `UPDATE noderag.upgrade_rehearsal SET state = 'restoring' WHERE id = $1`,
          [options.operationId],
        );
        await options.driver.restoreLogicalDump();
      }
      await options.pool.query(
        `UPDATE noderag.upgrade_rehearsal SET state = 'verifying' WHERE id = $1`,
        [options.operationId],
      );
      const verification = await options.driver.verify();
      if (verification['migrationHead'] !== options.expectedMigrationHead)
        throw new Error('upgrade-migration-head-mismatch');
      await options.driver.activate();
      await options.driver.retainPreviousState();
      await options.pool.query(
        `UPDATE noderag.upgrade_rehearsal
         SET state = 'succeeded', verification = $2, finished_at = now() WHERE id = $1`,
        [options.operationId, verification],
      );
    });
  } catch (error) {
    await options.driver.rollback().catch(() => undefined);
    await options.pool.query(
      `UPDATE noderag.upgrade_rehearsal
       SET state = 'rolled_back', finished_at = now(),
           failure_detail = jsonb_build_object('code', $2::text, 'rollback', 'completed')
       WHERE id = $1`,
      [
        options.operationId,
        error instanceof Error ? error.message.slice(0, 160) : 'upgrade-failed',
      ],
    );
    throw error;
  }
};
