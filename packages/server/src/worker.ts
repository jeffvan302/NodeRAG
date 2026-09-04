import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { loadRuntimeConfig } from './config.js';
import { FramedEmbedderClient } from './embedder/client.js';
import { processOneMarkdownJob } from './ingest/pipeline.js';
import { DocumentFileStore } from './storage/document-files.js';
import { runMigrations } from './store/migrations.js';
import { enqueueNightlyIntegrityJob } from './ingest/integrity.js';
import { enqueueDueSourceCrawls } from './ingest/sources.js';

const main = async (): Promise<void> => {
  const once = process.argv.includes('--once');
  const config = await loadRuntimeConfig();
  if (config.database === null) throw new Error('The worker requires PostgreSQL configuration.');
  await runMigrations(config.database);
  const pool = new Pool(config.database);
  const embedder = new FramedEmbedderClient(config.embedderSocket);
  const files = new DocumentFileStore(config.dataRoot);
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
      const processed = await processOneMarkdownJob({
        pool,
        files,
        embedder,
        leaseOwner,
        sourceRoots: config.sourceRoots,
      });
      if (once) break;
      if (!processed) {
        await enqueueDueSourceCrawls(pool);
        await delay(500);
      }
    } while (!stopping);
  } finally {
    await embedder.close();
    await pool.end();
  }
};

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
