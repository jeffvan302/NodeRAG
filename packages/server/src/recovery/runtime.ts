import type { ClientConfig } from 'pg';
import type { Pool } from 'pg';
import type { SecretVault } from '../identity/secrets.js';
import { databaseInteger } from '../store/database.js';
import { CURRENT_SCHEMA_REVISION } from '../store/schema-revision.js';
import { executeBackup } from './backup.js';
import type { BackupProduct } from './archive.js';
import { loadBackupClassification } from './policy.js';
import { postgresToolMajor, streamPgDump, type PostgresToolConnection } from './pg-tools.js';
import { PostgresFullRestoreTarget, PostgresPortableImportTarget } from './postgres-target.js';
import { executeRestore, portableImportConfirmationPhrase } from './restore.js';

export interface RuntimeBackupRequest {
  readonly operationId: number;
  readonly product: BackupProduct;
  readonly passphrase: string;
  readonly includeModels: boolean;
}

export interface RuntimeRestoreRequest {
  readonly operationId: number;
  readonly passphrase: string;
  readonly confirmation: string;
  readonly mode?: 'full' | 'portable';
  readonly destinationSiloId?: number;
  readonly ownerPrincipalId?: number;
}

export interface RecoveryRuntimeOptions {
  readonly pool: Pool;
  readonly database: ClientConfig;
  readonly dataRoot: string;
  readonly nodeRagVersion: string;
  readonly pgDumpExecutable?: string;
  readonly secretVault: SecretVault;
}

const toolConnection = (database: ClientConfig): PostgresToolConnection => {
  if (
    typeof database.host !== 'string' ||
    typeof database.port !== 'number' ||
    typeof database.database !== 'string' ||
    typeof database.user !== 'string' ||
    typeof database.password !== 'string'
  )
    throw new Error('postgres-recovery-connection-incomplete');
  return {
    host: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    sslMode: database.ssl === undefined || database.ssl === false ? 'prefer' : 'require',
  };
};

export const streamRecoverySecrets = async function* (
  pool: Pool,
  secretVault: SecretVault,
): AsyncGenerator<Uint8Array> {
  const secrets = await pool.query<{ id: unknown; provider: string; name: string }>(
    `SELECT id,provider,name FROM noderag.encrypted_secret ORDER BY provider,name`,
  );
  for (const secret of secrets.rows) {
    const value = await secretVault.reveal(pool, secret.provider, secret.name);
    if (value === null) throw new Error('backup-secret-disappeared');
    yield Buffer.from(
      `${JSON.stringify({ sourceId: databaseInteger(secret.id, 'secret id'), provider: secret.provider, name: secret.name, value })}\n`,
      'utf8',
    );
  }
};

export class RecoveryRuntime {
  readonly #options: RecoveryRuntimeOptions;

  constructor(options: RecoveryRuntimeOptions) {
    this.#options = options;
  }

