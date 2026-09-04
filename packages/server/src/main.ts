import { buildApp } from './app.js';
import { loadRuntimeConfig } from './config.js';
import { runMigrations } from './store/migrations.js';
import { createDatabaseReadinessProbe, unavailableReadiness } from './store/readiness.js';

const main = async (): Promise<void> => {
  const config = await loadRuntimeConfig();
  if (config.database !== null) await runMigrations(config.database);
  const app = buildApp({
    readiness:
      config.database === null
        ? unavailableReadiness
        : createDatabaseReadinessProbe(config.database),
    uiRoot: config.uiRoot,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'stopping NodeRag');
    await app.close();
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
