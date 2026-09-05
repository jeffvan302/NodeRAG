import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type Embedder, type EmbeddingBatch } from '@noderag/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDeterministicRuntime } from '../../embedder/src/runtime.js';
import { createRequestAuthenticator } from '../src/api/authentication.js';
import { buildApp } from '../src/app.js';
import type { VisionProviderRequest } from '../src/vision/contract.js';
import { VisionProviderError } from '../src/vision/contract.js';
import { DatabaseVisionCache } from '../src/vision/database-cache.js';
import { DeterministicFakeVisionProvider } from '../src/vision/fake.js';
import { VisionProcessor } from '../src/vision/service.js';
import { drainDocumentJobs } from '../src/ingest/pipeline.js';
import { bootstrapFirstAdministrator, issueSetupToken } from '../src/setup/bootstrap.js';
import { DocumentFileStore } from '../src/storage/document-files.js';
import { runMigrations } from '../src/store/migrations.js';
import { createDatabaseReadinessProbe } from '../src/store/readiness.js';
import { SecretVault } from '../src/identity/secrets.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

const fixture = (...parts: string[]): string =>
  join(process.cwd(), 'fixtures', 'formats', ...parts);

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

class DeterministicEmbedder implements Embedder {
  private readonly runtime = createDeterministicRuntime();

  countTokens(texts: readonly string[]) {
    return this.runtime.countTokens(texts);
  }

  embed(texts: readonly string[], maximumTokens: number): Promise<EmbeddingBatch> {
    return this.runtime.embed(texts, maximumTokens);
  }
}

class RecoverableVisionProvider extends DeterministicFakeVisionProvider {
  online = true;
  confidence = 0.99;

  override async analyse(request: VisionProviderRequest) {
    if (!this.online) {
      throw new VisionProviderError('vision-provider-unreachable', 'transient');
    }
    return { ...(await super.analyse(request)), confidence: this.confidence };
  }
}

