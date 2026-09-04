import { readFile, statfs } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { BackupProduct } from './archive.js';

const modeSchema = z.enum(['include', 'include-redacted', 'exclude']);
const policySchema = z
  .object({
    version: z.literal(1),
    migrationHead: z.string().min(1),
    unknownPolicy: z.literal('fail'),
    classes: z.record(z.string(), z.string()),
    tables: z.array(
      z
        .object({
          table: z.string().regex(/^[a-z][a-z0-9_]*$/u),
          class: z.enum([
            'source-of-truth',
            'behavioral-provenance',
            'derived',
            'secrets',
            'security-history',
            'ephemeral',
            'installation-local',
          ]),
          full: modeSchema,
          portable: modeSchema,
          portableExcludedColumns: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    fileClasses: z.array(z.record(z.string(), z.unknown())),
    restoreRules: z.record(z.string(), z.boolean()),
  })
  .strict();

export type BackupClassificationPolicy = z.infer<typeof policySchema>;
export type BackupTablePolicy = BackupClassificationPolicy['tables'][number];

export const defaultClassificationPath = resolve(
  process.cwd(),
  'platform/backup-data-classification.v1.json',
);

export const loadBackupClassification = async (
  path = defaultClassificationPath,
): Promise<BackupClassificationPolicy> =>
  policySchema.parse(JSON.parse(await readFile(resolve(path), 'utf8')) as unknown);

export const assertClassifiedSchema = async (
  pool: Pool,
  policy: BackupClassificationPolicy,
): Promise<void> => {
  const rows = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT column_record.table_name,column_record.column_name
     FROM information_schema.columns column_record
     JOIN pg_namespace namespace_record
       ON namespace_record.nspname=column_record.table_schema
     JOIN pg_class relation
       ON relation.relnamespace=namespace_record.oid
      AND relation.relname=column_record.table_name
     WHERE column_record.table_schema='noderag'
       AND relation.relkind IN ('r','p')
       AND NOT relation.relispartition
     ORDER BY column_record.table_name,column_record.ordinal_position`,
  );
  const database = new Map<string, Set<string>>();
  for (const row of rows.rows) {
    const columns = database.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    database.set(row.table_name, columns);
  }
  const declared = new Map(policy.tables.map((entry) => [entry.table, entry] as const));
  const unknown = [...database.keys()].filter((table) => !declared.has(table)).sort();
  const absent = [...declared.keys()].filter((table) => !database.has(table)).sort();
  if (unknown.length > 0) throw new Error(`unclassified-database-tables:${unknown.join(',')}`);
  if (absent.length > 0) throw new Error(`classification-tables-missing:${absent.join(',')}`);
  for (const entry of policy.tables) {
    const columns = database.get(entry.table);
    if (columns === undefined) continue;
    for (const column of entry.portableExcludedColumns ?? []) {
      if (!columns.has(column))
        throw new Error(`classification-column-missing:${entry.table}.${column}`);
    }
  }
};

export const includedTables = (
  policy: BackupClassificationPolicy,
  product: BackupProduct,
): readonly BackupTablePolicy[] => policy.tables.filter((entry) => entry[product] !== 'exclude');

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bpostgres(?:ql)?:\/\/[^\s:/]+:[^\s@]+@/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];

const secretColumn =
  /(?:^|[_-])(?:password|passwd|secret|token|private[_-]?key|api[_-]?key|credential)(?:$|[_-])/iu;

const normalizedColumnName = (value: string): string =>
  value.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();

export const assertPortableValueSafe = (value: unknown, path = '$'): void => {
  if (typeof value === 'string') {
    if (secretPatterns.some((pattern) => pattern.test(value)))
      throw new Error(`portable-secret-shaped-value:${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPortableValueSafe(item, `${path}[${String(index)}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (
      secretColumn.test(normalizedColumnName(key)) &&
      item !== null &&
      item !== false &&
      item !== ''
    )
      throw new Error(`portable-unclassified-secret-column:${path}.${key}`);
    assertPortableValueSafe(item, `${path}.${key}`);
  }
};

const inside = (parent: string, candidate: string): boolean => {
  const path = relative(resolve(parent), resolve(candidate));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};

export interface BackupPreflightOptions {
  readonly destination: string;
  readonly activeRoots: readonly string[];
  readonly passphrase: string;
  readonly requiredFreeBytes: number;
  readonly postgresClientMajor: number;
  readonly postgresServerMajor: number;
}

export const preflightBackup = async (options: BackupPreflightOptions): Promise<void> => {
  if (options.passphrase.length < 12) throw new Error('backup-passphrase-too-short');
  if (!isAbsolute(options.destination)) throw new Error('backup-destination-must-be-absolute');
  if (options.activeRoots.some((root) => inside(root, options.destination)))
    throw new Error('backup-destination-inside-active-data');
  if (options.postgresClientMajor < options.postgresServerMajor)
    throw new Error(
      `pg-dump-client-too-old:${String(options.postgresClientMajor)}<${String(options.postgresServerMajor)}`,
    );
  const space = await statfs(resolve(options.destination), { bigint: true });
  if (space.bavail * space.bsize < BigInt(options.requiredFreeBytes))
    throw new Error('backup-destination-insufficient-space');
};

export const preflightRestoreCompatibility = (
  source: {
    readonly archiveVersion: number;
    readonly migrationHead: string;
    readonly postgresMajor: number;
    readonly modelDimensions: readonly number[];
  },
  target: {
    readonly supportedArchiveVersions: readonly number[];
    readonly migrationHead: string;
    readonly postgresMajor: number;
    readonly modelDimensions: readonly number[];
  },
): void => {
  if (!target.supportedArchiveVersions.includes(source.archiveVersion))
    throw new Error('restore-archive-version-unsupported');
  if (source.migrationHead !== target.migrationHead)
    throw new Error('restore-migration-head-incompatible');
  if (source.postgresMajor !== target.postgresMajor)
    throw new Error('restore-postgres-major-incompatible');
  const unsupported = source.modelDimensions.filter(
    (dimension) => !target.modelDimensions.includes(dimension),
  );
  if (unsupported.length > 0)
    throw new Error(`restore-model-dimensions-unsupported:${unsupported.join(',')}`);
};
