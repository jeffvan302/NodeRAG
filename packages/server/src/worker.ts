import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { loadRuntimeConfig } from './config.js';
import { FramedEmbedderClient } from './embedder/client.js';
import { processOneDocumentJob } from './ingest/pipeline.js';
import { DocumentFileStore } from './storage/document-files.js';
import { runMigrations } from './store/migrations.js';
import { enqueueNightlyIntegrityJob } from './ingest/integrity.js';
import { enqueueDueSourceCrawls } from './ingest/sources.js';
import { createRuntimeVisionProcessor } from './vision/runtime.js';
import { loadOrCreateSecretRoot, SecretVault } from './identity/secrets.js';
import { processOneEvaluationRun } from './search/evaluation-runner.js';
import { recoverAbandonedMaintenance } from './recovery/maintenance.js';
import { RecoveryRuntime } from './recovery/runtime.js';
import { processOneScheduledBackup } from './recovery/schedule.js';
import { OpenAiOAuthManager } from './chat/openai-oauth.js';
import { createChatProviderResolver } from './chat/provider-runtime.js';
import { processOneChatRun } from './chat/runner.js';
import { ChatWebService } from './chat/web.js';
import { ChatArtifactService, createChatArtifactExecutor } from './chat/artifacts.js';
import { ChatExportService, processOneChatExport } from './chat/exports.js';
import { processOneManualContextCompression } from './chat/context-compression.js';

const ingestionConcurrency = async (pool: Pool): Promise<number> => {
  const result = await pool.query<{ ingest_threads: number }>(
    'SELECT ingest_threads FROM noderag.settings WHERE id=1',
  );
  return Math.min(
    16,
    Math.max(1, availableParallelism()),
    Math.max(1, result.rows[0]?.ingest_threads ?? 1),
  );
};

const main = async (): Promise<void> => {
  const once = process.argv.includes('--once');
  const config = await loadRuntimeConfig();
  if (config.database === null) throw new Error('The worker requires PostgreSQL configuration.');
  await runMigrations(config.database);
  const pool = new Pool(config.database);
  await recoverAbandonedMaintenance(pool);
  const embedder = new FramedEmbedderClient(config.embedderSocket);
  const files = new DocumentFileStore(config.dataRoot);
  const chatArtifactService = new ChatArtifactService(pool);
  const chatArtifacts = createChatArtifactExecutor(chatArtifactService);
  const chatExports = new ChatExportService(pool, chatArtifactService);
  const secretVault = new SecretVault(await loadOrCreateSecretRoot(config.secretRoot));
  const openAiOAuth = config.chatFeatureFlags['chat.ui.enabled']
    ? new OpenAiOAuthManager({
        pool,
        secretVault,
        credentialHome: config.chatCodexHome,
      })
    : undefined;
  const resolveChatProvider = createChatProviderResolver({
    pool,
    secretVault,
    ...(openAiOAuth === undefined ? {} : { openAiOAuth }),
  });
  const chatWeb = new ChatWebService({ pool, secretVault });
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
  await files.initialize();
  await enqueueNightlyIntegrityJob(pool);
  const leaseOwner = `${process.pid}-${randomUUID()}`;
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.info(JSON.stringify({ service: 'noderag-worker', event: 'started', once, leaseOwner }));
  try {
    do {
      const chatProcessed = config.chatFeatureFlags['chat.ui.enabled']
        ? await processOneChatRun({
            pool,
            leaseOwner: `${leaseOwner}:chat`,
            resolveProvider: resolveChatProvider,
            researchEnabled: config.chatFeatureFlags['chat.tools.research.enabled'],
            ragEnabled: config.chatFeatureFlags['chat.tools.rag.enabled'],
            webEnabled: config.chatFeatureFlags['chat.tools.web.enabled'],
            webExecutor: chatWeb,
            artifactEnabled: config.chatFeatureFlags['chat.artifacts.enabled'],
            artifactExecutor: chatArtifacts,
            embedder,
            files,
          })
        : false;
      const contextProcessed = config.chatFeatureFlags['chat.context.enabled']
        ? await processOneManualContextCompression({
            pool,
            leaseOwner: `${leaseOwner}:context`,
            resolveProvider: resolveChatProvider,
          })
        : false;
      const backupProcessed = await processOneScheduledBackup(pool, secretVault, (request) =>
        recovery.startBackup(request),
      );
      const exportProcessed = config.chatFeatureFlags['chat.exports.enabled']
        ? await processOneChatExport({
            pool,
            leaseOwner: `${leaseOwner}:export`,
            service: chatExports,
          })
        : false;
      const evaluationProcessed = await processOneEvaluationRun({
        pool,
        embedder,
        files,
        leaseOwner: `${leaseOwner}:evaluation`,
        calibration: config.retrievalCalibration,
      });
      const concurrentDocuments = once ? 1 : await ingestionConcurrency(pool);
      const documentResults = await Promise.all(
        Array.from({ length: concurrentDocuments }, (_, slot) =>
          processOneDocumentJob({
            pool,
            files,
            embedder,
            leaseOwner: `${leaseOwner}:document:${String(slot)}`,
            sourceRoots: config.sourceRoots,
            visionFactory: () =>
              createRuntimeVisionProcessor(pool, {
                ...(config.visionBearerToken === undefined
                  ? {}
                  : { bearerToken: config.visionBearerToken }),
                ...(config.ollamaParallelCapacity === undefined
                  ? {}
                  : { providerParallelCapacity: config.ollamaParallelCapacity }),
                secretVault,
              }),
          }),
        ),
      );
      const documentProcessed = documentResults.some(Boolean);
      if (once) break;
      if (
        !chatProcessed &&
        !contextProcessed &&
        !backupProcessed &&
        !exportProcessed &&
        !evaluationProcessed &&
        !documentProcessed
      ) {
        await enqueueDueSourceCrawls(pool);
        await delay(500);
      }
    } while (!stopping);
  } finally {
    await openAiOAuth?.stop();
    await embedder.close();
    await pool.end();
  }
};

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
