import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeBackup } from '../src/recovery/backup.js';
import { SecretVault } from '../src/identity/secrets.js';
import { authenticatePassword, hashPassword } from '../src/identity/passwords.js';
import { verifyEncryptedArchive, type BackupInnerManifest } from '../src/recovery/archive.js';
import {
  enterMaintenance,
  recoverAbandonedMaintenance,
  releaseMaintenance,
  waitForMutationDrain,
} from '../src/recovery/maintenance.js';
import { loadBackupClassification } from '../src/recovery/policy.js';
import { processOneScheduledBackup } from '../src/recovery/schedule.js';
import {
  RecoveryRuntime,
  streamRecoverySecrets,
  type RuntimeBackupRequest,
} from '../src/recovery/runtime.js';
import {
  executeRestore,
  restoreConfirmationPhrase,
  type RestoreDatabaseTarget,
} from '../src/recovery/restore.js';
import { runMigrations } from '../src/store/migrations.js';
import { createChunkPartition } from '../src/store/silos.js';
import { executeUpgradeRehearsal, planUpgrade } from '../src/recovery/upgrade.js';
import { bootstrapFirstAdministrator, issueSetupToken } from '../src/setup/bootstrap.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

class StagingTarget implements RestoreDatabaseTarget {
  readonly rows = new Map<string, Readonly<Record<string, unknown>>[]>();
  dump = Buffer.alloc(0);
  activated = false;
  rolledBack = false;
  cleaned = false;
  prepared = false;

  constructor(
    private readonly secretConsumer?: (
      rows: readonly Readonly<Record<string, unknown>>[],
    ) => Promise<void>,
  ) {}

  async isBlank(): Promise<boolean> {
    return true;
  }

  async prepare(_operationId: number, _manifest: BackupInnerManifest): Promise<void> {
    this.prepared = true;
    this.rows.clear();
  }

  async consumeFullDump(content: AsyncIterable<Uint8Array>): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of content) chunks.push(Buffer.from(chunk));
    this.dump = Buffer.concat(chunks);
  }

  async consumePortableTable(
    table: string,
    rows: AsyncIterable<Readonly<Record<string, unknown>>>,
  ): Promise<void> {
    const collected: Readonly<Record<string, unknown>>[] = [];
    for await (const row of rows) collected.push(row);
    this.rows.set(table, collected);
  }

  async consumeSecrets(rows: AsyncIterable<Readonly<Record<string, unknown>>>): Promise<void> {
    const collected: Readonly<Record<string, unknown>>[] = [];
    for await (const row of rows) collected.push(row);
    this.rows.set('__secrets__', collected);
    await this.secretConsumer?.(collected);
  }

  async verify(manifest: BackupInnerManifest): Promise<Readonly<Record<string, unknown>>> {
    const expectedTables = manifest.entries.filter((entry) =>
      entry.path.startsWith('database/tables/'),
    ).length;
    const expectedSecretSets = manifest.entries.some(
      (entry) => entry.path === 'database/secrets.ndjson',
    )
      ? 1
      : 0;
    if (this.rows.size !== expectedTables + expectedSecretSets)
      throw new Error('restore-table-count-mismatch');
    if (manifest.product === 'full' && this.dump.byteLength === 0)
      throw new Error('restore-logical-dump-missing');
    return { tables: this.rows.size, dumpBytes: this.dump.byteLength };
  }

  async activate(): Promise<void> {
    this.activated = true;
  }

  async rollback(): Promise<void> {
    this.rolledBack = true;
  }

  async cleanup(_retainStaging: boolean): Promise<void> {
    this.cleaned = true;
  }
}