  async startBackup(request: RuntimeBackupRequest): Promise<void> {
    try {
      await this.#executeBackup(request);
    } catch (error) {
      await this.#options.pool
        .query(
          `UPDATE noderag.backup_operation
           SET state='failed',verification_state='failed',finished_at=now(),
               error_code=COALESCE(error_code,$2),
               failure_detail=CASE WHEN failure_detail='{}'::jsonb
                 THEN jsonb_build_object('errorName',$3::text) ELSE failure_detail END
           WHERE id=$1 AND state='queued'`,
          [
            request.operationId,
            error instanceof Error
              ? error.message.split(':', 1)[0]?.slice(0, 160)
              : 'backup-failed',
            error instanceof Error ? error.name : 'unknown',
          ],
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async startRestore(request: RuntimeRestoreRequest): Promise<void> {
    try {
      const restore = await this.#options.pool.query<{
        sidecar_path: string;
        product: BackupProduct;
      }>(
        `SELECT backup.sidecar_path,backup.product
         FROM noderag.restore_operation operation
         JOIN noderag.backup_operation backup ON backup.id=operation.backup_id
         WHERE operation.id=$1 AND operation.state='queued'
           AND backup.state='succeeded' AND backup.verification_state='verified'
           AND backup.sidecar_path IS NOT NULL`,
        [request.operationId],
      );
      const row = restore.rows[0];
      if (row === undefined) throw new Error('restore-operation-not-runnable');
      const mode = request.mode ?? 'full';
      if (row.product !== mode) throw new Error('restore-product-request-mismatch');
      const [server, dimensions, policy] = await Promise.all([
        this.#options.pool.query<{ major: number }>(
          `SELECT current_setting('server_version_num')::integer / 10000 AS major`,
        ),
        this.#options.pool.query<{ dimensions: number }>(
          `SELECT DISTINCT dimensions FROM noderag.model_manifest ORDER BY dimensions`,
        ),
        loadBackupClassification(),
      ]);
      const postgresMajor = Number(server.rows[0]?.major);
      const modelDimensions = dimensions.rows.map((entry) => Number(entry.dimensions));
      if (
        !Number.isSafeInteger(postgresMajor) ||
        modelDimensions.length === 0 ||
        modelDimensions.some((dimension) => !Number.isSafeInteger(dimension))
      )
        throw new Error('restore-target-preflight-invalid');
      const databaseTarget =
        mode === 'full'
          ? new PostgresFullRestoreTarget(this.#options.pool, policy, this.#options.secretVault)
          : new PostgresPortableImportTarget(
              this.#options.pool,
              policy,
              databaseInteger(request.destinationSiloId, 'portable destination silo'),
              databaseInteger(request.ownerPrincipalId, 'portable owner principal'),
            );
      await executeRestore({
        pool: this.#options.pool,
        operationId: request.operationId,
        sidecarPath: row.sidecar_path,
        passphrase: request.passphrase,
        confirmation: request.confirmation,
        ...(mode === 'portable' ? { expectedConfirmation: portableImportConfirmationPhrase } : {}),
        dataRoot: this.#options.dataRoot,
        compatibility: {
          supportedArchiveVersions: [1],
          migrationHead: CURRENT_SCHEMA_REVISION,
          postgresMajor,
          modelDimensions,
        },
        archivedModelDimensions: [1024],
        database: databaseTarget,
      });
    } catch (error) {
      await this.#options.pool
        .query(
          `UPDATE noderag.restore_operation
           SET state='failed',finished_at=now(),error_code=COALESCE(error_code,$2),
               failure_detail=CASE WHEN failure_detail='{}'::jsonb
                 THEN jsonb_build_object('errorName',$3::text) ELSE failure_detail END
           WHERE id=$1 AND state='queued'`,
          [
            request.operationId,
            error instanceof Error
              ? error.message.split(':', 1)[0]?.slice(0, 160)
              : 'restore-failed',
            error instanceof Error ? error.name : 'unknown',
          ],
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async #executeBackup(request: RuntimeBackupRequest): Promise<void> {
    const operation = await this.#options.pool.query<{
      managed_path: string;
      product: BackupProduct;
      include_models: boolean;
      chat_root: string | null;
    }>(
      `SELECT location.managed_path,operation.product,operation.include_models,
              (
                SELECT settings.storage_resolved_path
                FROM noderag.chat_configuration_current current
                JOIN noderag.chat_settings_revision settings
                  ON settings.id=current.settings_revision_id
                WHERE current.singleton=true
              ) AS chat_root
       FROM noderag.backup_operation operation
       JOIN noderag.storage_location location ON location.id=operation.destination_id
       WHERE operation.id=$1 AND operation.state='queued'
         AND location.enabled AND location.purpose='backup'`,
      [request.operationId],
    );
    const row = operation.rows[0];
    if (row === undefined) throw new Error('backup-operation-not-runnable');
    if (row.product !== request.product || row.include_models !== request.includeModels)
      throw new Error('backup-operation-request-mismatch');
    const connection = toolConnection(this.#options.database);
    const [server, logicalSize, clientMajor, policy] = await Promise.all([
      this.#options.pool.query<{ major: number }>(
        `SELECT current_setting('server_version_num')::integer / 10000 AS major`,
      ),
      this.#options.pool.query<{ bytes: string }>(
        `SELECT pg_database_size(current_database())::text AS bytes`,
      ),
      postgresToolMajor(this.#options.pgDumpExecutable),
      loadBackupClassification(),
    ]);
    const postgresMajor = Number(server.rows[0]?.major);
    const databaseBytes = Number(logicalSize.rows[0]?.bytes);
    if (!Number.isSafeInteger(postgresMajor) || !Number.isSafeInteger(databaseBytes))
      throw new Error('backup-database-preflight-invalid');
    await executeBackup({
      pool: this.#options.pool,
      operationId: request.operationId,
      product: request.product,
      destination: row.managed_path,
      passphrase: request.passphrase,
      dataRoot: this.#options.dataRoot,
      ...(row.chat_root === null ? {} : { chatRoot: row.chat_root }),
      policy,
      migrationHead: CURRENT_SCHEMA_REVISION,
      postgresMajor,
      postgresClientMajor: clientMajor,
      requiredFreeBytes: Math.ceil(databaseBytes * (request.includeModels ? 2.5 : 1.5)),
      nodeRagVersion: this.#options.nodeRagVersion,
      databaseDump: () => streamPgDump(connection, this.#options.pgDumpExecutable),
      secretExport: () => streamRecoverySecrets(this.#options.pool, this.#options.secretVault),
      includeModels: request.includeModels,
    });
  }
}
