import type { Pool } from 'pg';
import type { SecretVault } from '../identity/secrets.js';
import { databaseInteger, withTransaction } from '../store/database.js';
import type { BackupProduct } from './archive.js';
import type { RuntimeBackupRequest } from './runtime.js';

interface ClaimedSchedule {
  readonly scheduleId: number;
  readonly backupId: number;
  readonly product: BackupProduct;
  readonly includeModels: false;
  readonly secretProvider: string;
  readonly secretName: string;
  readonly secretFingerprint: string;
}

export const nextBackupScheduleAt = (
  cadence: 'daily' | 'weekly',
  utcHour: number,
  utcMinute: number,
  utcWeekday: number | null,
  after: Date,
): Date => {
  if (!Number.isInteger(utcHour) || utcHour < 0 || utcHour > 23)
    throw new Error('backup-schedule-hour-invalid');
  if (!Number.isInteger(utcMinute) || utcMinute < 0 || utcMinute > 59)
    throw new Error('backup-schedule-minute-invalid');
  const next = new Date(after);
  next.setUTCSeconds(0, 0);
  next.setUTCHours(utcHour, utcMinute, 0, 0);
  if (cadence === 'daily') {
    if (next <= after) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  if (utcWeekday === null || !Number.isInteger(utcWeekday) || utcWeekday < 0 || utcWeekday > 6)
    throw new Error('backup-schedule-weekday-invalid');
  let days = (utcWeekday - next.getUTCDay() + 7) % 7;
  if (days === 0 && next <= after) days = 7;
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const claimDueSchedule = async (pool: Pool): Promise<ClaimedSchedule | null> =>
  withTransaction(pool, async (database) => {
    const due = await database.query<{
      id: unknown;
      product: BackupProduct;
      destination_id: unknown;
      cadence: 'daily' | 'weekly';
      utc_hour: number;
      utc_minute: number;
      utc_weekday: number | null;
      secret_provider: string;
      secret_name: string;
      secret_fingerprint: string;
      created_by: unknown;
      database_now: Date;
    }>(
      `SELECT schedule.*,clock_timestamp() AS database_now
       FROM noderag.backup_schedule schedule
       WHERE schedule.enabled AND schedule.next_run_at <= now()
       ORDER BY schedule.next_run_at,schedule.id
       FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const row = due.rows[0];
    if (row === undefined) return null;
    const scheduleId = databaseInteger(row.id, 'backup schedule id');
    const created = await database.query<{ id: unknown }>(
      `INSERT INTO noderag.backup_operation
         (product,destination_id,requested_by,include_models)
       VALUES ($1,$2,$3,false) RETURNING id`,
      [row.product, row.destination_id, row.created_by],
    );
    const backupId = databaseInteger(created.rows[0]?.id, 'scheduled backup operation id');
    const nextRunAt = nextBackupScheduleAt(
      row.cadence,
      row.utc_hour,
      row.utc_minute,
      row.utc_weekday,
      row.database_now,
    );
    await database.query(
      `UPDATE noderag.backup_schedule
       SET last_run_at=$2,last_backup_id=$3,last_result='running',next_run_at=$4,updated_at=now()
       WHERE id=$1`,
      [scheduleId, row.database_now, backupId, nextRunAt],
    );
    return {
      scheduleId,
      backupId,
      product: row.product,
      includeModels: false,
      secretProvider: row.secret_provider,
      secretName: row.secret_name,
      secretFingerprint: row.secret_fingerprint,
    };
  });

export const processOneScheduledBackup = async (
  pool: Pool,
  secretVault: SecretVault,
  execute: (request: RuntimeBackupRequest) => Promise<void>,
): Promise<boolean> => {
  const claimed = await claimDueSchedule(pool);
  if (claimed === null) return false;
  try {
    const passphrase = await secretVault.reveal(pool, claimed.secretProvider, claimed.secretName);
    if (
      passphrase === null ||
      !secretVault.matchesFingerprint(passphrase, claimed.secretFingerprint)
    )
      throw new Error('scheduled-backup-secret-unavailable');
    await execute({
      operationId: claimed.backupId,
      product: claimed.product,
      passphrase,
      includeModels: claimed.includeModels,
    });
    await pool.query(
      `UPDATE noderag.backup_schedule SET last_result='succeeded',updated_at=now() WHERE id=$1`,
      [claimed.scheduleId],
    );
    return true;
  } catch (error) {
    const code =
      error instanceof Error ? error.message.split(':', 1)[0] : 'scheduled-backup-failed';
    await withTransaction(pool, async (database) => {
      await database.query(
        `UPDATE noderag.backup_operation
         SET state='failed',verification_state='failed',error_code=COALESCE(error_code,$2),
             finished_at=COALESCE(finished_at,now()) WHERE id=$1 AND state='queued'`,
        [claimed.backupId, code?.slice(0, 160) ?? 'scheduled-backup-failed'],
      );
      await database.query(
        `UPDATE noderag.backup_schedule SET last_result=$2,updated_at=now() WHERE id=$1`,
        [claimed.scheduleId, code?.slice(0, 160) ?? 'scheduled-backup-failed'],
      );
    });
    return true;
  }
};
