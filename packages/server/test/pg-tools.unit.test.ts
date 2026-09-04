import { describe, expect, it } from 'vitest';
import {
  assertPgDumpCompatibility,
  parsePostgresMajor,
  pgDumpInvocation,
  pgRestoreInvocation,
} from '../src/recovery/pg-tools.js';

const connection = {
  host: 'database.internal',
  port: 5432,
  database: 'noderag',
  user: 'noderag',
  password: 'do-not-leak-this-password',
  sslMode: 'require' as const,
};

describe('PostgreSQL recovery tools', () => {
  it('parses and enforces the pg_dump/server major-version rule', () => {
    expect(parsePostgresMajor('pg_dump (PostgreSQL) 17.6')).toBe(17);
    expect(() => assertPgDumpCompatibility(17, 17)).not.toThrow();
    expect(() => assertPgDumpCompatibility(18, 17)).not.toThrow();
    expect(() => assertPgDumpCompatibility(16, 17)).toThrow('pg-dump-client-too-old:16<17');
  });

  it('keeps the database password out of pg_dump and pg_restore arguments', () => {
    for (const invocation of [pgDumpInvocation(connection), pgRestoreInvocation(connection)]) {
      expect(invocation.arguments.join(' ')).not.toContain(connection.password);
      expect(invocation.environment['PGPASSWORD']).toBe(connection.password);
      expect(invocation.environment['PGSSLMODE']).toBe('require');
    }
    expect(pgDumpInvocation(connection).arguments).toContain('--no-owner');
    expect(pgRestoreInvocation(connection).arguments).toContain('--single-transaction');
  });
});
