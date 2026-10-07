import { buildApp } from './app.js';
import { Pool } from 'pg';
import { createRequestAuthenticator } from './api/authentication.js';
import { loadRuntimeConfig } from './config.js';
import { FramedEmbedderClient } from './embedder/client.js';
import { ensureSetupTokenFile } from './setup/bootstrap.js';
import { DocumentFileStore } from './storage/document-files.js';
import { runMigrations } from './store/migrations.js';
import { createDatabaseReadinessProbe, unavailableReadiness } from './store/readiness.js';
import { loadOrCreateSecretRoot, SecretVault } from './identity/secrets.js';
import { GatewayListenerManager } from './api/gateway-listeners.js';
import type { IdentityRoutesOptions } from './api/identity-routes.js';
import type { ContentRoutesOptions } from './api/content-routes.js';
import { recoverAbandonedMaintenance } from './recovery/maintenance.js';
import { RecoveryRuntime } from './recovery/runtime.js';
import { OpenAiOAuthManager } from './chat/openai-oauth.js';

const main = async (): Promise<void> => {
  const config = await loadRuntimeConfig();
  if (config.database !== null) await runMigrations(config.database);
  const pool = config.database === null ? null : new Pool(config.database);
  if (pool !== null) await recoverAbandonedMaintenance(pool);
  const embedder = new FramedEmbedderClient(config.embedderSocket);
  const files = new DocumentFileStore(config.dataRoot);
  const secretVault = new SecretVault(await loadOrCreateSecretRoot(config.secretRoot));
  await files.initialize();
  if (pool !== null && process.env['NODERAG_SETUP_TOKEN_FILE'] !== undefined) {
    await ensureSetupTokenFile(pool, process.env['NODERAG_SETUP_TOKEN_FILE']);
  }
  const expectedOrigin =
    process.env['NODERAG_ORIGIN'] ?? `http://${config.host}:${String(config.port)}`;
  let identity: IdentityRoutesOptions | undefined;
  let content: ContentRoutesOptions | undefined;
  let openAiOAuth: OpenAiOAuthManager | undefined;
  if (pool !== null && config.database !== null) {
    const authenticate = createRequestAuthenticator(pool, expectedOrigin);
    identity = {
      pool,
      expectedOrigin,
      secureCookie: (process.env['NODERAG_ORIGIN'] ?? '').startsWith('https://'),
      authenticate,
    };
    const recovery = new RecoveryRuntime({
      pool,
      database: config.database,
      dataRoot: config.dataRoot,
      nodeRagVersion: '1.0.0-rc.1',
      secretVault,
      ...(process.env['NODERAG_PG_DUMP'] === undefined
        ? {}
        : { pgDumpExecutable: process.env['NODERAG_PG_DUMP'] }),
    });
    if (config.chatFeatureFlags['chat.providers.enabled']) {
      openAiOAuth = new OpenAiOAuthManager({
        pool,
        secretVault,
        credentialHome: config.chatCodexHome,
      });
    }
    content = {
      pool,
      authenticate,
      files,
      embedder,
      sourceRoots: config.sourceRoots,
      ...(config.visionBearerToken === undefined
        ? {}
        : { visionBearerToken: config.visionBearerToken }),
      secretVault,
      recovery,
      retrievalCalibration: config.retrievalCalibration,
      chatFeatureFlags: config.chatFeatureFlags,
      ...(openAiOAuth === undefined ? {} : { openAiOAuth }),
    };
  }
  let gatewayManager: GatewayListenerManager | undefined;
  if (pool !== null && content !== undefined && config.database !== null) {
    const gatewayContent = content;
    const gatewayDatabase = config.database;
    gatewayManager = new GatewayListenerManager(pool, config.host, (gatewayId) =>
      buildApp({
        readiness: createDatabaseReadinessProbe(gatewayDatabase),
        uiRoot: config.uiRoot,
        logger: false,
        content: gatewayContent,
        gatewayId,
        gatewaySurface: true,
      }),
    );
  }
  const app = buildApp({
    version: '1.0.0-rc.1',
    readiness:
      config.database === null
        ? unavailableReadiness
        : createDatabaseReadinessProbe(config.database),
    uiRoot: config.uiRoot,
    ...(identity === undefined ? {} : { identity }),
    ...(content === undefined ? {} : { content }),
    ...(gatewayManager === undefined ? {} : { gatewayControl: gatewayManager }),
    ...(config.logRoot === undefined ? {} : { logRoot: config.logRoot }),
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'stopping NodeRag');
    await app.close();
    await gatewayManager?.close();
    await openAiOAuth?.stop();
    await embedder.close();
    await pool?.end();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  await gatewayManager?.reconcile();
};

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
