import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ClientConfig } from 'pg';

export interface RuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly database: ClientConfig | null;
  readonly uiRoot: string;
}

const parsePort = (name: string, raw: string | undefined, fallback: number): number => {
  const port = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535.`);
  }
  return port;
};

export const loadRuntimeConfig = async (): Promise<RuntimeConfig> => {
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

  return {
    host: process.env['NODERAG_HOST'] ?? '127.0.0.1',
    port: parsePort('NODERAG_PORT', process.env['NODERAG_PORT'], 8787),
    database,
    uiRoot: resolve(process.env['NODERAG_UI_ROOT'] ?? 'packages/ui/dist'),
  };
};
