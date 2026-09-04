import type { Pool, PoolClient } from 'pg';
import type { SecretVault } from '../identity/secrets.js';
import { createChunkPartition } from '../store/silos.js';
import { databaseInteger, withTransaction } from '../store/database.js';
import type { BackupDataClass, BackupInnerManifest } from './archive.js';
import type { BackupClassificationPolicy } from './policy.js';
import { includedTables } from './policy.js';
import { resetInstallationLocalState, type RestoreDatabaseTarget } from './restore.js';

interface LogicalSecret {
  readonly sourceId: number;
  readonly provider: string;
  readonly name: string;
  readonly value: string;
}

const safeIdentifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error('restore-identifier-invalid');
  return value;
};

const entryTable = (path: string): string | null =>
  /^database\/tables\/([a-z][a-z0-9_]*)\.ndjson$/u.exec(path)?.[1] ?? null;

const policyDataClass = (value: string): BackupDataClass => {
  if (
    value === 'source-of-truth' ||
    value === 'behavioral-provenance' ||
    value === 'derived' ||
    value === 'secrets' ||
    value === 'security-history'
  )
    return value;
  throw new Error('restore-excluded-data-class');
};

const validatePolicyEntry = (
  policy: BackupClassificationPolicy,
  product: 'full' | 'portable',
  path: string,
  dataClass: BackupDataClass,
): void => {
  const table = entryTable(path);
  if (table !== null) {
    const rule = policy.tables.find((entry) => entry.table === table);
    if (rule === undefined || rule[product] === 'exclude')
      throw new Error('restore-table-not-permitted');
    if (policyDataClass(rule.class) !== dataClass) throw new Error('restore-data-class-mismatch');
    return;
  }
  if (/^documents\/\d{6}\/\d+\//u.test(path)) {
    if (dataClass !== 'source-of-truth') throw new Error('restore-data-class-mismatch');
    return;
  }
  if (product === 'full' && /^models\//u.test(path)) {
    if (dataClass !== 'derived') throw new Error('restore-data-class-mismatch');
    return;
  }
  if (product === 'full' && path === 'database/logical.dump') {
    if (dataClass !== 'source-of-truth') throw new Error('restore-data-class-mismatch');
    return;
  }
  if (product === 'full' && path === 'database/secrets.ndjson') {
    if (dataClass !== 'secrets') throw new Error('restore-data-class-mismatch');
    return;
  }
  throw new Error('restore-entry-not-permitted');
};

const topologicalTables = async (
  database: PoolClient,
  tables: ReadonlySet<string>,
  policyOrder: readonly string[],
): Promise<readonly string[]> => {
  const relationships = await database.query<{ child: string; parent: string }>(
    `SELECT child.relname AS child,parent.relname AS parent
     FROM pg_constraint constraint_record
     JOIN pg_class child ON child.oid=constraint_record.conrelid
     JOIN pg_namespace child_schema ON child_schema.oid=child.relnamespace
     JOIN pg_class parent ON parent.oid=constraint_record.confrelid
     JOIN pg_namespace parent_schema ON parent_schema.oid=parent.relnamespace
     WHERE constraint_record.contype='f'
       AND child_schema.nspname='noderag' AND parent_schema.nspname='noderag'`,
  );
  const dependencies = new Map([...tables].map((table) => [table, new Set<string>()] as const));
  for (const relation of relationships.rows) {
    if (
      relation.child !== relation.parent &&
      tables.has(relation.child) &&
      tables.has(relation.parent)
    )
      dependencies.get(relation.child)?.add(relation.parent);
  }
  const order: string[] = [];
  while (order.length < tables.size) {
    const ready = policyOrder.find(
      (table) =>
        tables.has(table) &&
        !order.includes(table) &&
        [...(dependencies.get(table) ?? [])].every((dependency) => order.includes(dependency)),
    );
    if (ready === undefined) throw new Error('restore-table-dependency-cycle');
    order.push(ready);
  }
  return order;
};

