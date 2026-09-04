import { buildApp } from './app.js';
import { Pool } from 'pg';
import { createRequestAuthenticator } from './api/authentication.js';
import { loadRuntimeConfig } from './config.js';
import { FramedEmbedderClient } from './embedder/client.js';
import { ensureSetupTokenFile } from './setup/bootstrap.js';
import { DocumentFileStore } from './storage/document-files.js';
import { runMigrations } from './store/migrations.js';
import { createDatabaseReadinessProbe, unavailableReadiness } from './store/readiness.js';

const main = async (): Promise<void> => {
  const config = await loadRuntimeConfig();
  if (config.database !== null) await runMigrations(config.database);
  const pool = config.database === null ? null : new Pool(config.database);
  const embedder = new FramedEmbedderClient(config.embedderSocket);
  const files = new DocumentFileStore(config.dataRoot);
  await files.initialize();
  if (pool !== null && process.env['NODERAG_SETUP_TOKEN_FILE'] !== undefined) {
    await ensureSetupTokenFile(pool, process.env['NODERAG_SETUP_TOKEN_FILE']);
  }
  const expectedOrigin =
    process.env['NODERAG_ORIGIN'] ?? `http://${config.host}:${String(config.port)}`;
  const securedRoutes =
    pool === null
      ? {}
      : (() => {
          const authenticate = createRequestAuthenticator(pool, expectedOrigin);
          return {
            identity: {
              pool,
              expectedOrigin,
              secureCookie: (process.env['NODERAG_ORIGIN'] ?? '').startsWith('https://'),
              authenticate,
            },
            content: { pool, authenticate, files, embedder },
          };
        })();
  const app = buildApp({
    readiness:
      config.database === null
        ? unavailableReadiness
        : createDatabaseReadinessProbe(config.database),
    uiRoot: config.uiRoot,
    ...securedRoutes,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'stopping NodeRag');
    await app.close();
    await embedder.close();
    await pool?.end();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
};

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
