import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Embedder, EmbeddingBatch } from '@noderag/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeterministicRuntime } from '../../embedder/src/runtime.js';
import { buildApp } from '../src/app.js';
import { createRequestAuthenticator } from '../src/api/authentication.js';
import { sweepStorageIntegrity, verifyChunkLocators } from '../src/ingest/integrity.js';
import { drainMarkdownJobs } from '../src/ingest/pipeline.js';
import { enqueueDueSourceCrawls } from '../src/ingest/sources.js';
import { hashPassword } from '../src/identity/passwords.js';
import { bootstrapFirstAdministrator, issueSetupToken } from '../src/setup/bootstrap.js';
import { DocumentFileStore } from '../src/storage/document-files.js';
import { databaseInteger, withTransaction } from '../src/store/database.js';
import {
  ClassifiedJobError,
  claimNextJob,
  completeJob,
  failJob,
  heartbeatJob,
  requestJobCancellation,
} from '../src/store/jobs.js';
import { runMigrations } from '../src/store/migrations.js';
import { createDatabaseReadinessProbe } from '../src/store/readiness.js';
import { createSilo } from '../src/store/silos.js';
import { continueDocumentPurge, purgeDocument, startDocumentPurge } from '../src/store/purge.js';
import { coordinatedEmbedder, withHnswBuildResource } from '../src/store/resources.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

const multipart = (filename: string, body: Buffer) => {
  const boundary = `noderag-${crypto.randomUUID()}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n`,
        'utf8',
      ),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]),
  };
};

class CountingEmbedder implements Embedder {
  private readonly runtime = createDeterministicRuntime();
  embeddedTexts = 0;

  countTokens(texts: readonly string[]) {
    return this.runtime.countTokens(texts);
  }

  async embed(texts: readonly string[], maxTokens: number): Promise<EmbeddingBatch> {
    this.embeddedTexts += texts.length;
    return this.runtime.embed(texts, maxTokens);
  }
}

interface BrowserIdentity {
  readonly cookie: string;
  readonly csrf: string;
}

const required = <T>(value: T | null | undefined, message: string): T => {
  if (value === null || value === undefined) throw new Error(message);
  return value;
};

