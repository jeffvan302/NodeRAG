import { readFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import type { ClientConfig } from 'pg';

export interface RuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly database: ClientConfig | null;
  readonly uiRoot: string;
  readonly dataRoot: string;
  readonly logRoot?: string;
  readonly embedderSocket: string;
  readonly sourceRoots: readonly string[];
  readonly visionBearerToken?: string;
  readonly ollamaParallelCapacity?: number;
  readonly secretRoot: string;
}

const parsePort = (name: string, raw: string | undefined, fallback: number): number => {
  const port = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535.`);
  }
  return port;
};

export const loadRuntimeConfig = async (): Promise<RuntimeConfig> => {
  const dataRoot = resolve(process.env['NODERAG_DATA_ROOT'] ?? 'runtime-data');
  const passwordFile = process.env['NODERAG_POSTGRES_PASSWORD_FILE'];
  let database: ClientConfig | null = null;
  if (passwordFile !== undefined && passwordFile.length > 0) {
    const password = (await readFile(resolve(passwordFile), 'utf8')).trim();
    if (password.length === 0) throw new Error('The PostgreSQL password file is empty.');
    database = {
      host: process.env['NODERAG_POSTGRES_HOST'] ?? '127.0.0.1',
      port: parsePort('NODERAG_POSTGRES_PORT', process.env['NODERAG_POSTGRES_PORT'], 55432),
      database: process.env['NODERAG_POSTGRES_DATABASE'] ?? 'noderag',
      user: process.env['NODERAG_POSTGRES_USER'] ?? 'noderag',
      password,
    };
  }

  const visionTokenFile = process.env['NODERAG_OLLAMA_BEARER_TOKEN_FILE'];
  const visionBearerToken =
    visionTokenFile === undefined || visionTokenFile.length === 0
      ? process.env['NODERAG_OLLAMA_BEARER_TOKEN']
      : (await readFile(resolve(visionTokenFile), 'utf8')).trim();
  const parallelCapacity = process.env['NODERAG_OLLAMA_NUM_PARALLEL'];
  const ollamaParallelCapacity =
    parallelCapacity === undefined ? undefined : Number(parallelCapacity);
  if (
    ollamaParallelCapacity !== undefined &&
    (!Number.isInteger(ollamaParallelCapacity) || ollamaParallelCapacity < 1)
  ) {
    throw new Error('NODERAG_OLLAMA_NUM_PARALLEL must be a positive integer.');
  }

  return {
    host: process.env['NODERAG_HOST'] ?? '127.0.0.1',
    port: parsePort('NODERAG_PORT', process.env['NODERAG_PORT'], 8787),
    database,
    uiRoot: resolve(process.env['NODERAG_UI_ROOT'] ?? 'packages/ui/dist'),
    dataRoot,
    ...(process.env['NODERAG_LOG_ROOT'] === undefined
      ? {}
      : { logRoot: resolve(process.env['NODERAG_LOG_ROOT']) }),
    embedderSocket: resolve(
      process.env['NODERAG_EMBEDDER_SOCKET'] ?? 'runtime-data/run/embedder.sock',
    ),
    sourceRoots: (process.env['NODERAG_SOURCE_ROOTS'] ?? '')
      .split(delimiter)
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map((value) => resolve(value)),
    ...(visionBearerToken === undefined || visionBearerToken.length === 0
      ? {}
      : { visionBearerToken }),
    ...(ollamaParallelCapacity === undefined ? {} : { ollamaParallelCapacity }),
    secretRoot: resolve(process.env['NODERAG_SECRET_ROOT'] ?? join(dataRoot, 'secrets/root.key')),
  };
};
