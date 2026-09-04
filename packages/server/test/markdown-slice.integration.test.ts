import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sliceUtf8, type Embedder, type EmbeddingBatch } from '@noderag/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeterministicRuntime } from '../../embedder/src/runtime.js';
import { buildApp } from '../src/app.js';
import { createRequestAuthenticator } from '../src/api/authentication.js';
import { createDatabaseReadinessProbe } from '../src/store/readiness.js';
import { bootstrapFirstAdministrator, issueSetupToken } from '../src/setup/bootstrap.js';
import { runMigrations } from '../src/store/migrations.js';
import { DocumentFileStore } from '../src/storage/document-files.js';
import { drainMarkdownJobs } from '../src/ingest/pipeline.js';
import { hashPassword } from '../src/identity/passwords.js';
import { claimNextJob } from '../src/store/jobs.js';
import { withTransaction } from '../src/store/database.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

const multipart = (filename: string, mimeType: string, body: Buffer) => {
  const boundary = `noderag-${crypto.randomUUID()}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
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

describe.sequential('M04 Markdown vertical slice', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let root: string;
  let files: DocumentFileStore;
  let siloId: number;
  let app: ReturnType<typeof buildApp>;
  const embedder = new CountingEmbedder();
  const password = 'M04-admin-password!';

  beforeAll(async () => {
    container = await new PostgreSqlContainer(postgresImage)
      .withDatabase('noderag_markdown')
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
    const token = await issueSetupToken(pool);
    const setup = await bootstrapFirstAdministrator(pool, {
      setupToken: token,
      username: 'm04-admin',
      password,
    });
    siloId = setup.defaultSilo.id;
    root = await mkdtemp(join(tmpdir(), 'noderag-m04-'));
    files = new DocumentFileStore(root);
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
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('streams, resumes, normalizes, caches, and retrieves exact scoped passages', async () => {
    const unauthenticatedBody = multipart(
      'unauthenticated.md',
      'text/markdown',
      Buffer.from('# No'),
    );
    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/v1/documents?siloId=${String(siloId)}`,
      headers: {
        'idempotency-key': 'm04-unauthenticated-001',
        'content-type': unauthenticatedBody.contentType,
      },
      payload: unauthenticatedBody.payload,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'm04-admin', password },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];
    const csrf = login.json<{ csrfToken: string }>().csrfToken;
    const oversizedBody = multipart(
      'oversized.md',
      'text/markdown',
      Buffer.alloc(2 * 1024 * 1024 + 1, 0x61),
    );
    const oversized = await app.inject({
      method: 'POST',
      url: `/v1/documents?siloId=${String(siloId)}`,
      headers: {
        cookie,
        origin: 'http://noderag.test',
        'x-csrf-token': csrf,
        'idempotency-key': 'm04-oversized-001',
        'content-type': oversizedBody.contentType,
      },
      payload: oversizedBody.payload,
    });
    expect(oversized.statusCode).toBe(413);

    const sourceText = `\uFEFF# Cafe\u0301 maintenance\r\n\r\n${'Quarterly turbine maintenance costs are tracked in the cobalt ledger. '.repeat(45)}\r\n`;
    const uploadBody = multipart(
      'maintenance.md',
      'text/markdown',
      Buffer.from(sourceText, 'utf8'),
    );
    const uploadHeaders = {
      cookie,
      origin: 'http://noderag.test',
      'x-csrf-token': csrf,
      'idempotency-key': 'm04-upload-maintenance-001',
      'content-type': uploadBody.contentType,
    };
    const uploaded = await app.inject({
      method: 'POST',
      url: `/v1/documents?siloId=${String(siloId)}`,
      headers: uploadHeaders,
      payload: uploadBody.payload,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(202);
    expect(uploaded.headers['idempotency-replayed']).toBe('false');
    const accepted = uploaded.json<{ documentId: number; jobId: number }>();

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/documents?siloId=${String(siloId)}`,
      headers: uploadHeaders,
      payload: uploadBody.payload,
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toMatchObject({ documentId: accepted.documentId, jobId: accepted.jobId });

    const unsupportedBody = multipart('not-markdown.html', 'text/html', Buffer.from('text'));
    const unsupported = await app.inject({
      method: 'POST',
      url: `/v1/documents?siloId=${String(siloId)}`,
      headers: {
        ...uploadHeaders,
        'idempotency-key': 'm04-unsupported-001',
        'content-type': unsupportedBody.contentType,
      },
      payload: unsupportedBody.payload,
    });
    expect(unsupported.statusCode).toBe(415);

    const firstDrain = await drainMarkdownJobs({
      pool,
      files,
      embedder,
      leaseOwner: 'm04-worker-first',
    });
    const firstJobs = await pool.query(
      `SELECT id, kind, state, last_error_code, last_error_detail FROM noderag.job ORDER BY id`,
    );
    expect(firstDrain, JSON.stringify(firstJobs.rows)).toBe(2);
    const canonical = await readFile(files.paths(accepted.documentId).markdownAbsolute, 'utf8');
    expect(canonical.startsWith('# Café maintenance\n\n')).toBe(true);
    expect(canonical).not.toContain('\r');
    const firstEmbedCount = embedder.embeddedTexts;
    expect(firstEmbedCount).toBeGreaterThan(0);

    const duplicateBody = multipart(
      'duplicate.md',
      'text/markdown',
      Buffer.from(sourceText, 'utf8'),
    );
    const duplicate = await app.inject({
      method: 'POST',
      url: `/v1/documents?siloId=${String(siloId)}`,
      headers: {
        ...uploadHeaders,
        'idempotency-key': 'm04-upload-maintenance-002',
        'content-type': duplicateBody.contentType,
      },
      payload: duplicateBody.payload,
    });
    expect(duplicate.statusCode).toBe(202);
    const deadLease = await claimNextJob(pool, 'dead-worker', 1000);
    expect(deadLease?.kind).toBe('extract');
    await pool.query(
      `UPDATE noderag.job SET leased_until = now() - interval '1 second' WHERE id = $1`,
      [deadLease?.id],
    );
    expect(
      await drainMarkdownJobs({ pool, files, embedder, leaseOwner: 'm04-worker-restarted' }),
    ).toBe(2);
    expect(embedder.embeddedTexts).toBe(firstEmbedCount);

    const cache = await pool.query<{ refcount: number }>(
      `SELECT refcount FROM noderag.embedding_cache ORDER BY chunk_sha256`,
    );
    expect(cache.rows.length).toBe(firstEmbedCount);
    expect(cache.rows.every(({ refcount }) => refcount === 2)).toBe(true);

    const search = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie },
      payload: { query: 'cobalt ledger turbine costs', siloIds: [siloId], limit: 5 },
    });
    expect(search.statusCode).toBe(200);
    const hits = search.json<{
      items: Array<{
        siloId: number;
        documentId: number;
        text: string;
        locator: {
          characterStart: number;
          characterEnd: number;
          byteStart: number;
          byteEnd: number;
        };
      }>;
    }>().items;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(({ siloId: found }) => found === siloId)).toBe(true);
    const hit = hits[0];
    expect(hit).toBeDefined();
    expect(canonical.slice(hit?.locator.characterStart, hit?.locator.characterEnd)).toBe(hit?.text);
    expect(sliceUtf8(canonical, hit?.locator.byteStart ?? 0, hit?.locator.byteEnd ?? 0)).toBe(
      hit?.text,
    );

    const page = await withTransaction(pool, async (database) => {
      await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [`{${String(siloId)}}`]);
      return database.query<{ character_end: number; byte_end: number }>(
        `SELECT character_end, byte_end FROM noderag.document_page WHERE document_id = $1`,
        [accepted.documentId],
      );
    });
    expect(page.rows[0]).toEqual({
      character_end: canonical.length,
      byte_end: Buffer.byteLength(canonical, 'utf8'),
    });
    const audit = await pool.query<{ query_sha256: Buffer; detail: Record<string, unknown> }>(
      `SELECT query_sha256, detail FROM noderag.audit_log WHERE action = 'search' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.query_sha256).toHaveLength(32);
    expect(JSON.stringify(audit.rows[0]?.detail)).not.toContain('cobalt');

    const embeddedBeforeInvalidSearch = embedder.embeddedTexts;
    const invalidSearch = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie },
      payload: { query: '', siloIds: [siloId] },
    });
    expect(invalidSearch.statusCode).toBe(400);
    expect(invalidSearch.json()).toMatchObject({ code: 'invalid_request' });
    expect(embedder.embeddedTexts).toBe(embeddedBeforeInvalidSearch);

    const zeroGrantPassword = 'M04-zero-grant-password!';
    const zeroGrant = await pool.query<{ id: number }>(
      `INSERT INTO noderag.principal (kind, label)
       VALUES ('user', 'm04-zero-grant') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO noderag.app_user (principal_id, username, password_hash)
       VALUES ($1, 'm04-zero-grant', $2)`,
      [zeroGrant.rows[0]?.id, await hashPassword(zeroGrantPassword)],
    );
    const zeroLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'm04-zero-grant', password: zeroGrantPassword },
    });
    expect(zeroLogin.statusCode).toBe(200);
    const embeddedBeforeDeniedSearch = embedder.embeddedTexts;
    const deniedSearch = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie: zeroLogin.headers['set-cookie'] },
      payload: { query: 'cobalt ledger turbine costs', siloIds: [siloId], limit: 5 },
    });
    expect(deniedSearch.statusCode).toBe(200);
    expect(deniedSearch.json()).toEqual({
      items: [],
      mode: 'vector',
      elapsedMs: 0,
      nextCursor: null,
    });
    expect(embedder.embeddedTexts).toBe(embeddedBeforeDeniedSearch);
  });
});