describe('Milestone 13 encrypted backup and staged restore', () => {
  let container: StartedPostgreSqlContainer;
  let targetContainer: StartedPostgreSqlContainer;
  let pool: Pool;
  let targetPool: Pool;
  let targetDatabase: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  let targetAdministratorId: number;
  let targetSiloId: number;
  let root: string;

  beforeAll(async () => {
    [container, targetContainer] = await Promise.all([
      new PostgreSqlContainer(postgresImage)
        .withDatabase('noderag_recovery')
        .withUsername('noderag')
        .withPassword('synthetic-recovery-test-password')
        .start(),
      new PostgreSqlContainer(postgresImage)
        .withDatabase('noderag_restored')
        .withUsername('noderag')
        .withPassword('synthetic-restored-test-password')
        .start(),
    ]);
    const database = {
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
    };
    await runMigrations(database);
    pool = new Pool(database);
    targetDatabase = {
      host: targetContainer.getHost(),
      port: targetContainer.getPort(),
      database: targetContainer.getDatabase(),
      user: targetContainer.getUsername(),
      password: targetContainer.getPassword(),
    };
    await runMigrations(targetDatabase);
    targetPool = new Pool(targetDatabase);
    const targetSetup = await bootstrapFirstAdministrator(targetPool, {
      setupToken: await issueSetupToken(targetPool),
      username: 'temporary-restore-administrator',
      password: 'M13-temporary-restore-password!',
    });
    targetAdministratorId = targetSetup.principalId;
    targetSiloId = targetSetup.defaultSilo.id;
    root = await mkdtemp(join(tmpdir(), 'noderag-m13-'));
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await targetPool.end();
    await container.stop();
    await targetContainer.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('backs up classified database/files and restores only after independent verification', async () => {
    const sourceRoot = join(root, 'source-data');
    const backupRoot = join(root, 'backups');
    const restoreRoot = join(root, 'restored-data');
    await mkdir(join(sourceRoot, 'documents', '000000', '101'), { recursive: true });
    await mkdir(backupRoot, { recursive: true });
    await mkdir(restoreRoot, { recursive: true });
    const markdown = '# Recovery proof\n\nStable document 101.\n';
    await writeFile(
      join(sourceRoot, 'documents', '000000', '101', 'canonical.md'),
      markdown,
      'utf8',
    );
    await pool.query(
      `INSERT INTO noderag.silo (id, slug, display_name) VALUES (7, 'recovery', 'Recovery')`,
    );
    await pool.query(
      `INSERT INTO noderag.principal (id,kind,label) VALUES (400,'user','Recovery secret owner')`,
    );
    await pool.query(
      `INSERT INTO noderag.app_user
         (principal_id,username,password_hash,server_admin,must_change)
       VALUES (400,'recovery-admin',$1,true,false)`,
      [await hashPassword('M13-restored-admin-password!')],
    );
    await createChunkPartition(pool, 7);
    const sourceVault = new SecretVault(Buffer.alloc(32, 0x41));
    await sourceVault.store(
      pool,
      'ollama',
      'm13-provider',
      'secret provider value only inside encrypted archive',
      400,
    );
    await pool.query(
      `INSERT INTO noderag.document
         (id,silo_id,name,extension,mime_type,byte_count,original_sha256,markdown_sha256,
          character_count,page_count,page_basis,state)
       VALUES (101,7,'recovery.md','md','text/markdown',$1,decode(repeat('11',32),'hex'),
               decode(repeat('22',32),'hex'),$2,1,'explicit','ready')`,
      [Buffer.byteLength(markdown), markdown.length],
    );
    await pool.query(
      `INSERT INTO noderag.build
         (id,state,target_chars,overlap_chars,max_tokens,snap_window,heading_prefix,
          rules_version,model_manifest_id,query_prefix,reason,chunk_count,completed_at,
          activated_at,profile_digest,model_digest,dimensions,activation_kind)
       SELECT 10,'active',2000,300,1024,0.150,true,1,id,query_prefix,
              'M13 restore search proof',1,now(),now(),repeat('a',64),manifest_digest,
              dimensions,'same_model'
       FROM noderag.model_manifest WHERE active`,
    );
    await pool.query(
      `INSERT INTO noderag.silo_build_state
         (silo_id,build_id,state,processed_documents,total_documents,activated_at)
       VALUES (7,10,'active',1,1,now())`,
    );
    await pool.query(
      `INSERT INTO noderag.chunk
         (id,silo_id,document_id,build_id,ordinal,text,character_start,character_end,
          byte_start,byte_end,embedding,token_count,chunk_sha256)
       VALUES (501,7,101,10,0,'Recovery searchable evidence',0,28,0,28,
               ('[1,' || repeat('0,',1022) || '0]')::halfvec,4,
               decode(repeat('33',32),'hex'))`,
    );
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO noderag.backup_operation (product) VALUES ('full') RETURNING id::text`,
    );
    const operationId = Number(operation.rows[0]?.id);
    const passphrase = 'synthetic archive passphrase';
    const written = await executeBackup({
      pool,
      operationId,
      product: 'full',
      destination: backupRoot,
      passphrase,
      dataRoot: sourceRoot,
      policy: await loadBackupClassification(),
      migrationHead: '000011_recovery_hardening',
      postgresMajor: 17,
      postgresClientMajor: 17,
      requiredFreeBytes: 1024 * 1024,
      nodeRagVersion: '0.2.0-test',
      databaseDump: async function* () {
        yield Buffer.from('PGDMP synthetic integration fixture', 'utf8');
      },
      secretExport: () => streamRecoverySecrets(pool, sourceVault),
      volumeBytes: 2048,
    });
    const backupState = await pool.query<{
      state: string;
      verification_state: string;
      manifest: { entries: { path: string }[] };
    }>(`SELECT state,verification_state,manifest FROM noderag.backup_operation WHERE id=$1`, [
      operationId,
    ]);
    expect(backupState.rows[0]?.state).toBe('succeeded');
    expect(backupState.rows[0]?.verification_state).toBe('verified');
    expect(backupState.rows[0]?.manifest.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        'database/logical.dump',
        'database/secrets.ndjson',
        'database/tables/document.ndjson',
        'documents/000000/101/canonical.md',
      ]),
    );
    const sidecar = JSON.parse(await readFile(written.sidecarPath, 'utf8')) as {
      volumes: { file: string }[];
    };
    const encryptedBytes = Buffer.concat(
      await Promise.all(sidecar.volumes.map((volume) => readFile(join(backupRoot, volume.file)))),
    );
    expect(encryptedBytes.includes(Buffer.from('secret provider value', 'utf8'))).toBe(false);

    const portableOperation = await pool.query<{ id: string }>(
      `INSERT INTO noderag.backup_operation (product) VALUES ('portable') RETURNING id::text`,
    );
    const portableId = Number(portableOperation.rows[0]?.id);
    const portable = await executeBackup({
      pool,
      operationId: portableId,
      product: 'portable',
      destination: backupRoot,
      passphrase,
      dataRoot: sourceRoot,
      policy: await loadBackupClassification(),
      migrationHead: '000011_recovery_hardening',
      postgresMajor: 17,
      postgresClientMajor: 17,
      requiredFreeBytes: 1024 * 1024,
      nodeRagVersion: '0.2.0-test',
    });
    let portableDocument = '';
    const portableVerified = await verifyEncryptedArchive(
      portable.sidecarPath,
      passphrase,
      async (header, content) => {
        const chunks: Buffer[] = [];
        for await (const chunk of content) chunks.push(Buffer.from(chunk));
        if (header.path === 'database/tables/document.ndjson')
          portableDocument = Buffer.concat(chunks).toString('utf8');
      },
    );
    const portablePaths = portableVerified.manifest.entries.map((entry) => entry.path);
    expect(portablePaths).toContain('database/tables/document.ndjson');
    expect(portablePaths).not.toContain('database/tables/principal.ndjson');
    expect(portablePaths).not.toContain('database/tables/encrypted_secret.ndjson');
    expect(portablePaths).not.toContain('database/tables/source.ndjson');
    expect(portableDocument).not.toContain('source_id');
    expect(portableDocument).not.toContain('uploaded_by');

    const targetVault = new SecretVault(Buffer.alloc(32, 0x43));
    const portableRestoreRoot = join(root, 'portable-restored-data');
    await mkdir(portableRestoreRoot, { recursive: true });
    const targetPortableBackup = await targetPool.query<{ id: string }>(
      `INSERT INTO noderag.backup_operation
         (state,verification_state,product,sidecar_path,manifest,finished_at)
       VALUES ('succeeded','verified','portable',$1,$2,now()) RETURNING id::text`,
      [portable.sidecarPath, portableVerified.manifest],
    );
    const portableRestore = await targetPool.query<{ id: string }>(
      `INSERT INTO noderag.restore_operation(backup_id)
       VALUES ($1) RETURNING id::text`,
      [Number(targetPortableBackup.rows[0]?.id)],
    );
    const portableRuntime = new RecoveryRuntime({
      pool: targetPool,
      database: targetDatabase,
      dataRoot: portableRestoreRoot,
      nodeRagVersion: '0.2.0-test',
      secretVault: targetVault,
    });
    await portableRuntime.startRestore({
      operationId: Number(portableRestore.rows[0]?.id),
      passphrase,
      confirmation: 'IMPORT PORTABLE CORPUS',
      mode: 'portable',
      destinationSiloId: targetSiloId,
      ownerPrincipalId: targetAdministratorId,
    });
    const imported = await targetPool.query<{
      silo_id: number;
      source_id: string | null;
      uploaded_by: string;
      job_state: string;
    }>(
      `SELECT document_record.silo_id,document_record.source_id::text,
              document_record.uploaded_by::text,
              (SELECT state FROM noderag.job
               WHERE document_id=document_record.id AND kind='embed') AS job_state
       FROM noderag.document document_record WHERE document_record.id=101`,
    );
    expect(imported.rows[0]).toEqual({
      silo_id: targetSiloId,
      source_id: null,
      uploaded_by: String(targetAdministratorId),
      job_state: 'pending',
    });
    expect(
      await readFile(
        join(portableRestoreRoot, 'documents', '000000', '101', 'canonical.md'),
        'utf8',
      ),
    ).toBe(markdown);
    expect(
      await authenticatePassword(targetPool, {
        username: 'temporary-restore-administrator',
        password: 'M13-temporary-restore-password!',
        requestId: 'm13-portable-owner-authentication',
      }),
    ).toMatchObject({ ok: true, principalId: targetAdministratorId, serverAdmin: true });
    await targetPool.query(`DELETE FROM noderag.document WHERE id=101`);

    const sourceCiphertext = await pool.query<{ ciphertext: string }>(
      `SELECT encode(ciphertext,'hex') AS ciphertext
       FROM noderag.encrypted_secret WHERE provider='ollama' AND name='m13-provider'`,
    );
    await pool.query(
      `DELETE FROM noderag.encrypted_secret WHERE provider='ollama' AND name='m13-provider'`,
    );

    const rejectedRestore = await pool.query<{ id: string }>(
      `INSERT INTO noderag.restore_operation (backup_id) VALUES ($1) RETURNING id::text`,
      [operationId],
    );
    const untouchedTarget = new StagingTarget();
    await expect(
      executeRestore({
        pool,
        operationId: Number(rejectedRestore.rows[0]?.id),
        sidecarPath: written.sidecarPath,
        passphrase: 'incorrect archive passphrase',
        confirmation: restoreConfirmationPhrase,
        dataRoot: restoreRoot,
        compatibility: {
          supportedArchiveVersions: [1],
          migrationHead: '000011_recovery_hardening',
          postgresMajor: 17,
          modelDimensions: [1024],
        },
        database: untouchedTarget,
      }),
    ).rejects.toThrow('backup-passphrase-mismatch');
    expect(untouchedTarget.prepared).toBe(false);

    const restore = await pool.query<{ id: string }>(
      `INSERT INTO noderag.restore_operation (backup_id) VALUES ($1) RETURNING id::text`,
      [operationId],
    );
    const destinationVault = new SecretVault(Buffer.alloc(32, 0x42));
    const target = new StagingTarget(async (rows) => {
      for (const row of rows) {
        if (
          typeof row['provider'] !== 'string' ||
          typeof row['name'] !== 'string' ||
          typeof row['value'] !== 'string'
        )
          throw new Error('restored-secret-invalid');
        await destinationVault.store(pool, row['provider'], row['name'], row['value'], 400);
      }
    });
    const inspection = await executeRestore({
      pool,
      operationId: Number(restore.rows[0]?.id),
      sidecarPath: written.sidecarPath,
      passphrase,
      confirmation: restoreConfirmationPhrase,
      dataRoot: restoreRoot,
      compatibility: {
        supportedArchiveVersions: [1],
        migrationHead: '000011_recovery_hardening',
        postgresMajor: 17,
        modelDimensions: [1024],
      },
      database: target,
    });
    expect(inspection.product).toBe('full');
    expect(target.activated).toBe(true);
    expect(target.rolledBack).toBe(false);
    expect(target.cleaned).toBe(true);
    expect(target.rows.get('document')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 101, silo_id: 7 })]),
    );
    expect(target.rows.get('__secrets__')).toEqual([
      {
        sourceId: expect.any(Number),
        provider: 'ollama',
        name: 'm13-provider',
        value: 'secret provider value only inside encrypted archive',
      },
    ]);
    expect(await destinationVault.reveal(pool, 'ollama', 'm13-provider')).toBe(
      'secret provider value only inside encrypted archive',
    );
    const destinationCiphertext = await pool.query<{ ciphertext: string }>(
      `SELECT encode(ciphertext,'hex') AS ciphertext
       FROM noderag.encrypted_secret WHERE provider='ollama' AND name='m13-provider'`,
    );
    expect(destinationCiphertext.rows[0]?.ciphertext).not.toBe(
      sourceCiphertext.rows[0]?.ciphertext,
    );
    expect(
      await readFile(join(restoreRoot, 'documents', '000000', '101', 'canonical.md'), 'utf8'),
    ).toBe(markdown);
    const barrier = await pool.query<{ state: string }>(
      `SELECT state FROM noderag.maintenance_barrier WHERE id=true`,
    );
    expect(barrier.rows[0]?.state).toBe('inactive');

    const postgresRestoreRoot = join(root, 'postgres-restored-data');
    await mkdir(postgresRestoreRoot, { recursive: true });
    const targetBackup = await targetPool.query<{ id: string }>(
      `INSERT INTO noderag.backup_operation
         (state,verification_state,product,sidecar_path,manifest,finished_at)
       VALUES ('succeeded','verified','full',$1,$2,now()) RETURNING id::text`,
      [written.sidecarPath, backupState.rows[0]?.manifest],
    );
    const postgresRestore = await targetPool.query<{ id: string }>(
      `INSERT INTO noderag.restore_operation (backup_id)
       VALUES ($1) RETURNING id::text`,
      [Number(targetBackup.rows[0]?.id)],
    );
    const runtime = new RecoveryRuntime({
      pool: targetPool,
      database: targetDatabase,
      dataRoot: postgresRestoreRoot,
      nodeRagVersion: '0.2.0-test',
      secretVault: targetVault,
    });
    await runtime.startRestore({
      operationId: Number(postgresRestore.rows[0]?.id),
      passphrase,
      confirmation: restoreConfirmationPhrase,
    });
    const runtimeRestore = await targetPool.query<{ state: string }>(
      `SELECT state FROM noderag.restore_operation WHERE id=$1`,
      [Number(postgresRestore.rows[0]?.id)],
    );
    expect(runtimeRestore.rows[0]?.state).toBe('succeeded');
    expect(
      await authenticatePassword(targetPool, {
        username: 'recovery-admin',
        password: 'M13-restored-admin-password!',
        requestId: 'm13-restore-authentication',
      }),
    ).toMatchObject({ ok: true, principalId: 400, serverAdmin: true });
    const targetConnection = await targetPool.connect();
    try {
      await targetConnection.query(`SELECT set_config('app.silo_ids','{7}',false)`);
      const searchable = await targetConnection.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM noderag.chunk
         WHERE search_vector @@ plainto_tsquery('simple','searchable evidence')`,
      );
      expect(searchable.rows[0]?.count).toBe('1');
    } finally {
      targetConnection.release();
    }
    expect(await targetVault.reveal(targetPool, 'ollama', 'm13-provider')).toBe(
      'secret provider value only inside encrypted archive',
    );
    const restoredSettings = await targetPool.query<{
      vision_enabled: boolean;
      ollama_base_url: string | null;
      state: string;
    }>(
      `SELECT settings.vision_enabled,settings.ollama_base_url,setup.state
       FROM noderag.settings settings CROSS JOIN noderag.setup_state setup
       WHERE settings.id=1 AND setup.id=1`,
    );
    expect(restoredSettings.rows[0]).toEqual({
      vision_enabled: false,
      ollama_base_url: null,
      state: 'operational',
    });
  }, 120_000);

  it('fails closed on a drain timeout and repairs an abandoned barrier at startup', async () => {
    const job = await pool.query<{ id: string }>(
      `INSERT INTO noderag.job (kind,state,lease_owner,leased_until)
       VALUES ('crawl','leased','fault-test',now()+interval '5 minutes') RETURNING id::text`,
    );
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO noderag.backup_operation DEFAULT VALUES RETURNING id::text`,
    );
    const operationId = Number(operation.rows[0]?.id);
    const lease = await enterMaintenance(pool, 'backup', operationId);
    await expect(waitForMutationDrain(pool, lease, 25)).rejects.toThrow(
      'maintenance-drain-timeout',
    );
    await releaseMaintenance(pool, lease);
    await pool.query(`UPDATE noderag.job SET state='failed',finished_at=now() WHERE id=$1`, [
      Number(job.rows[0]?.id),
    ]);

    await enterMaintenance(pool, 'backup', operationId);
    expect(await recoverAbandonedMaintenance(pool)).toBe(1);
    const repaired = await pool.query<{ operation_state: string; barrier_state: string }>(
      `SELECT operation.state AS operation_state,barrier.state AS barrier_state
       FROM noderag.backup_operation operation CROSS JOIN noderag.maintenance_barrier barrier
       WHERE operation.id=$1 AND barrier.id=true`,
      [operationId],
    );
    expect(repaired.rows[0]).toEqual({ operation_state: 'failed', barrier_state: 'inactive' });

    const audit = await pool.query<{ id: string }>(
      `INSERT INTO noderag.audit_log (action,result) VALUES ('m13-fault-proof','ok') RETURNING id::text`,
    );
    await expect(
      pool.query(`UPDATE noderag.audit_log SET action='tampered' WHERE id=$1`, [
        Number(audit.rows[0]?.id),
      ]),
    ).rejects.toThrow('audit_log is append-only');
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(`SELECT set_config('app.restore_mode','on',true)`);
      await connection.query(`DELETE FROM noderag.audit_log WHERE id=$1`, [
        Number(audit.rows[0]?.id),
      ]);
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }

    const scheduleRoot = join(root, 'scheduled-backups');
    await mkdir(scheduleRoot, { recursive: true });
    await pool.query(
      `INSERT INTO noderag.principal (id,kind,label) VALUES (500,'user','Scheduled backup owner')`,
    );
    const location = await pool.query<{ id: number }>(
      `INSERT INTO noderag.storage_location (name,managed_path,purpose,created_by)
       VALUES ('m13-scheduled',$1,'backup',500) RETURNING id`,
      [scheduleRoot],
    );
    const vault = new SecretVault(Buffer.alloc(32, 0x5a));
    const secret = await vault.store(
      pool,
      'backup-schedule',
      'schedule:m13-daily',
      'scheduled synthetic passphrase',
      500,
    );
    await pool.query(
      `INSERT INTO noderag.backup_schedule
         (name,product,destination_id,cadence,utc_hour,utc_minute,enabled,
          secret_name,secret_fingerprint,next_run_at,created_by)
       VALUES ('m13-daily','full',$1,'daily',2,15,true,
               'schedule:m13-daily',$2,now()-interval '1 minute',500)`,
      [location.rows[0]?.id, secret.fingerprint],
    );
    let scheduledRequest: RuntimeBackupRequest | undefined;
    expect(
      await processOneScheduledBackup(pool, vault, async (request) => {
        scheduledRequest = request;
        await pool.query(
          `UPDATE noderag.backup_operation
           SET state='succeeded',verification_state='verified',finished_at=now()
           WHERE id=$1`,
          [request.operationId],
        );
      }),
    ).toBe(true);
    expect(scheduledRequest).toMatchObject({
      product: 'full',
      passphrase: 'scheduled synthetic passphrase',
      includeModels: false,
    });
    const schedule = await pool.query<{
      last_result: string;
      next_run_at: Date;
      secret_fingerprint: string;
    }>(
      `SELECT last_result,next_run_at,secret_fingerprint
       FROM noderag.backup_schedule WHERE name='m13-daily'`,
    );
    expect(schedule.rows[0]?.last_result).toBe('succeeded');
    expect(schedule.rows[0]?.next_run_at.getTime()).toBeGreaterThan(Date.now());
    expect(schedule.rows[0]?.secret_fingerprint).toBe(secret.fingerprint);
    const stored = await pool.query<{ plaintext_present: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM noderag.encrypted_secret
         WHERE position(
           encode(convert_to('scheduled synthetic passphrase','UTF8'),'hex')
           IN encode(ciphertext,'hex')
         ) > 0
       ) AS plaintext_present`,
    );
    expect(stored.rows[0]?.plaintext_present).toBe(false);
  }, 120_000);

  it('rehearses successful major upgrades and rolls back failed verification', async () => {
    const safetyBackup = await pool.query<{ id: string }>(
      `INSERT INTO noderag.backup_operation(state,verification_state,finished_at)
       VALUES ('succeeded','verified',now()) RETURNING id::text`,
    );
    const successful = await pool.query<{ id: string }>(
      `INSERT INTO noderag.upgrade_rehearsal
         (from_version,to_version,from_postgres_major,to_postgres_major,
          migration_head,required_free_bytes)
       VALUES ('1.0.0','1.1.0',16,17,'000011_recovery_hardening',2000)
       RETURNING id::text`,
    );
    const calls: string[] = [];
    await executeUpgradeRehearsal({
      pool,
      operationId: Number(successful.rows[0]?.id),
      plan: planUpgrade(16, 17, 1000),
      measuredFreeBytes: 2500,
      expectedMigrationHead: '000011_recovery_hardening',
      driver: {
        createSafetyBackup: async () => {
          calls.push('backup');
          return Number(safetyBackup.rows[0]?.id);
        },
        applyForwardMigrations: async () => {
          calls.push('migrate');
        },
        initializeNewCluster: async () => {
          calls.push('initialize');
        },
        restoreLogicalDump: async () => {
          calls.push('restore');
        },
        verify: async () => {
          calls.push('verify');
          return { migrationHead: '000011_recovery_hardening', rows: 1 };
        },
        activate: async () => {
          calls.push('activate');
        },
        rollback: async () => {
          calls.push('rollback');
        },
        retainPreviousState: async () => {
          calls.push('retain');
        },
      },
    });
    expect(calls).toEqual(['backup', 'initialize', 'restore', 'verify', 'activate', 'retain']);
    const successfulState = await pool.query<{ state: string; safety_backup_id: string }>(
      `SELECT state,safety_backup_id::text FROM noderag.upgrade_rehearsal WHERE id=$1`,
      [Number(successful.rows[0]?.id)],
    );
    expect(successfulState.rows[0]).toEqual({
      state: 'succeeded',
      safety_backup_id: safetyBackup.rows[0]?.id,
    });

    const failed = await pool.query<{ id: string }>(
      `INSERT INTO noderag.upgrade_rehearsal
         (from_version,to_version,from_postgres_major,to_postgres_major,
          migration_head,required_free_bytes)
       VALUES ('1.0.0','1.0.1',17,17,'000011_recovery_hardening',1000)
       RETURNING id::text`,
    );
    let rolledBack = false;
    await expect(
      executeUpgradeRehearsal({
        pool,
        operationId: Number(failed.rows[0]?.id),
        plan: planUpgrade(17, 17, 1000),
        measuredFreeBytes: 1000,
        expectedMigrationHead: '000011_recovery_hardening',
        driver: {
          createSafetyBackup: async () => Number(safetyBackup.rows[0]?.id),
          applyForwardMigrations: async () => undefined,
          initializeNewCluster: async () => undefined,
          restoreLogicalDump: async () => undefined,
          verify: async () => ({ migrationHead: 'unexpected-head' }),
          activate: async () => undefined,
          rollback: async () => {
            rolledBack = true;
          },
          retainPreviousState: async () => undefined,
        },
      }),
    ).rejects.toThrow('upgrade-migration-head-mismatch');
    expect(rolledBack).toBe(true);
    const failedState = await pool.query<{ state: string; code: string }>(
      `SELECT state,failure_detail->>'code' AS code
       FROM noderag.upgrade_rehearsal WHERE id=$1`,
      [Number(failed.rows[0]?.id)],
    );
    expect(failedState.rows[0]).toEqual({
      state: 'rolled_back',
      code: 'upgrade-migration-head-mismatch',
    });
    const barrier = await pool.query<{ state: string }>(
      `SELECT state FROM noderag.maintenance_barrier WHERE id=true`,
    );
    expect(barrier.rows[0]?.state).toBe('inactive');
  }, 120_000);
});