describe.sequential('M07 vision and bad-PDF recovery', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let root: string;
  let files: DocumentFileStore;
  let siloId: number;
  let app: ReturnType<typeof buildApp>;
  let cookie: string | string[] | undefined;
  let csrf: string;
  let provider: RecoverableVisionProvider;
  let vision: VisionProcessor;
  let secretVault: SecretVault;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(postgresImage)
      .withDatabase('noderag_vision')
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
    // Testcontainers terminates PostgreSQL immediately after the pool closes. On
    // slower CI hosts, pg can still surface the server's 57P01 shutdown notice
    // from an idle client; keep that expected teardown signal from becoming an
    // unhandled Vitest exception.
    pool.on('error', () => undefined);
    const setup = await bootstrapFirstAdministrator(pool, {
      setupToken: await issueSetupToken(pool),
      username: 'm07-admin',
      password: 'M07-admin-password!',
    });
    siloId = setup.defaultSilo.id;
    root = await mkdtemp(join(tmpdir(), 'noderag-m07-'));
    files = new DocumentFileStore(root);
    await files.initialize();
    provider = new RecoverableVisionProvider();
    secretVault = new SecretVault(Buffer.alloc(32, 0x57));
    vision = new VisionProcessor({
      provider,
      cache: new DatabaseVisionCache(pool),
      maximumAttempts: 1,
    });
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
        embedder: new DeterministicEmbedder(),
        maximumUploadBytes: 4 * 1024 * 1024,
        minimumFreeBytes: 0,
        secretVault,
      },
    });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'm07-admin', password: 'M07-admin-password!' },
    });
    expect(login.statusCode).toBe(200);
    cookie = login.headers['set-cookie'];
    csrf = login.json<{ csrfToken: string }>().csrfToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
    await rm(root, { recursive: true, force: true });
  });

  const upload = async (filename: string, mimeType: string, bytes: Buffer, key: string) => {
    const body = multipart(filename, mimeType, bytes);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/documents?siloId=${String(siloId)}`,
      headers: {
        cookie,
        origin: 'http://noderag.test',
        'x-csrf-token': csrf,
        'idempotency-key': key,
        'content-type': body.contentType,
      },
      payload: body.payload,
    });
    expect(response.statusCode, response.body).toBe(202);
    return response.json<{ documentId: number }>().documentId;
  };

  it('renders, analyses, persists, caches, and indexes a scanned PDF page', async () => {
    const documentId = await upload(
      'scanned.pdf',
      'application/pdf',
      await readFile(fixture('pdf', 'scanned.pdf')),
      'm07-scanned-pdf',
    );
    expect(
      await drainDocumentJobs({
        pool,
        files,
        embedder: new DeterministicEmbedder(),
        leaseOwner: 'm07-scan-worker',
        vision,
      }),
    ).toBe(2);
    const document = await pool.query<{ state: string; page_basis: string }>(
      'SELECT state, page_basis FROM noderag.document WHERE id = $1',
      [documentId],
    );
    expect(document.rows[0]).toEqual({ state: 'ready', page_basis: 'exact' });
    const image = await pool.query<{
      state: string;
      media_type: string;
      storage_path: string;
      vision_kind: string;
      vision_confidence: number;
    }>(
      `SELECT state, media_type, storage_path, vision_kind, vision_confidence
       FROM noderag.document_image WHERE document_id = $1`,
      [documentId],
    );
    expect(image.rows[0]).toMatchObject({
      state: 'analysed',
      media_type: 'image/png',
      vision_kind: 'table',
      vision_confidence: 0.99,
    });
    expect(image.rows[0]?.storage_path).toMatch(/^documents\//u);
    const markdown = await readFile(files.paths(documentId).markdownAbsolute, 'utf8');
    expect(markdown).toContain('noderag:vision');
    expect(markdown).toContain('Vision fixture');
    const chunks = await pool.query<{ text: string }>(
      'SELECT text FROM noderag.chunk WHERE document_id = $1',
      [documentId],
    );
    expect(chunks.rows.some(({ text }) => text.includes('Vision fixture'))).toBe(true);
    const cache = await pool.query<{ refcount: number }>(
      'SELECT refcount FROM noderag.vision_cache',
    );
    expect(cache.rows).toContainEqual({ refcount: 1 });
  });

  it('activates a bearer-protected reverse proxy only after the live schema test passes', async () => {
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
      if (String(input).endsWith('/api/tags')) {
        return Response.json({
          models: [{ name: 'vision-model:latest', digest: 'sha256:vision-model' }],
        });
      }
      return Response.json({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            kind: 'table',
            markdown: '| Asset | State |\n| --- | --- |\n| Pump | Ready |',
            alt: 'Asset state table',
            confidence: 0.97,
          }),
        },
      });
    });
    vi.stubGlobal('fetch', providerFetch);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/admin/vision/test',
        headers: {
          cookie,
          origin: 'http://noderag.test',
          'x-csrf-token': csrf,
          'idempotency-key': 'm07-provider-activation',
        },
        payload: {
          baseUrl: 'https://vision.proxy.example/ollama',
          model: 'vision-model:latest',
          bearerToken: 'synthetic-token',
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        activated: true,
        bearerTokenPersisted: true,
        securityWarning: null,
      });
      const stored = await pool.query<{
        ollama_base_url: string;
        ollama_model_revision: string;
        ollama_secret_id: string | null;
      }>(
        `SELECT ollama_base_url, ollama_model_revision, ollama_secret_id
         FROM noderag.settings WHERE id = 1`,
      );
      expect(stored.rows[0]).toMatchObject({
        ollama_base_url: 'https://vision.proxy.example/ollama',
        ollama_model_revision: 'sha256:vision-model',
      });
      expect(stored.rows[0]?.ollama_secret_id).not.toBeNull();
      await expect(secretVault.reveal(pool, 'ollama', 'bearer-token')).resolves.toBe(
        'synthetic-token',
      );
      const status = await app.inject({
        method: 'GET',
        url: '/v1/admin/vision/status',
        headers: { cookie },
      });
      expect(status.statusCode, status.body).toBe(200);
      expect(status.json()).toMatchObject({
        settings: { credentialConfigured: true, maximumParallel: 2 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('finishes text ingestion offline, exposes estimates, and recovers by manual retry', async () => {
    provider.online = false;
    const documentId = await upload(
      'mixed.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      await readFile(fixture('docx', 'tables-images-footnotes.docx')),
      'm07-offline-docx',
    );
    expect(
      await drainDocumentJobs({
        pool,
        files,
        embedder: new DeterministicEmbedder(),
        leaseOwner: 'm07-offline-worker',
        vision,
      }),
    ).toBe(3);
    const offline = await pool.query<{ state: string }>(
      'SELECT state FROM noderag.document WHERE id = $1',
      [documentId],
    );
    expect(offline.rows[0]?.state).toBe('awaiting_vision');
    const pending = await pool.query<{ state: string; last_error_code: string }>(
      'SELECT state, last_error_code FROM noderag.document_image WHERE document_id = $1',
      [documentId],
    );
    expect(pending.rows[0]).toEqual({
      state: 'pending_vision',
      last_error_code: 'vision-provider-unreachable',
    });
    const textChunks = await pool.query('SELECT 1 FROM noderag.chunk WHERE document_id = $1', [
      documentId,
    ]);
    expect(textChunks.rowCount).toBeGreaterThan(0);

    const estimate = await app.inject({
      method: 'GET',
      url: `/v1/documents/${String(documentId)}/vision-estimate`,
      headers: { cookie },
    });
    expect(estimate.statusCode, estimate.body).toBe(200);
    expect(estimate.json()).toMatchObject({ projectedCalls: 1 });

    provider.online = true;
    provider.confidence = 0.35;
    const retry = await app.inject({
      method: 'POST',
      url: '/v1/admin/vision/retry',
      headers: {
        cookie,
        origin: 'http://noderag.test',
        'x-csrf-token': csrf,
        'idempotency-key': 'm07-manual-vision-retry',
      },
      payload: { documentId },
    });
    expect(retry.statusCode, retry.body).toBe(202);
    expect(retry.json()).toMatchObject({ accepted: true, scheduled: 1 });
    expect(
      await drainDocumentJobs({
        pool,
        files,
        embedder: new DeterministicEmbedder(),
        leaseOwner: 'm07-recovery-worker',
        vision,
      }),
    ).toBe(2);
    const recovered = await pool.query<{
      state: string;
      metadata: { extractionWarnings: readonly string[] };
    }>('SELECT state, metadata FROM noderag.document WHERE id = $1', [documentId]);
    expect(recovered.rows[0]?.state).toBe('ready');
    expect(recovered.rows[0]?.metadata.extractionWarnings).toContain(
      'docx-image-low-vision-confidence',
    );
    const dispatches = await pool.query<{ state: string }>(
      'SELECT state FROM noderag.vision_dispatch ORDER BY id',
    );
    expect(dispatches.rows.map(({ state }) => state)).toContain('failed');
    expect(dispatches.rows.map(({ state }) => state)).toContain('validated');
  });

  it('warns before a projected 400-page scan and reports admin counts', async () => {
    const found = await pool.query<{ id: string }>(
      "SELECT id::text FROM noderag.document WHERE extension = 'pdf' ORDER BY id LIMIT 1",
    );
    const documentId = Number(found.rows[0]?.id);
    await pool.query(
      `INSERT INTO noderag.document_page
         (document_id, silo_id, ordinal, page_number, label, character_start, character_end,
          byte_start, byte_end, extraction, extraction_confidence)
       SELECT $1, $2, ordinal, ordinal + 1, (ordinal + 1)::text, 0, 0, 0, 0, 'vision', 0
       FROM generate_series(1, 399) ordinal`,
      [documentId, siloId],
    );
    const estimate = await app.inject({
      method: 'GET',
      url: `/v1/documents/${String(documentId)}/vision-estimate`,
      headers: { cookie },
    });
    expect(estimate.statusCode, estimate.body).toBe(200);
    expect(estimate.json()).toMatchObject({
      scanPages: 400,
      warnings: ['large-scan-provider-cost-and-time'],
    });
    const status = await app.inject({
      method: 'GET',
      url: '/v1/admin/vision/status',
      headers: { cookie },
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({ warnings: ['large-scan-provider-cost-and-time'] });
  });
});