describe.sequential('M05 durable ingestion, sources, verification, and purge', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let root: string;
  let sourceBase: string;
  let watchedRoot: string;
  let files: DocumentFileStore;
  let siloId: number;
  let administratorId: number;
  let app: ReturnType<typeof buildApp>;
  let administrator: BrowserIdentity;
  const embedder = new CountingEmbedder();
  const password = 'M05-admin-password!';

  const login = async (username: string, userPassword: string): Promise<BrowserIdentity> => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username, password: userPassword },
    });
    expect(response.statusCode, response.body).toBe(200);
    const setCookie = response.headers['set-cookie'];
    return {
      cookie: Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? ''),
      csrf: response.json<{ csrfToken: string }>().csrfToken,
    };
  };

  const mutationHeaders = (identity: BrowserIdentity, key: string) => ({
    cookie: identity.cookie,
    origin: 'http://noderag.test',
    'x-csrf-token': identity.csrf,
    'idempotency-key': key,
  });

  const upload = async (
    identity: BrowserIdentity,
    name: string,
    text: string,
    key: string,
  ): Promise<number> => {
    const body = multipart(name, Buffer.from(text, 'utf8'));
    const response = await app.inject({
      method: 'POST',
      url: `/v1/documents?siloId=${String(siloId)}`,
      headers: { ...mutationHeaders(identity, key), 'content-type': body.contentType },
      payload: body.payload,
    });
    expect(response.statusCode, response.body).toBe(202);
    return response.json<{ documentId: number }>().documentId;
  };

  const drain = async (owner: string): Promise<number> =>
    drainMarkdownJobs({
      pool,
      files,
      embedder,
      leaseOwner: owner,
      sourceRoots: [sourceBase],
    });

  beforeAll(async () => {
    container = await new PostgreSqlContainer(postgresImage)
      .withDatabase('noderag_m05')
      .withUsername('noderag')
      .withPassword('synthetic-test-only-password')
      .start();
    const database = {
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
    };
    await runMigrations(database);
    pool = new Pool(database);
    const setupToken = await issueSetupToken(pool);
    const setup = await bootstrapFirstAdministrator(pool, {
      setupToken,
      username: 'm05-admin',
      password,
    });
    siloId = setup.defaultSilo.id;
    administratorId = setup.principalId;
    root = await mkdtemp(join(tmpdir(), 'noderag-m05-'));
    sourceBase = join(root, 'source-base');
    watchedRoot = join(sourceBase, 'watched');
    await mkdir(watchedRoot, { recursive: true });
    files = new DocumentFileStore(join(root, 'managed'));
    await files.initialize();
    const authenticate = createRequestAuthenticator(pool, 'http://noderag.test');
    app = buildApp({
      readiness: createDatabaseReadinessProbe(database),
      uiRoot: join(root, 'missing-ui'),
      logger: false,
      identity: {
        pool,
        expectedOrigin: 'http://noderag.test',
        secureCookie: false,
        authenticate,
      },
      content: {
        pool,
        authenticate,
        files,
        embedder,
        maximumUploadBytes: 2 * 1024 * 1024,
        minimumFreeBytes: 0,
        sourceRoots: [sourceBase],
      },
    });
    await app.ready();
    administrator = await login('m05-admin', password);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('fences stale workers, preserves logical attempts, classifies failures, and settles ordered events', async () => {
    const inserted = await pool.query<{ id: unknown }>(
      `INSERT INTO noderag.job (kind, priority, payload)
       VALUES ('verify', 0, jsonb_build_object('fixture', 'fencing')) RETURNING id`,
    );
    const jobId = databaseInteger(inserted.rows[0]?.id, 'fencing job id');
    await pool.query(
      `INSERT INTO noderag.job_event (job_id, sequence, event_type)
       VALUES ($1, 0, 'queued')`,
      [jobId],
    );
    const first = await claimNextJob(pool, 'm05-worker-stale', 1000);
    expect(first).toMatchObject({ id: jobId, leaseEpoch: 1, logicalAttempt: 1, attempts: 1 });
    expect(first?.frozenConfig).toMatchObject({ schemaRevision: '000007_operator_ui' });
    await pool.query(
      `UPDATE noderag.job SET leased_until = now() - interval '1 second' WHERE id = $1`,
      [jobId],
    );
    const second = await claimNextJob(pool, 'm05-worker-current', 5000);
    expect(second).toMatchObject({ id: jobId, leaseEpoch: 2, logicalAttempt: 1, attempts: 2 });
    await expect(
      withTransaction(pool, (database) =>
        completeJob(database, required(first, 'first lease missing'), { stale: true }),
      ),
    ).rejects.toThrow('job-lease-lost');
    await heartbeatJob(
      pool,
      required(second, 'second lease missing'),
      5000,
      { stage: 'verified', percent: 50 },
      { row: 12 },
    );
    await withTransaction(pool, (database) =>
      completeJob(database, required(second, 'second lease missing'), { verified: true }),
    );
    const settled = await pool.query<{
      state: string;
      logical_attempt: number;
      lease_epoch: string;
      result: Record<string, unknown>;
      checkpoint: Record<string, unknown>;
    }>(
      'SELECT state, logical_attempt, lease_epoch, result, checkpoint FROM noderag.job WHERE id=$1',
      [jobId],
    );
    expect(settled.rows[0]).toMatchObject({
      state: 'succeeded',
      logical_attempt: 1,
      result: { verified: true },
      checkpoint: { row: 12 },
    });
    const events = await pool.query<{ sequence: number; event_type: string }>(
      `SELECT sequence, event_type FROM noderag.job_event WHERE job_id=$1 ORDER BY sequence`,
      [jobId],
    );
    expect(events.rows.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(events.rows.map(({ event_type }) => event_type)).toEqual([
      'queued',
      'leased',
      'lease_reclaimed',
      'progress',
      'succeeded',
    ]);

    const contestedInsert = await pool.query<{ id: unknown }>(
      `INSERT INTO noderag.job (kind, priority) VALUES ('verify', 0) RETURNING id`,
    );
    const contestedId = databaseInteger(contestedInsert.rows[0]?.id, 'contested job id');
    const dying = await claimNextJob(pool, 'm05-dying-after-heartbeat', 1000);
    expect(dying?.id).toBe(contestedId);
    await heartbeatJob(pool, required(dying, 'dying lease missing'), 1000, {
      stage: 'before-crash',
    });
    await pool.query(
      `UPDATE noderag.job SET leased_until = now() - interval '1 second' WHERE id = $1`,
      [contestedId],
    );
    const contenders = await Promise.all([
      claimNextJob(pool, 'm05-contender-a', 5000),
      claimNextJob(pool, 'm05-contender-b', 5000),
    ]);
    expect(contenders.filter((candidate) => candidate?.id === contestedId)).toHaveLength(1);
    expect(contenders.filter((candidate) => candidate === null)).toHaveLength(1);
    const winner = required(
      contenders.find((candidate) => candidate !== null),
      'lease contest had no winner',
    );
    await withTransaction(pool, (database) => completeJob(database, winner, { wonFence: true }));

    const failedInsert = await pool.query<{ id: unknown }>(
      `INSERT INTO noderag.job (kind, priority, max_attempts)
       VALUES ('verify', 0, 3) RETURNING id`,
    );
    const failedId = databaseInteger(failedInsert.rows[0]?.id, 'failure job id');
    const transient = await claimNextJob(pool, 'm05-transient');
    expect(transient?.id).toBe(failedId);
    await failJob(
      pool,
      required(transient, 'transient lease missing'),
      new ClassifiedJobError('external-timeout', 'transient', 'temporary outage'),
    );
    const retry = await pool.query<{ state: string; error_class: string; retry_at: Date | null }>(
      'SELECT state, error_class, retry_at FROM noderag.job WHERE id=$1',
      [failedId],
    );
    expect(retry.rows[0]?.state).toBe('retry_wait');
    expect(retry.rows[0]?.error_class).toBe('transient');
    expect(retry.rows[0]?.retry_at).toBeInstanceOf(Date);
    await pool.query('UPDATE noderag.job SET run_after=now() WHERE id=$1', [failedId]);
    const permanent = await claimNextJob(pool, 'm05-permanent');
    await failJob(
      pool,
      required(permanent, 'permanent lease missing'),
      new ClassifiedJobError('malformed-input', 'permanent', 'cannot retry'),
    );
    const terminal = await pool.query<{ state: string; error_class: string }>(
      'SELECT state, error_class FROM noderag.job WHERE id=$1',
      [failedId],
    );
    expect(terminal.rows[0]).toEqual({ state: 'failed', error_class: 'permanent' });
  });

  it('dispatches equal-priority document work round-robin instead of starving later documents', async () => {
    const documents = await pool.query<{ id: unknown }>(
      `INSERT INTO noderag.document
         (silo_id, name, extension, byte_count, original_sha256, uploaded_by)
       VALUES
         ($1, 'fair-a.md', 'md', 1, $2, $4),
         ($1, 'fair-b.md', 'md', 1, $3, $4)
       RETURNING id`,
      [siloId, Buffer.alloc(32, 41), Buffer.alloc(32, 42), administratorId],
    );
    const firstDocumentId = databaseInteger(documents.rows[0]?.id, 'first fairness document id');
    const secondDocumentId = databaseInteger(documents.rows[1]?.id, 'second fairness document id');
    const jobs = await pool.query<{ id: unknown }>(
      `INSERT INTO noderag.job (kind, document_id, silo_id, priority)
       VALUES ('verify', $1, $3, 1), ('verify', $2, $3, 1)
       RETURNING id`,
      [firstDocumentId, secondDocumentId, siloId],
    );
    const firstJobId = databaseInteger(jobs.rows[0]?.id, 'first fairness job id');
    const secondJobId = databaseInteger(jobs.rows[1]?.id, 'second fairness job id');

    const first = required(await claimNextJob(pool, 'm05-fairness-first'), 'first claim missing');
    expect(first.id).toBe(firstJobId);
    await withTransaction(pool, (database) => completeJob(database, first, { order: 1 }));

    const repeat = await pool.query<{ id: unknown }>(
      `INSERT INTO noderag.job (kind, document_id, silo_id, priority)
       VALUES ('verify', $1, $2, 1) RETURNING id`,
      [firstDocumentId, siloId],
    );
    const repeatJobId = databaseInteger(repeat.rows[0]?.id, 'repeat fairness job id');
    const second = required(
      await claimNextJob(pool, 'm05-fairness-second'),
      'second claim missing',
    );
    expect(second.id).toBe(secondJobId);
    await withTransaction(pool, (database) => completeJob(database, second, { order: 2 }));
    const third = required(await claimNextJob(pool, 'm05-fairness-third'), 'third claim missing');
    expect(third.id).toBe(repeatJobId);
    await withTransaction(pool, (database) => completeJob(database, third, { order: 3 }));
    await pool.query('DELETE FROM noderag.document WHERE id = ANY($1::bigint[])', [
      [firstDocumentId, secondDocumentId],
    ]);
  });

  it('rolls back an uncommitted terminal settlement across a database restart', async () => {
    const restartContainer = await new PostgreSqlContainer(postgresImage)
      .withDatabase('noderag_m05_restart')
      .withUsername('noderag')
      .withPassword('synthetic-restart-test-only-password')
      .start();
    const restartDatabase = () => ({
      host: restartContainer.getHost(),
      port: restartContainer.getPort(),
      database: restartContainer.getDatabase(),
      user: restartContainer.getUsername(),
      password: restartContainer.getPassword(),
    });
    await runMigrations(restartDatabase());
    const beforeRestartPool = new Pool(restartDatabase());
    beforeRestartPool.on('error', () => undefined);
    try {
      const setupToken = await issueSetupToken(beforeRestartPool);
      await bootstrapFirstAdministrator(beforeRestartPool, {
        setupToken,
        username: 'restart-admin',
        password: 'M05-restart-password!',
      });
      const inserted = await beforeRestartPool.query<{ id: unknown }>(
        `INSERT INTO noderag.job (kind, priority, payload)
         VALUES ('verify', 0, jsonb_build_object('fixture', 'database-restart')) RETURNING id`,
      );
      const jobId = databaseInteger(inserted.rows[0]?.id, 'database restart job id');
      const first = required(
        await claimNextJob(beforeRestartPool, 'm05-database-restart-first', 5000),
        'database restart claim missing',
      );
      expect(first.id).toBe(jobId);

      const settlingConnection = await beforeRestartPool.connect();
      const connectionFailure = new Promise<Error>((resolveFailure) => {
        settlingConnection.on('error', resolveFailure);
      });
      await settlingConnection.query('BEGIN');
      await completeJob(settlingConnection, first, { shouldRollback: true });
      await restartContainer.restart({ timeout: 1 });
      expect(await connectionFailure).toBeInstanceOf(Error);
      settlingConnection.release(true);
      await beforeRestartPool.end();

      const recoveredPool = new Pool(restartDatabase());
      try {
        const rolledBack = await recoveredPool.query<{ state: string }>(
          'SELECT state FROM noderag.job WHERE id=$1',
          [jobId],
        );
        expect(rolledBack.rows[0]?.state).toBe('leased');
        const prematureTerminal = await recoveredPool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM noderag.job_event
           WHERE job_id=$1 AND event_type='succeeded'`,
          [jobId],
        );
        expect(prematureTerminal.rows[0]?.count).toBe('0');

        await recoveredPool.query(
          `UPDATE noderag.job SET leased_until=now() - interval '1 second' WHERE id=$1`,
          [jobId],
        );
        const reclaimed = required(
          await claimNextJob(recoveredPool, 'm05-database-restart-second', 5000),
          'database restart reclaim missing',
        );
        expect(reclaimed).toMatchObject({ id: jobId, leaseEpoch: 2, logicalAttempt: 1 });
        await withTransaction(recoveredPool, (database) =>
          completeJob(database, reclaimed, { recoveredAfterRestart: true }),
        );
      } finally {
        await recoveredPool.end();
      }
    } finally {
      await beforeRestartPool.end().catch(() => undefined);
      await restartContainer.stop();
    }
  });

  it('keeps cancellation explicit and replays persisted events over SSE', async () => {
    const inserted = await pool.query<{ id: unknown }>(
      `INSERT INTO noderag.job (kind, silo_id, priority)
       VALUES ('verify', $1, 0) RETURNING id`,
      [siloId],
    );
    const jobId = databaseInteger(inserted.rows[0]?.id, 'cancellation job id');
    await pool.query(
      `INSERT INTO noderag.job_event (job_id, sequence, event_type)
       VALUES ($1, 0, 'queued')`,
      [jobId],
    );
    const claimed = await claimNextJob(pool, 'm05-cancellable');
    expect(claimed?.id).toBe(jobId);

    const stream = await app.inject({
      method: 'GET',
      url: '/v1/jobs/stream?once=true',
      headers: { cookie: administrator.cookie },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain(`id: ${String(jobId)}:0`);
    const afterDisconnect = await pool.query<{ state: string; cancel_requested_at: Date | null }>(
      'SELECT state, cancel_requested_at FROM noderag.job WHERE id=$1',
      [jobId],
    );
    expect(afterDisconnect.rows[0]).toEqual({ state: 'leased', cancel_requested_at: null });

    expect(await requestJobCancellation(pool, jobId, siloId)).toBe('requested');
    let cancellation: unknown;
    try {
      await heartbeatJob(pool, required(claimed, 'cancellation lease missing'), 5000);
    } catch (error) {
      cancellation = error;
    }
    await failJob(pool, required(claimed, 'cancellation lease missing'), cancellation);
    const cancelled = await pool.query<{ state: string; error_class: string }>(
      'SELECT state, error_class FROM noderag.job WHERE id=$1',
      [jobId],
    );
    expect(cancelled.rows[0]).toEqual({ state: 'cancelled', error_class: 'cancelled' });

    const replay = await app.inject({
      method: 'GET',
      url: '/v1/jobs/stream?once=true',
      headers: { cookie: administrator.cookie, 'last-event-id': `${String(jobId)}:1` },
    });
    expect(replay.body).toContain('event: cancellation_requested');
    expect(replay.body).toContain('event: cancelled');
  });

  it('shares bounded CPU slots while excluding HNSW work from active embedding', async () => {
    let announceEmbedding!: () => void;
    let releaseEmbedding!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => {
      announceEmbedding = resolve;
    });
    const embeddingReleased = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    const heldEmbedder: Embedder = {
      countTokens: async (texts) => texts.map(() => 1),
      embed: async (texts) => {
        announceEmbedding();
        await embeddingReleased;
        return {
          vectors: texts.map(() => [1]),
          tokenCounts: texts.map(() => 1),
          elapsedMilliseconds: 1,
        };
      },
    };
    const embedding = coordinatedEmbedder(pool, 'm05-resource-embed', heldEmbedder).embed(
      ['held'],
      10,
      4,
    );
    await embeddingStarted;
    let indexEntered = false;
    const indexBuild = withHnswBuildResource(pool, 'm05-resource-hnsw', async () => {
      indexEntered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(indexEntered).toBe(false);
    releaseEmbedding();
    await Promise.all([embedding, indexBuild]);
    expect(indexEntered).toBe(true);
    const leases = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM noderag.resource_lease WHERE owner IS NOT NULL`,
    );
    expect(leases.rows[0]?.count).toBe('0');
  });

  it('crawls watched Markdown safely across outage, missing, unchanged-return, and changed-return states', async () => {
    const unicode =
      '# Unicode source\n\nEmoji 👨‍👩‍👧‍👦, rare CJK 𠮷, combining e\u0301, bidi \u2067العربية\u2069, and עברית remain exact.\n';
    const table =
      '| Key | Value |\n| --- | --- |\n' +
      Array.from(
        { length: 50 },
        (_, index) => `| row-${String(index)} | cobalt-${String(index)} |`,
      ).join('\n') +
      '\n';
    await writeFile(join(watchedRoot, 'unicode.md'), `${unicode}\n${table}`, 'utf8');
    await writeFile(join(watchedRoot, 'ignored.md'), '# ignored', 'utf8');
    const created = await app.inject({
      method: 'POST',
      url: '/v1/sources',
      headers: mutationHeaders(administrator, 'm05-source-create-001'),
      payload: {
        siloId,
        uri: watchedRoot,
        includeGlobs: ['**/*.md'],
        excludeGlobs: ['ignored.md'],
        scheduleIntervalMinutes: 60,
        operatorNote: 'manual test crawl; unattended schedule remains disabled',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const sourceId = created.json<{ id: number }>().id;
    const sourceRow = await pool.query<{ schedule_enabled: boolean }>(
      'SELECT schedule_enabled FROM noderag.source WHERE id=$1',
      [sourceId],
    );
    expect(sourceRow.rows[0]?.schedule_enabled).toBe(false);

    const crawl = async (key: string) => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/sources/${String(sourceId)}/crawl`,
        headers: mutationHeaders(administrator, key),
        payload: { siloId },
      });
      expect(response.statusCode, response.body).toBe(202);
      await drain(`m05-crawl-${key}`);
    };
    await crawl('m05-crawl-001');
    const watched = await pool.query<{
      id: unknown;
      source_state: string;
      state: string;
      original_sha256: Buffer;
    }>(
      `SELECT id, source_state, state, original_sha256
       FROM noderag.document WHERE source_id=$1 ORDER BY id`,
      [sourceId],
    );
    expect(watched.rows).toHaveLength(1);
    expect(watched.rows[0]).toMatchObject({ source_state: 'present', state: 'ready' });
    const watchedDocumentId = databaseInteger(watched.rows[0]?.id, 'watched document id');
    const originalHash = required(watched.rows[0], 'watched document missing').original_sha256;

    const offline = `${watchedRoot}-offline`;
    await rename(watchedRoot, offline);
    await crawl('m05-crawl-offline-001');
    const afterOutage = await pool.query<{ source_state: string; state: string }>(
      'SELECT source_state, state FROM noderag.document WHERE id=$1',
      [watchedDocumentId],
    );
    expect(afterOutage.rows[0]).toEqual({ source_state: 'present', state: 'ready' });
    const unhealthy = await pool.query<{ health_state: string }>(
      'SELECT health_state FROM noderag.source WHERE id=$1',
      [sourceId],
    );
    expect(unhealthy.rows[0]?.health_state).toBe('unavailable');

    await rename(offline, watchedRoot);
    const saved = await readFile(join(watchedRoot, 'unicode.md'));
    await rm(join(watchedRoot, 'unicode.md'));
    await crawl('m05-crawl-missing-001');
    const missing = await pool.query<{
      source_state: string;
      state: string;
      missing_since: Date | null;
    }>('SELECT source_state, state, missing_since FROM noderag.document WHERE id=$1', [
      watchedDocumentId,
    ]);
    expect(missing.rows[0]?.source_state).toBe('missing');
    expect(missing.rows[0]?.state).toBe('source_missing');
    expect(missing.rows[0]?.missing_since).toBeInstanceOf(Date);
    const reviewed = await app.inject({
      method: 'POST',
      url: `/v1/sources/${String(sourceId)}/review-missing`,
      headers: mutationHeaders(administrator, 'm05-missing-review-001'),
      payload: {
        siloId,
        documentId: watchedDocumentId,
        operatorNote: 'confirmed absent; retain searchable managed copy',
      },
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const retainedSearch = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie: administrator.cookie },
      payload: { query: 'rare CJK combining bidi', siloIds: [siloId] },
    });
    expect(retainedSearch.json<{ items: unknown[] }>().items.length).toBeGreaterThan(0);

    const jobsBeforeReturn = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM noderag.job WHERE document_id=$1`,
      [watchedDocumentId],
    );
    await writeFile(join(watchedRoot, 'unicode.md'), saved);
    await crawl('m05-crawl-return-001');
    const restored = await pool.query<{
      source_state: string;
      state: string;
      original_sha256: Buffer;
    }>('SELECT source_state, state, original_sha256 FROM noderag.document WHERE id=$1', [
      watchedDocumentId,
    ]);
    expect(restored.rows[0]?.source_state).toBe('present');
    expect(restored.rows[0]?.state).toBe('ready');
    expect(restored.rows[0]?.original_sha256.equals(originalHash)).toBe(true);
    const jobsAfterReturn = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM noderag.job WHERE document_id=$1`,
      [watchedDocumentId],
    );
    expect(jobsAfterReturn.rows[0]?.count).toBe(jobsBeforeReturn.rows[0]?.count);

    await writeFile(
      join(watchedRoot, 'unicode.md'),
      `${unicode}\nChanged authoritative content now mentions a vermilion flywheel.\n`,
      'utf8',
    );
    await crawl('m05-crawl-changed-001');
    const changed = await pool.query<{ state: string; original_sha256: Buffer }>(
      'SELECT state, original_sha256 FROM noderag.document WHERE id=$1',
      [watchedDocumentId],
    );
    expect(changed.rows[0]?.state).toBe('ready');
    expect(changed.rows[0]?.original_sha256.equals(originalHash)).toBe(false);
    const changedSearch = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie: administrator.cookie },
      payload: { query: 'vermilion flywheel', siloIds: [siloId] },
    });
    expect(changedSearch.json<{ items: Array<{ text: string }> }>().items[0]?.text).toContain(
      'vermilion flywheel',
    );

    const enabledSchedule = await app.inject({
      method: 'PATCH',
      url: `/v1/sources/${String(sourceId)}`,
      headers: mutationHeaders(administrator, 'm05-source-schedule-001'),
      payload: { siloId, scheduleEnabled: true, scheduleIntervalMinutes: 120 },
    });
    expect(enabledSchedule.statusCode, enabledSchedule.body).toBe(200);
    expect(enabledSchedule.json()).toMatchObject({
      scheduleEnabled: true,
      scheduleIntervalMinutes: 120,
    });
    await pool.query(
      "UPDATE noderag.source SET next_crawl_at=now() - interval '1 minute' WHERE id=$1",
      [sourceId],
    );
    expect(await enqueueDueSourceCrawls(pool)).toBe(1);
    const scheduled = await pool.query<{ state: string }>(
      `SELECT state FROM noderag.job
       WHERE source_id=$1 AND kind='crawl'
       ORDER BY id DESC LIMIT 1`,
      [sourceId],
    );
    expect(scheduled.rows[0]?.state).toBe('pending');
    const detached = await app.inject({
      method: 'DELETE',
      url: `/v1/sources/${String(sourceId)}`,
      headers: mutationHeaders(administrator, 'm05-source-detach-001'),
      payload: { siloId },
    });
    expect(detached.statusCode, detached.body).toBe(200);
    const detachedDocument = await pool.query<{
      source_id: null;
      source_state: string;
      state: string;
    }>('SELECT source_id, source_state, state FROM noderag.document WHERE id=$1', [
      watchedDocumentId,
    ]);
    expect(detachedDocument.rows[0]).toEqual({
      source_id: null,
      source_state: 'detached',
      state: 'ready',
    });
  });

  it('detects and resolves locator and storage drift through admin health', async () => {
    const verified = await verifyChunkLocators(pool, files, 1000);
    expect(verified.sampled).toBeGreaterThan(0);
    expect(verified.findings).toBe(0);
    const storage = await sweepStorageIntegrity(pool, files);
    expect(storage.findings).toBe(0);

    const target = await pool.query<{
      id: unknown;
      silo_id: number;
      document_id: unknown;
      text: string;
    }>('SELECT id, silo_id, document_id, text FROM noderag.chunk ORDER BY id LIMIT 1');
    const chunk = required(target.rows[0], 'integrity chunk missing');
    await pool.query('UPDATE noderag.chunk SET text=$1 WHERE id=$2 AND silo_id=$3', [
      `${chunk.text} drift`,
      chunk.id,
      chunk.silo_id,
    ]);
    expect((await verifyChunkLocators(pool, files, 1000)).findings).toBeGreaterThan(0);
    const health = await app.inject({
      method: 'GET',
      url: '/v1/admin/health',
      headers: { cookie: administrator.cookie },
    });
    expect(health.statusCode).toBe(200);
    expect(health.json<{ status: string; openFindingCount: number }>()).toMatchObject({
      status: 'degraded',
      openFindingCount: 1,
    });
    await pool.query('UPDATE noderag.chunk SET text=$1 WHERE id=$2 AND silo_id=$3', [
      chunk.text,
      chunk.id,
      chunk.silo_id,
    ]);
    expect((await verifyChunkLocators(pool, files, 1000)).findings).toBe(0);
    const healthy = await app.inject({
      method: 'GET',
      url: '/v1/admin/health',
      headers: { cookie: administrator.cookie },
    });
    expect(healthy.json<{ status: string }>().status).toBe('ok');
  });

  it('resumes document purge after interruption at every destructive boundary', async () => {
    const documentIds = await Promise.all([
      upload(administrator, 'purge-marked.md', '# Marked interruption', 'm05-fault-upload-001'),
      upload(administrator, 'purge-rows.md', '# Rows interruption', 'm05-fault-upload-002'),
      upload(administrator, 'purge-files.md', '# Files interruption', 'm05-fault-upload-003'),
    ]);
    await drain('m05-purge-fault-index');
    const start = async (documentId: number): Promise<number> =>
      required(
        await withTransaction(pool, async (database) => {
          await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [
            `{${String(siloId)}}`,
          ]);
          return startDocumentPurge(database, documentId, siloId, administratorId);
        }),
        'purge operation was not created',
      );

    const markedOperation = await start(documentIds[0]);
    expect(
      (
        await pool.query<{ stage: string }>(
          'SELECT stage FROM noderag.purge_operation WHERE id=$1',
          [markedOperation],
        )
      ).rows[0]?.stage,
    ).toBe('marked');
    expect(
      await purgeDocument(pool, files, {
        documentId: documentIds[0],
        siloId,
        principalId: administratorId,
      }),
    ).toMatchObject({ operationId: markedOperation, stage: 'completed' });

    const rowsOperation = await start(documentIds[1]);
    await expect(
      continueDocumentPurge(pool, files, rowsOperation, {
        afterRowsRemoved: () => {
          throw new Error('simulated-crash-after-rows');
        },
      }),
    ).rejects.toThrow('simulated-crash-after-rows');
    expect(
      (
        await pool.query<{ stage: string }>(
          'SELECT stage FROM noderag.purge_operation WHERE id=$1',
          [rowsOperation],
        )
      ).rows[0]?.stage,
    ).toBe('rows_removed');
    await expect(access(files.paths(documentIds[1]).directoryAbsolute)).resolves.toBeUndefined();
    expect(
      await purgeDocument(pool, files, {
        documentId: documentIds[1],
        siloId,
        principalId: administratorId,
      }),
    ).toMatchObject({ operationId: rowsOperation, stage: 'completed' });

    const filesOperation = await start(documentIds[2]);
    await expect(
      continueDocumentPurge(pool, files, filesOperation, {
        afterFilesRemoved: () => {
          throw new Error('simulated-crash-after-files');
        },
      }),
    ).rejects.toThrow('simulated-crash-after-files');
    expect(
      (
        await pool.query<{ stage: string }>(
          'SELECT stage FROM noderag.purge_operation WHERE id=$1',
          [filesOperation],
        )
      ).rows[0]?.stage,
    ).toBe('files_removed');
    await expect(access(files.paths(documentIds[2]).directoryAbsolute)).rejects.toThrow();
    expect(
      await purgeDocument(pool, files, {
        documentId: documentIds[2],
        siloId,
        principalId: administratorId,
      }),
    ).toMatchObject({ operationId: filesOperation, stage: 'completed' });

    for (const documentId of documentIds) {
      const remaining = await pool.query('SELECT 1 FROM noderag.document WHERE id=$1', [
        documentId,
      ]);
      expect(remaining.rowCount).toBe(0);
      await expect(access(files.paths(documentId).directoryAbsolute)).rejects.toThrow();
    }
  });

  it('enforces exact delete capability and purges files, rows, and shared cache references idempotently', async () => {
    const sharedText =
      '# Purge fixture\n\nThe ultramarine reduction gear has a unique purge-test bearing code. '.repeat(
        20,
      );
    const firstId = await upload(administrator, 'purge-one.md', sharedText, 'm05-purge-upload-001');
    const secondId = await upload(
      administrator,
      'purge-two.md',
      sharedText,
      'm05-purge-upload-002',
    );
    await drain('m05-purge-index');
    const references = await pool.query<{ chunk_sha256: Buffer; model_manifest_id: number }>(
      `SELECT DISTINCT chunk_sha256, b.model_manifest_id
       FROM noderag.chunk c JOIN noderag.build b ON b.id=c.build_id
       WHERE c.document_id=$1`,
      [firstId],
    );
    expect(references.rows.length).toBeGreaterThan(0);
    const before = await pool.query<{ refcount: number }>(
      `SELECT refcount FROM noderag.embedding_cache
       WHERE (chunk_sha256, model_manifest_id) IN (
         SELECT chunk_sha256, b.model_manifest_id
         FROM noderag.chunk c JOIN noderag.build b ON b.id=c.build_id
         WHERE c.document_id=$1
       )`,
      [firstId],
    );
    expect(before.rows.every(({ refcount }) => refcount === 2)).toBe(true);

    const uploadOnlyPassword = 'M05-upload-only-password!';
    const uploadOnly = await pool.query<{ id: unknown }>(
      `INSERT INTO noderag.principal (kind, label) VALUES ('user', 'm05-upload-only') RETURNING id`,
    );
    const uploadOnlyId = databaseInteger(uploadOnly.rows[0]?.id, 'upload-only principal id');
    await pool.query(
      `INSERT INTO noderag.app_user (principal_id, username, password_hash)
       VALUES ($1, 'm05-upload-only', $2)`,
      [uploadOnlyId, await hashPassword(uploadOnlyPassword)],
    );
    await pool.query(
      `INSERT INTO noderag.silo_grant (principal_id, silo_id, capability, granted_by)
       VALUES ($1, $2, 'upload', $3)`,
      [uploadOnlyId, siloId, administratorId],
    );
    const uploadOnlyBrowser = await login('m05-upload-only', uploadOnlyPassword);
    const denied = await app.inject({
      method: 'DELETE',
      url: `/v1/documents/${String(firstId)}`,
      headers: mutationHeaders(uploadOnlyBrowser, 'm05-purge-denied-001'),
      payload: { siloId, confirmDocumentId: firstId },
    });
    expect(denied.statusCode).toBe(404);

    const deleteOnlyPassword = 'M05-delete-only-password!';
    const deleteOnly = await pool.query<{ id: unknown }>(
      `INSERT INTO noderag.principal (kind, label) VALUES ('user', 'm05-delete-only') RETURNING id`,
    );
    const deleteOnlyId = databaseInteger(deleteOnly.rows[0]?.id, 'delete-only principal id');
    await pool.query(
      `INSERT INTO noderag.app_user (principal_id, username, password_hash)
       VALUES ($1, 'm05-delete-only', $2)`,
      [deleteOnlyId, await hashPassword(deleteOnlyPassword)],
    );
    await pool.query(
      `INSERT INTO noderag.silo_grant (principal_id, silo_id, capability, granted_by)
       VALUES ($1, $2, 'delete', $3)`,
      [deleteOnlyId, siloId, administratorId],
    );
    const deleteOnlyBrowser = await login('m05-delete-only', deleteOnlyPassword);
    const invisible = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie: deleteOnlyBrowser.cookie },
      payload: { query: 'ultramarine bearing', siloIds: [siloId] },
    });
    expect(invisible.json()).toEqual({
      items: [],
      mode: 'vector',
      elapsedMs: 0,
      nextCursor: null,
    });

    const firstPurge = await app.inject({
      method: 'DELETE',
      url: `/v1/documents/${String(firstId)}`,
      headers: mutationHeaders(deleteOnlyBrowser, 'm05-purge-delete-001'),
      payload: { siloId, confirmDocumentId: firstId },
    });
    expect(firstPurge.statusCode, firstPurge.body).toBe(202);
    await expect(access(files.paths(firstId).directoryAbsolute)).rejects.toThrow();
    const firstGone = await pool.query('SELECT 1 FROM noderag.document WHERE id=$1', [firstId]);
    expect(firstGone.rowCount).toBe(0);
    for (const reference of references.rows) {
      const cached = await pool.query<{ refcount: number }>(
        `SELECT refcount FROM noderag.embedding_cache
         WHERE chunk_sha256=$1 AND model_manifest_id=$2`,
        [reference.chunk_sha256, reference.model_manifest_id],
      );
      expect(cached.rows[0]?.refcount).toBe(1);
    }
    const replay = await app.inject({
      method: 'DELETE',
      url: `/v1/documents/${String(firstId)}`,
      headers: mutationHeaders(deleteOnlyBrowser, 'm05-purge-delete-001'),
      payload: { siloId, confirmDocumentId: firstId },
    });
    expect(replay.statusCode).toBe(202);

    const secondPurge = await app.inject({
      method: 'DELETE',
      url: `/v1/documents/${String(secondId)}`,
      headers: mutationHeaders(deleteOnlyBrowser, 'm05-purge-delete-002'),
      payload: { siloId, confirmDocumentId: secondId },
    });
    expect(secondPurge.statusCode, secondPurge.body).toBe(202);
    for (const reference of references.rows) {
      const cached = await pool.query(
        `SELECT 1 FROM noderag.embedding_cache
         WHERE chunk_sha256=$1 AND model_manifest_id=$2`,
        [reference.chunk_sha256, reference.model_manifest_id],
      );
      expect(cached.rowCount).toBe(0);
    }
    const operations = await pool.query<{ stage: string }>(
      `SELECT stage FROM noderag.purge_operation
       WHERE document_id IN ($1,$2) ORDER BY document_id`,
      [firstId, secondId],
    );
    expect(operations.rows).toEqual([{ stage: 'completed' }, { stage: 'completed' }]);
  });

  it('purges an entire silo only as server administrator and drops its partition', async () => {
    const extra = await createSilo(pool, {
      slug: 'm05-disposable',
      displayName: 'M05 disposable',
      creatingPrincipalId: administratorId,
    });
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/silos/${String(extra.id)}`,
      headers: mutationHeaders(administrator, 'm05-silo-purge-001'),
      payload: { confirmSlug: extra.slug },
    });
    expect(response.statusCode, response.body).toBe(202);
    const silo = await pool.query('SELECT 1 FROM noderag.silo WHERE id=$1', [extra.id]);
    expect(silo.rowCount).toBe(0);
    const partition = await pool.query<{ name: string | null }>(
      `SELECT to_regclass($1)::text AS name`,
      [`noderag.chunk_s${String(extra.id)}`],
    );
    expect(partition.rows[0]?.name).toBeNull();
  });
});