export class PostgresFullRestoreTarget implements RestoreDatabaseTarget {
  readonly resetInstallationLocalState = false;
  readonly commitsOperationState = true;
  readonly #pool: Pool;
  readonly #policy: BackupClassificationPolicy;
  readonly #secretVault: SecretVault;
  #schema = '';
  #tables = new Set<string>();
  #order: readonly string[] = [];
  #rows = new Map<string, number>();
  #secrets: LogicalSecret[] = [];
  #dumpPrefix = Buffer.alloc(0);

  constructor(pool: Pool, policy: BackupClassificationPolicy, secretVault: SecretVault) {
    this.#pool = pool;
    this.#policy = policy;
    this.#secretVault = secretVault;
  }

  validateEntry(path: string, dataClass: BackupDataClass): void {
    validatePolicyEntry(this.#policy, 'full', path, dataClass);
  }

  async isBlank(): Promise<boolean> {
    const result = await this.#pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM noderag.document`,
    );
    return Number(result.rows[0]?.count ?? '1') === 0;
  }

  async prepare(operationId: number, manifest: BackupInnerManifest): Promise<void> {
    if (manifest.product !== 'full') throw new Error('portable-restore-target-required');
    this.#schema = safeIdentifier(`noderag_restore_${String(operationId)}`);
    this.#tables = new Set(
      manifest.entries.flatMap((entry) => {
        const table = entryTable(entry.path);
        return table === null ? [] : [safeIdentifier(table)];
      }),
    );
    const permitted = new Set(includedTables(this.#policy, 'full').map((entry) => entry.table));
    const unexpected = [...this.#tables].filter((table) => !permitted.has(table));
    if (unexpected.length > 0)
      throw new Error(`restore-table-not-permitted:${unexpected.join(',')}`);
    await withTransaction(this.#pool, async (database) => {
      await database.query(`DROP SCHEMA IF EXISTS ${this.#schema} CASCADE`);
      await database.query(`CREATE SCHEMA ${this.#schema}`);
      for (const table of this.#tables)
        await database.query(
          `CREATE UNLOGGED TABLE ${this.#schema}.${table} (LIKE noderag.${table} INCLUDING ALL)`,
        );
      this.#order = await topologicalTables(
        database,
        this.#tables,
        this.#policy.tables.map((entry) => entry.table),
      );
    });
  }

  async consumeFullDump(content: AsyncIterable<Uint8Array>): Promise<void> {
    for await (const chunk of content) {
      if (this.#dumpPrefix.byteLength < 5)
        this.#dumpPrefix = Buffer.concat([this.#dumpPrefix, Buffer.from(chunk)]).subarray(0, 5);
    }
    if (this.#dumpPrefix.toString('ascii') !== 'PGDMP')
      throw new Error('restore-logical-dump-invalid');
  }

  async consumePortableTable(
    tableValue: string,
    rows: AsyncIterable<Readonly<Record<string, unknown>>>,
  ): Promise<void> {
    const table = safeIdentifier(tableValue);
    if (!this.#tables.has(table)) throw new Error('restore-table-not-staged');
    const columns = await this.#pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='noderag' AND table_name=$1
         AND is_generated='NEVER' AND is_identity='NO'
       ORDER BY ordinal_position`,
      [table],
    );
    const names = columns.rows.map((column) => safeIdentifier(column.column_name));
    const list = names.join(',');
    let count = 0;
    let batch: Readonly<Record<string, unknown>>[] = [];
    const insert = async (): Promise<void> => {
      if (batch.length === 0) return;
      await this.#pool.query(
        `INSERT INTO ${this.#schema}.${table} (${list})
         SELECT ${list} FROM jsonb_populate_recordset(NULL::noderag.${table},$1::jsonb)`,
        [JSON.stringify(batch)],
      );
      count += batch.length;
      batch = [];
    };
    for await (const row of rows) {
      batch.push(row);
      if (batch.length === 100) await insert();
    }
    await insert();
    this.#rows.set(table, count);
  }

  async consumeSecrets(rows: AsyncIterable<Readonly<Record<string, unknown>>>): Promise<void> {
    this.#secrets = [];
    for await (const row of rows) {
      if (
        !Number.isSafeInteger(row['sourceId']) ||
        typeof row['provider'] !== 'string' ||
        typeof row['name'] !== 'string' ||
        typeof row['value'] !== 'string'
      )
        throw new Error('restored-secret-invalid');
      this.#secrets.push({
        sourceId: row['sourceId'] as number,
        provider: row['provider'],
        name: row['name'],
        value: row['value'],
      });
    }
  }

  async verify(manifest: BackupInnerManifest): Promise<Readonly<Record<string, unknown>>> {
    if (this.#dumpPrefix.toString('ascii') !== 'PGDMP')
      throw new Error('restore-logical-dump-missing');
    const relationships: Array<readonly [string, string]> = [
      ['document', 'silo'],
      ['document_page', 'document'],
      ['document_image', 'document'],
      ['build', 'model_manifest'],
      ['silo_build_state', 'build'],
    ];
    let brokenRelationships = 0;
    for (const [child, parent] of relationships) {
      if (!this.#tables.has(child) || !this.#tables.has(parent)) continue;
      const childColumns =
        child === 'document_page' || child === 'document_image' ? ['document_id'] : [];
      if (childColumns.length === 0) continue;
      const invalid = await this.#pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${this.#schema}.${child} child
         LEFT JOIN ${this.#schema}.${parent} parent ON parent.id=child.document_id
         WHERE parent.id IS NULL`,
      );
      brokenRelationships += Number(invalid.rows[0]?.count ?? '0');
    }
    if (brokenRelationships !== 0) throw new Error('restore-relationship-verification-failed');
    for (const [table, expected] of this.#rows) {
      const actual = await this.#pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${this.#schema}.${safeIdentifier(table)}`,
      );
      if (Number(actual.rows[0]?.count ?? '-1') !== expected)
        throw new Error(`restore-row-count-mismatch:${table}`);
    }
    return {
      product: manifest.product,
      tables: this.#rows.size,
      rows: [...this.#rows.values()].reduce((total, value) => total + value, 0),
      secrets: this.#secrets.length,
      brokenRelationships,
    };
  }

  async activate(
    operationId: number,
    verification: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await withTransaction(this.#pool, async (database) => {
      await database.query(`SELECT set_config('app.restore_mode','on',true)`);
      const siloIds = this.#tables.has('silo')
        ? await database.query<{ id: number }>(`SELECT id FROM ${this.#schema}.silo ORDER BY id`)
        : { rows: [] };
      await database.query(`SELECT set_config('app.silo_ids',$1,true)`, [
        `{${siloIds.rows.map((row) => String(row.id)).join(',')}}`,
      ]);
      const excludedForeignKeys = await database.query<{
        child: string;
        column_name: string;
        nullable: boolean;
      }>(
        `SELECT child.relname AS child,child_column.attname AS column_name,
                NOT child_column.attnotnull AS nullable
         FROM pg_constraint constraint_record
         JOIN pg_class child ON child.oid=constraint_record.conrelid
         JOIN pg_namespace child_schema ON child_schema.oid=child.relnamespace
         JOIN pg_class parent ON parent.oid=constraint_record.confrelid
         JOIN pg_namespace parent_schema ON parent_schema.oid=parent.relnamespace
         JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY key(attnum,ordinality) ON true
         JOIN pg_attribute child_column
           ON child_column.attrelid=child.oid AND child_column.attnum=key.attnum
         WHERE constraint_record.contype='f'
           AND child_schema.nspname='noderag' AND parent_schema.nspname='noderag'
           AND child.relname=ANY($1::text[]) AND NOT (parent.relname=ANY($1::text[]))`,
        [[...this.#tables]],
      );
      if (excludedForeignKeys.rows.some((row) => !row.nullable))
        throw new Error('restore-required-reference-excluded');
      const omitted = new Map<string, Set<string>>();
      for (const row of excludedForeignKeys.rows) {
        const columns = omitted.get(row.child) ?? new Set<string>();
        columns.add(row.column_name);
        omitted.set(row.child, columns);
      }
      const localReferences = await database.query<{
        child: string;
        column_name: string;
        nullable: boolean;
        delete_action: string;
      }>(
        `SELECT child.relname AS child,child_column.attname AS column_name,
                NOT child_column.attnotnull AS nullable,
                constraint_record.confdeltype AS delete_action
         FROM pg_constraint constraint_record
         JOIN pg_class child ON child.oid=constraint_record.conrelid
         JOIN pg_namespace child_schema ON child_schema.oid=child.relnamespace
         JOIN pg_class parent ON parent.oid=constraint_record.confrelid
         JOIN pg_namespace parent_schema ON parent_schema.oid=parent.relnamespace
         JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY key(attnum,ordinality) ON true
         JOIN pg_attribute child_column
           ON child_column.attrelid=child.oid AND child_column.attnum=key.attnum
         WHERE constraint_record.contype='f'
           AND array_length(constraint_record.conkey,1)=1
           AND child_schema.nspname='noderag' AND parent_schema.nspname='noderag'
           AND NOT (child.relname=ANY($1::text[])) AND parent.relname=ANY($1::text[])`,
        [[...this.#tables]],
      );
      const blocking = localReferences.rows.filter(
        (row) => !row.nullable && row.delete_action === 'a',
      );
      for (const child of new Set(blocking.map((row) => safeIdentifier(row.child))))
        await database.query(`DELETE FROM noderag.${child}`);
      for (const reference of localReferences.rows) {
        if (!reference.nullable || reference.delete_action !== 'a') continue;
        await database.query(
          `UPDATE noderag.${safeIdentifier(reference.child)}
           SET ${safeIdentifier(reference.column_name)}=NULL
           WHERE ${safeIdentifier(reference.column_name)} IS NOT NULL`,
        );
      }
      for (const table of [...this.#order].reverse())
        await database.query(`DELETE FROM noderag.${safeIdentifier(table)}`);
      await database.query(`DELETE FROM noderag.encrypted_secret`);
      for (const table of this.#order) {
        const columns = await database.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='noderag' AND table_name=$1
             AND is_generated='NEVER' AND is_identity='NO'
           ORDER BY ordinal_position`,
          [table],
        );
        const names = columns.rows
          .map((column) => safeIdentifier(column.column_name))
          .filter((column) => !(omitted.get(table)?.has(column) ?? false));
        if (table === 'chunk')
          for (const silo of siloIds.rows) {
            const exists = await database.query<{ exists: boolean }>(
              `SELECT to_regclass($1) IS NOT NULL AS exists`,
              [`noderag.chunk_s${String(silo.id)}`],
            );
            if (exists.rows[0]?.exists !== true) await createChunkPartition(database, silo.id);
          }
        const list = names.join(',');
        await database.query(
          `INSERT INTO noderag.${safeIdentifier(table)} (${list})
           SELECT ${list} FROM ${this.#schema}.${safeIdentifier(table)}`,
        );
      }
      const administrator = await database.query<{ principal_id: unknown }>(
        `SELECT principal_id FROM noderag.app_user
         WHERE server_admin ORDER BY principal_id LIMIT 1`,
      );
      const administratorId = databaseInteger(
        administrator.rows[0]?.principal_id,
        'restored administrator id',
      );
      const secretIds = new Map<number, number>();
      for (const secret of this.#secrets) {
        await this.#secretVault.store(
          database,
          secret.provider,
          secret.name,
          secret.value,
          administratorId,
        );
        const created = await database.query<{ id: unknown }>(
          `SELECT id FROM noderag.encrypted_secret WHERE provider=$1 AND name=$2`,
          [secret.provider, secret.name],
        );
        secretIds.set(secret.sourceId, databaseInteger(created.rows[0]?.id, 'restored secret id'));
      }
      if (this.#tables.has('settings')) {
        const source = await database.query<{ ollama_secret_id: unknown }>(
          `SELECT ollama_secret_id FROM ${this.#schema}.settings WHERE id=1`,
        );
        const sourceId = source.rows[0]?.ollama_secret_id;
        const destinationId =
          sourceId === null || sourceId === undefined
            ? null
            : secretIds.get(databaseInteger(sourceId, 'source secret id'));
        if (sourceId !== null && sourceId !== undefined && destinationId === undefined)
          throw new Error('restore-secret-reference-missing');
        await database.query(
          `UPDATE noderag.settings
           SET ollama_secret_id=$1,vision_enabled=false,ollama_base_url=NULL,updated_at=now()`,
          [destinationId ?? null],
        );
      }
      await database.query(`UPDATE noderag.source SET schedule_enabled=false,next_crawl_at=NULL`);
      await database.query(
        `UPDATE noderag.setup_state
         SET state='operational',setup_token_sha256=NULL,setup_token_issued_at=NULL,
             setup_token_expires_at=NULL,configured_at=now(),configured_by=$1,
             last_error=NULL,setup_step='sign-in',setup_progress=100,updated_at=now()
         WHERE id=1`,
        [administratorId],
      );
      for (const table of this.#order) {
        const sequence = await database.query<{ sequence: string | null }>(
          `SELECT pg_get_serial_sequence(format('%I.%I','noderag',$1::text),'id') AS sequence
           FROM information_schema.columns
           WHERE table_schema='noderag' AND table_name=$1::text AND column_name='id'`,
          [table],
        );
        if (typeof sequence.rows[0]?.sequence === 'string')
          await database.query(
            `SELECT setval($1::regclass,GREATEST(COALESCE((SELECT max(id) FROM noderag.${safeIdentifier(
              table,
            )}),1),1),(SELECT count(*)>0 FROM noderag.${safeIdentifier(table)}))`,
            [sequence.rows[0]?.sequence],
          );
      }
      await resetInstallationLocalState(database);
      const completed = await database.query(
        `UPDATE noderag.restore_operation
         SET state='succeeded',verification=$2,activated_at=now(),finished_at=now()
         WHERE id=$1`,
        [operationId, verification],
      );
      if (completed.rowCount !== 1) throw new Error('restore-operation-missing');
    });
    this.#secrets = [];
  }

  async rollback(): Promise<void> {
    this.#secrets = [];
  }

  async cleanup(retainStaging: boolean): Promise<void> {
    if (!retainStaging && this.#schema !== '')
      await this.#pool.query(`DROP SCHEMA IF EXISTS ${this.#schema} CASCADE`);
  }
}

export class PostgresPortableImportTarget implements RestoreDatabaseTarget {
  readonly fileActivationMode = 'merge' as const;
  readonly resetInstallationLocalState = false;
  readonly commitsOperationState = true;
  readonly #pool: Pool;
  readonly #policy: BackupClassificationPolicy;
  readonly #destinationSiloId: number;
  readonly #ownerPrincipalId: number;
  #schema = '';
  #tables = new Set<string>();
  #rows = new Map<string, number>();

  constructor(
    pool: Pool,
    policy: BackupClassificationPolicy,
    destinationSiloId: number,
    ownerPrincipalId: number,
  ) {
    if (
      !Number.isSafeInteger(destinationSiloId) ||
      destinationSiloId < 1 ||
      destinationSiloId > 32_767 ||
      !Number.isSafeInteger(ownerPrincipalId) ||
      ownerPrincipalId < 1
    )
      throw new Error('portable-import-target-invalid');
    this.#pool = pool;
    this.#policy = policy;
    this.#destinationSiloId = destinationSiloId;
    this.#ownerPrincipalId = ownerPrincipalId;
  }

  validateEntry(path: string, dataClass: BackupDataClass): void {
    validatePolicyEntry(this.#policy, 'portable', path, dataClass);
  }

  async isBlank(): Promise<boolean> {
    const result = await this.#pool.query<{
      silo_exists: boolean;
      owner_is_admin: boolean;
      document_count: string;
    }>(
      `SELECT
         EXISTS(SELECT 1 FROM noderag.silo WHERE id=$1) AS silo_exists,
         EXISTS(
           SELECT 1 FROM noderag.principal principal_record
           JOIN noderag.app_user user_record ON user_record.principal_id=principal_record.id
           WHERE principal_record.id=$2 AND NOT principal_record.disabled
             AND principal_record.deleted_at IS NULL AND user_record.server_admin
         ) AS owner_is_admin,
         (SELECT count(*)::text FROM noderag.document WHERE silo_id=$1) AS document_count`,
      [this.#destinationSiloId, this.#ownerPrincipalId],
    );
    const row = result.rows[0];
    if (row?.silo_exists !== true) throw new Error('portable-destination-silo-not-found');
    if (row.owner_is_admin !== true) throw new Error('portable-import-owner-not-admin');
    return Number(row.document_count) === 0;
  }

  async prepare(operationId: number, manifest: BackupInnerManifest): Promise<void> {
    if (manifest.product !== 'portable') throw new Error('full-restore-target-required');
    this.#schema = safeIdentifier(`noderag_portable_${String(operationId)}`);
    this.#tables = new Set(
      manifest.entries.flatMap((entry) => {
        const table = entryTable(entry.path);
        return table === null ? [] : [safeIdentifier(table)];
      }),
    );
    const permitted = new Set(includedTables(this.#policy, 'portable').map((entry) => entry.table));
    const unexpected = [...this.#tables].filter((table) => !permitted.has(table));
    if (unexpected.length > 0)
      throw new Error(`restore-table-not-permitted:${unexpected.join(',')}`);
    for (const required of ['silo', 'document', 'document_page', 'document_image'])
      if (!this.#tables.has(required))
        throw new Error(`portable-required-table-missing:${required}`);
    await withTransaction(this.#pool, async (database) => {
      await database.query(`DROP SCHEMA IF EXISTS ${this.#schema} CASCADE`);
      await database.query(`CREATE SCHEMA ${this.#schema}`);
      for (const table of this.#tables)
        await database.query(
          `CREATE UNLOGGED TABLE ${this.#schema}.${table} (LIKE noderag.${table} INCLUDING ALL)`,
        );
    });
    this.#rows.clear();
  }

  async consumeFullDump(_content: AsyncIterable<Uint8Array>): Promise<void> {
    throw new Error('portable-logical-dump-forbidden');
  }

  async consumePortableTable(
    tableValue: string,
    rows: AsyncIterable<Readonly<Record<string, unknown>>>,
  ): Promise<void> {
    const table = safeIdentifier(tableValue);
    if (!this.#tables.has(table)) throw new Error('restore-table-not-staged');
    const columns = await this.#pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='noderag' AND table_name=$1
         AND is_generated='NEVER' AND is_identity='NO'
       ORDER BY ordinal_position`,
      [table],
    );
    const names = columns.rows.map((column) => safeIdentifier(column.column_name));
    const list = names.join(',');
    let count = 0;
    let batch: Readonly<Record<string, unknown>>[] = [];
    const insert = async (): Promise<void> => {
      if (batch.length === 0) return;
      await this.#pool.query(
        `INSERT INTO ${this.#schema}.${table} (${list})
         SELECT ${list} FROM jsonb_populate_recordset(NULL::noderag.${table},$1::jsonb)`,
        [JSON.stringify(batch)],
      );
      count += batch.length;
      batch = [];
    };
    for await (const row of rows) {
      batch.push(row);
      if (batch.length === 100) await insert();
    }
    await insert();
    this.#rows.set(table, count);
  }

  async consumeSecrets(_rows: AsyncIterable<Readonly<Record<string, unknown>>>): Promise<void> {
    throw new Error('portable-secrets-forbidden');
  }

  async verify(manifest: BackupInnerManifest): Promise<Readonly<Record<string, unknown>>> {
    if (manifest.product !== 'portable') throw new Error('portable-manifest-required');
    if (this.#rows.size !== this.#tables.size) throw new Error('portable-table-count-mismatch');
    for (const [table, expected] of this.#rows) {
      const actual = await this.#pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${this.#schema}.${safeIdentifier(table)}`,
      );
      if (Number(actual.rows[0]?.count ?? '-1') !== expected)
        throw new Error(`restore-row-count-mismatch:${table}`);
    }
    const sourceSilos = await this.#pool.query<{ id: number }>(
      `SELECT id FROM ${this.#schema}.silo ORDER BY id`,
    );
    if (sourceSilos.rows.length === 0) throw new Error('portable-source-silo-missing');
    const invalidSilos = await this.#pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${this.#schema}.document document_record
       LEFT JOIN ${this.#schema}.silo silo_record ON silo_record.id=document_record.silo_id
       WHERE silo_record.id IS NULL`,
    );
    if (Number(invalidSilos.rows[0]?.count ?? '-1') !== 0)
      throw new Error('portable-document-silo-invalid');
    const conflicts = await this.#pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM ${this.#schema}.document incoming
       JOIN noderag.document existing ON existing.id=incoming.id`,
    );
    if (Number(conflicts.rows[0]?.count ?? '-1') !== 0)
      throw new Error('portable-document-id-conflict');
    const brokenChildren = await this.#pool.query<{ count: string }>(
      `SELECT (
         SELECT count(*) FROM ${this.#schema}.document_page child
         LEFT JOIN ${this.#schema}.document parent ON parent.id=child.document_id
         WHERE parent.id IS NULL
       ) + (
         SELECT count(*) FROM ${this.#schema}.document_image child
         LEFT JOIN ${this.#schema}.document parent ON parent.id=child.document_id
         WHERE parent.id IS NULL
       ) AS count`,
    );
    if (Number(brokenChildren.rows[0]?.count ?? '-1') !== 0)
      throw new Error('portable-document-relationship-invalid');
    const provenance = await this.#pool.query<{
      model_digests: string[];
      build_profiles: string[];
    }>(
      `SELECT
         COALESCE((SELECT array_agg(manifest_digest ORDER BY id)
                   FROM ${this.#schema}.model_manifest),'{}'::text[]) AS model_digests,
         COALESCE((SELECT array_agg(profile_digest ORDER BY id)
                   FROM ${this.#schema}.build),'{}'::text[]) AS build_profiles`,
    );
    return {
      product: 'portable',
      sourceSiloIds: sourceSilos.rows.map((row) => row.id),
      destinationSiloId: this.#destinationSiloId,
      documents: this.#rows.get('document') ?? 0,
      pages: this.#rows.get('document_page') ?? 0,
      images: this.#rows.get('document_image') ?? 0,
      sourceModelDigests: provenance.rows[0]?.model_digests ?? [],
      sourceBuildProfiles: provenance.rows[0]?.build_profiles ?? [],
    };
  }

  async activate(
    operationId: number,
    verification: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await withTransaction(this.#pool, async (database) => {
      const destination = await database.query(
        `SELECT 1 FROM noderag.silo WHERE id=$1 FOR UPDATE`,
        [this.#destinationSiloId],
      );
      if (destination.rowCount !== 1) throw new Error('portable-destination-silo-not-found');
      const conflicts = await database.query(
        `SELECT 1 FROM ${this.#schema}.document incoming
         JOIN noderag.document existing ON existing.id=incoming.id LIMIT 1`,
      );
      if ((conflicts.rowCount ?? 0) > 0) throw new Error('portable-document-id-conflict');
      await database.query(`SELECT set_config('app.silo_ids',$1,true)`, [
        `{${String(this.#destinationSiloId)}}`,
      ]);
      const insertMapped = async (
        table: 'document' | 'document_page' | 'document_image',
      ): Promise<void> => {
        const columns = await database.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='noderag' AND table_name=$1
             AND is_generated='NEVER' AND is_identity='NO'
           ORDER BY ordinal_position`,
          [table],
        );
        const names = columns.rows
          .map((column) => safeIdentifier(column.column_name))
          .filter((column) => !(table === 'document_image' && column === 'id'));
        const expressions = names.map((column) => {
          if (column === 'silo_id') return '$1::smallint';
          if (table === 'document' && column === 'source_id') return 'NULL::bigint';
          if (table === 'document' && column === 'uploaded_by') return '$2::bigint';
          return `staged.${column}`;
        });
        await database.query(
          `INSERT INTO noderag.${table} (${names.join(',')})
           SELECT ${expressions.join(',')} FROM ${this.#schema}.${table} staged`,
          table === 'document'
            ? [this.#destinationSiloId, this.#ownerPrincipalId]
            : [this.#destinationSiloId],
        );
      };
      await insertMapped('document');
      await insertMapped('document_page');
      await insertMapped('document_image');
      const activeBuild = await database.query<{ build_id: number }>(
        `SELECT build_id FROM noderag.silo_build_state
         WHERE silo_id=$1 AND state='active'
         ORDER BY activated_at DESC NULLS LAST,build_id DESC LIMIT 1`,
        [this.#destinationSiloId],
      );
      const buildId = activeBuild.rows[0]?.build_id;
      if (!Number.isSafeInteger(buildId)) throw new Error('portable-destination-build-missing');
      await database.query(
        `INSERT INTO noderag.job(kind,document_id,silo_id,build_id,payload)
         SELECT 'embed',document_record.id,$1,$2,
                jsonb_build_object('reason','portable-import','sourceState',document_record.state)
         FROM ${this.#schema}.document document_record`,
        [this.#destinationSiloId, buildId],
      );
      await database.query(
        `INSERT INTO noderag.audit_log(principal_id,silo_id,action,result,row_count,detail)
         VALUES ($1,$2,'portable.import','ok',$3,
                 jsonb_build_object('sourceSiloCount',$4::integer))`,
        [
          this.#ownerPrincipalId,
          this.#destinationSiloId,
          this.#rows.get('document') ?? 0,
          this.#rows.get('silo') ?? 0,
        ],
      );
      const documentSequence = await database.query<{ sequence: string | null }>(
        `SELECT pg_get_serial_sequence('noderag.document','id') AS sequence`,
      );
      if (typeof documentSequence.rows[0]?.sequence === 'string')
        await database.query(
          `SELECT setval($1::regclass,GREATEST(COALESCE((SELECT max(id) FROM noderag.document),1),1),
                         (SELECT count(*)>0 FROM noderag.document))`,
          [documentSequence.rows[0].sequence],
        );
      const completed = await database.query(
        `UPDATE noderag.restore_operation
         SET state='succeeded',verification=$2,activated_at=now(),finished_at=now()
         WHERE id=$1`,
        [operationId, verification],
      );
      if (completed.rowCount !== 1) throw new Error('restore-operation-missing');
    });
  }

  async rollback(): Promise<void> {
    // Activation is a single transaction; no database state survives a rejected activation.
  }

  async cleanup(retainStaging: boolean): Promise<void> {
    if (!retainStaging && this.#schema !== '')
      await this.#pool.query(`DROP SCHEMA IF EXISTS ${this.#schema} CASCADE`);
  }
}
