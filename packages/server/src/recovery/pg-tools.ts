import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Readable } from 'node:stream';

export interface PostgresToolConnection {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly sslMode?: 'disable' | 'prefer' | 'require';
}

export interface ProcessInvocation {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export const parsePostgresMajor = (output: string): number => {
  const match = /\(PostgreSQL\)\s+(\d+)(?:\.\d+)?/u.exec(output);
  const major = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(major) || major < 1)
    throw new Error('postgres-tool-version-unrecognized');
  return major;
};

export const assertPgDumpCompatibility = (clientMajor: number, serverMajor: number): void => {
  if (clientMajor < serverMajor)
    throw new Error(`pg-dump-client-too-old:${String(clientMajor)}<${String(serverMajor)}`);
};

export const postgresToolMajor = async (executable = 'pg_dump'): Promise<number> =>
  new Promise<number>((resolveMajor, rejectMajor) => {
    execFile(
      executable,
      ['--version'],
      { env: { ...safeParentEnvironment() }, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          rejectMajor(new Error(`postgres-tool-version-failed:${error.name}`));
          return;
        }
        try {
          resolveMajor(parsePostgresMajor(stdout));
        } catch (parseError) {
          rejectMajor(parseError);
        }
      },
    );
  });

const toolEnvironment = (connection: PostgresToolConnection): Readonly<Record<string, string>> => ({
  PGHOST: connection.host,
  PGPORT: String(connection.port),
  PGDATABASE: connection.database,
  PGUSER: connection.user,
  PGPASSWORD: connection.password,
  PGSSLMODE: connection.sslMode ?? 'prefer',
});

export const pgDumpInvocation = (
  connection: PostgresToolConnection,
  executable = 'pg_dump',
): ProcessInvocation => ({
  executable,
  arguments: [
    '--format=custom',
    '--compress=0',
    '--no-owner',
    '--no-privileges',
    '--schema=noderag',
    '--file=-',
  ],
  environment: toolEnvironment(connection),
});

export const pgRestoreInvocation = (
  connection: PostgresToolConnection,
  executable = 'pg_restore',
): ProcessInvocation => ({
  executable,
  arguments: [
    '--exit-on-error',
    '--single-transaction',
    '--no-owner',
    '--no-privileges',
    '--dbname',
    connection.database,
    '-',
  ],
  environment: toolEnvironment(connection),
});

const safeParentEnvironment = (): Readonly<Record<string, string>> => {
  const allowed = [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ];
  return Object.fromEntries(
    allowed.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
};

const collectBoundedStderr = (stream: Readable, maximumBytes = 64 * 1024): (() => Buffer) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  stream.on('data', (value: Buffer) => {
    if (bytes >= maximumBytes) return;
    const chunk = Buffer.from(value);
    const retained = chunk.subarray(0, maximumBytes - bytes);
    chunks.push(retained);
    bytes += retained.byteLength;
  });
  return () => Buffer.concat(chunks);
};

export const streamPgDump = (
  connection: PostgresToolConnection,
  executable = 'pg_dump',
): AsyncIterable<Uint8Array> => {
  const invocation = pgDumpInvocation(connection, executable);
  const child = spawn(invocation.executable, [...invocation.arguments], {
    env: { ...safeParentEnvironment(), ...invocation.environment },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  const stderr = collectBoundedStderr(child.stderr);
  const output = child.stdout;
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      for await (const chunk of output) yield Buffer.from(chunk as Uint8Array);
      const [code, signal] = await exited;
      if (code !== 0)
        throw new Error(
          `pg-dump-failed:${code === null ? (signal ?? 'unknown') : String(code)}:${stderr()
            .toString('utf8')
            .trim()
            .slice(0, 1000)}`,
        );
    },
  };
};

export const restorePgDump = async (
  connection: PostgresToolConnection,
  input: AsyncIterable<Uint8Array>,
  executable = 'pg_restore',
): Promise<void> => {
  const invocation = pgRestoreInvocation(connection, executable);
  const child = spawn(invocation.executable, [...invocation.arguments], {
    env: { ...safeParentEnvironment(), ...invocation.environment },
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  const stderr = collectBoundedStderr(child.stderr);
  try {
    for await (const chunk of input) {
      if (!child.stdin.write(chunk)) await once(child.stdin, 'drain');
    }
    child.stdin.end();
  } catch (error) {
    child.stdin.destroy(error instanceof Error ? error : new Error('restore-input-failed'));
    child.kill('SIGTERM');
    throw error;
  }
  const [code, signal] = await exited;
  if (code !== 0)
    throw new Error(
      `pg-restore-failed:${code === null ? (signal ?? 'unknown') : String(code)}:${stderr()
        .toString('utf8')
        .trim()
        .slice(0, 1000)}`,
    );
};

export const consumeReadable = async function* (stream: Readable): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream) yield Buffer.from(chunk as Uint8Array);
};
