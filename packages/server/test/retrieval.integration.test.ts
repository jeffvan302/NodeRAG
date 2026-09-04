import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Embedder } from '@noderag/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeterministicRuntime } from '../../embedder/src/runtime.js';
import { buildApp } from '../src/app.js';
import { createRequestAuthenticator } from '../src/api/authentication.js';
import { createApiKey } from '../src/identity/api-keys.js';
import { setSiloCapability, createSilo } from '../src/store/silos.js';
import { bootstrapFirstAdministrator, issueSetupToken } from '../src/setup/bootstrap.js';
import { DocumentFileStore } from '../src/storage/document-files.js';
import { runMigrations } from '../src/store/migrations.js';
import { createDatabaseReadinessProbe } from '../src/store/readiness.js';
import { drainDocumentJobs } from '../src/ingest/pipeline.js';

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

describe.sequential('M08 retrieval, MCP, and gateway parity', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let root: string;
  let files: DocumentFileStore;
  let app: ReturnType<typeof buildApp>;
  let gatewayApp: ReturnType<typeof buildApp>;
  let administratorId: number;
  let firstSiloId: number;
  let secondSiloId: number;
  let firstDocumentId: number;
  let secondDocumentId: number;
  let firstChunkId: number;
  let cookie: string;
  let csrf: string;
  let searchOnlyToken: string;
  const embedder: Embedder = createDeterministicRuntime();

  beforeAll(async () => {
    container = await new PostgreSqlContainer(postgresImage)
      .withDatabase('noderag_m08')
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
    const setup = await bootstrapFirstAdministrator(pool, {
      setupToken: await issueSetupToken(pool),
      username: 'm08-admin',
      password: 'M08-admin-password!',
    });
    administratorId = setup.principalId;
    firstSiloId = setup.defaultSilo.id;
    secondSiloId = (
      await createSilo(pool, {
        slug: 'research',
        displayName: 'Research',
        creatingPrincipalId: administratorId,
      })
    ).id;
    root = await mkdtemp(join(tmpdir(), 'noderag-m08-'));
    files = new DocumentFileStore(root);
    await files.initialize();
    const authenticate = createRequestAuthenticator(pool, 'http://noderag.test');
    const content = {
      pool,
      authenticate,
      files,
      embedder,
      maximumUploadBytes: 2 * 1024 * 1024,
      minimumFreeBytes: 0,
    };
    app = buildApp({
      logger: false,
      readiness: createDatabaseReadinessProbe(database),
      uiRoot: join(root, 'missing-ui'),
      identity: { pool, expectedOrigin: 'http://noderag.test', secureCookie: false, authenticate },
      content,
    });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'm08-admin', password: 'M08-admin-password!' },
    });
    cookie = login.headers['set-cookie'] as string;
    csrf = login.json<{ csrfToken: string }>().csrfToken;

    const upload = async (siloId: number, filename: string, text: string, key: string) => {
      const body = multipart(filename, Buffer.from(text, 'utf8'));
      const accepted = await app.inject({
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
      expect(accepted.statusCode, accepted.body).toBe(202);
      return accepted.json<{ documentId: number }>().documentId;
    };
    firstDocumentId = await upload(
      firstSiloId,
      'legal-register.md',
      `# Legal register\n\nZX-991 termination notice is thirty days.\n\n| code | days |\n|---|---:|\n| ZX-991 | 30 |\n\n${'The legal cobalt register preserves contract notice evidence. '.repeat(60)}`,
      'm08-upload-legal-001',
    );
    secondDocumentId = await upload(
      secondSiloId,
      'research-register.md',
      `# Research register\n\nRX-204 catalyst calibration is reviewed weekly.\n\n${'The research amber register preserves laboratory observations. '.repeat(60)}`,
      'm08-upload-research-001',
    );
    expect(await drainDocumentJobs({ pool, files, embedder, leaseOwner: 'm08-worker' })).toBe(4);
    const chunk = await pool.query<{ id: string }>(
      `SELECT id::text FROM noderag.chunk WHERE silo_id=$1 AND document_id=$2 ORDER BY ordinal LIMIT 1`,
      [firstSiloId, firstDocumentId],
    );
    firstChunkId = Number(chunk.rows[0]?.id);
    const gateway = await pool.query<{ id: number }>(
      `INSERT INTO noderag.gateway(name,port,silo_ids,created_by) VALUES('legal-test',NULL,$1,$2) RETURNING id`,
      [[firstSiloId], administratorId],
    );
    const gatewayId = gateway.rows[0]?.id;
    if (gatewayId === undefined) throw new Error('Gateway insertion returned no id.');
    gatewayApp = buildApp({
      logger: false,
      readiness: createDatabaseReadinessProbe(database),
      uiRoot: join(root, 'missing-ui'),
      content,
      gatewayId,
      gatewaySurface: true,
    });
    await gatewayApp.ready();
    const key = await createApiKey(pool, { label: 'm08-search-only', createdBy: administratorId });
    searchOnlyToken = key.token;
    await setSiloCapability(pool, administratorId, key.principalId, firstSiloId, 'read', true);
    await setSiloCapability(pool, administratorId, key.principalId, secondSiloId, 'read', true);
  });

  afterAll(async () => {
    await gatewayApp.close();
    await app.close();
    await pool.end();
    await container.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('supports deterministic vector, keyword, and RRF hybrid modes with bounded filters', async () => {
    for (const mode of ['vector', 'keyword', 'hybrid'] as const) {
      const result = await app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { cookie },
        payload: {
          query: mode === 'vector' ? 'contract notice evidence' : 'ZX-991',
          mode,
          silos: [firstSiloId],
          limit: 10,
        },
      });
      expect(result.statusCode, result.body).toBe(200);
      const items = result.json<{
        items: Array<{
          documentId: number;
          locator: { characterUnit: string; byteUnit: string };
          document: { originalAvailable: boolean };
        }>;
      }>().items;
      expect(items[0]).toMatchObject({
        documentId: firstDocumentId,
        locator: { characterUnit: 'utf16', byteUnit: 'utf8' },
        document: { originalAvailable: true },
      });
    }
    const filtered = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie },
      payload: { query: 'ZX-991', mode: 'keyword', filters: { formats: ['pdf'] } },
    });
    expect(filtered.json<{ items: unknown[] }>().items).toEqual([]);
    const table = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie },
      payload: { query: 'ZX-991', mode: 'keyword', filters: { hasTables: true } },
    });
    expect(table.statusCode, table.body).toBe(200);
  });

  it('returns pre-split context and keeps search-only credentials away from whole artifacts', async () => {
    const context = await app.inject({
      method: 'GET',
      url: `/v1/documents/${String(firstDocumentId)}/pages/0?highlight=${String(firstChunkId)}`,
      headers: { cookie },
    });
    expect(context.statusCode, context.body).toBe(200);
    expect(context.json<{ context: { match: string } }>().context.match.length).toBeGreaterThan(0);
    const denied = await app.inject({
      method: 'GET',
      url: `/v1/documents/${String(firstDocumentId)}/markdown`,
      headers: { authorization: `Bearer ${searchOnlyToken}` },
    });
    expect(denied.statusCode).toBe(404);
    const allowed = await app.inject({
      method: 'GET',
      url: `/v1/chunks/${String(firstChunkId)}/context`,
      headers: { authorization: `Bearer ${searchOnlyToken}` },
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    const deniedPageTool = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${searchOnlyToken}` },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_document_page',
          arguments: {
            documentId: firstDocumentId,
            pageOrdinal: 0,
            highlightChunkId: firstChunkId,
          },
        },
      },
    });
    expect(deniedPageTool.statusCode, deniedPageTool.body).toBe(200);
    expect(deniedPageTool.json<{ result: { isError: boolean } }>().result.isError).toBe(true);
  });

  it('makes REST and MCP return the same scoped result while gateways only narrow', async () => {
    const payload = {
      query: 'ZX-991',
      mode: 'keyword',
      silos: [firstSiloId, secondSiloId],
      limit: 10,
    };
    const rest = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie },
      payload,
    });
    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { cookie },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'search_documents',
          arguments: {
            query: payload.query,
            mode: payload.mode,
            siloIds: payload.silos,
            limit: payload.limit,
          },
        },
      },
    });
    const restIds = rest
      .json<{ items: Array<{ chunkId: number }> }>()
      .items.map(({ chunkId }) => chunkId);
    const mcpIds = mcp
      .json<{ result: { structuredContent: { result: { items: Array<{ chunkId: number }> } } } }>()
      .result.structuredContent.result.items.map(({ chunkId }) => chunkId);
    expect(mcpIds).toEqual(restIds);
    const narrowed = await gatewayApp.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie },
      payload: {
        query: 'register',
        mode: 'keyword',
        silos: [firstSiloId, secondSiloId],
        limit: 10,
      },
    });
    expect(
      narrowed
        .json<{ items: Array<{ siloId: number }> }>()
        .items.every(({ siloId }) => siloId === firstSiloId),
    ).toBe(true);
    const allowedDocument = await gatewayApp.inject({
      method: 'GET',
      url: `/v1/documents/${String(firstDocumentId)}/markdown`,
      headers: { cookie },
    });
    expect(allowedDocument.statusCode, allowedDocument.body).toBe(200);
    const excludedDocument = await gatewayApp.inject({
      method: 'GET',
      url: `/v1/documents/${String(secondDocumentId)}/markdown`,
      headers: { cookie },
    });
    expect(excludedDocument.statusCode).toBe(404);
  });

  it('rejects cursor tampering and never stores raw search text in logs or audit details', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie },
      payload: { query: 'register', mode: 'keyword', limit: 1 },
    });
    const cursor = first.json<{ nextCursor: string | null }>().nextCursor;
    expect(cursor).not.toBeNull();
    const tampered = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie },
      payload: { query: 'register', mode: 'keyword', limit: 1, cursor: `${cursor}x` },
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.headers['content-type']).toContain('application/problem+json');
    const audit = await pool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM noderag.audit_log WHERE action='search' ORDER BY id DESC LIMIT 1`,
    );
    const serialized = JSON.stringify(audit.rows[0]?.detail);
    expect(serialized).not.toContain('register');
    expect(audit.rows[0]?.detail).toMatchObject({
      queryLength: 8,
      mode: 'keyword',
      hitCount: 2,
      outcome: 'ok',
    });
    const forbiddenAdmin = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit',
      headers: { authorization: `Bearer ${searchOnlyToken}` },
    });
    expect(forbiddenAdmin.statusCode).toBe(403);
    expect(forbiddenAdmin.headers['content-type']).toContain('application/problem+json');
  });

  it('serves every administration read surface from the migrated schema', async () => {
    const paths = [
      '/v1/admin/silos',
      '/v1/admin/principals',
      '/v1/admin/grants',
      '/v1/admin/gateways',
      '/v1/admin/audit',
      '/v1/admin/health',
      '/v1/admin/vision/status',
      '/v1/admin/settings',
      '/v1/admin/models',
      '/v1/admin/builds',
      '/v1/admin/storage',
      '/v1/admin/backups',
      '/v1/admin/restores',
      '/v1/admin/evaluation',
    ];
    for (const url of paths) {
      const result = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(result.statusCode, `${url}: ${result.body}`).toBe(200);
      expect(result.headers['x-request-id']).toBeTruthy();
    }
  });

  it('normalizes legacy route failures to RFC 9457 problem details', async () => {
    const result = await app.inject({ method: 'GET', url: '/v1/sources' });
    expect(result.statusCode).toBe(401);
    expect(result.headers['content-type']).toContain('application/problem+json');
    expect(result.json()).toMatchObject({
      status: 401,
      code: 'authentication_required',
      instance: expect.stringMatching(/^urn:noderag:request:/),
      requestId: expect.any(String),
    });
  });

  it('executes the administration mutation family with CSRF and idempotency', async () => {
    let sequence = 0;
    const mutate = async (
      method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      url: string,
      payload: Readonly<Record<string, unknown>>,
      key = `m08-admin-mutation-${String(++sequence).padStart(3, '0')}`,
    ) =>
      app.inject({
        method,
        url,
        headers: {
          cookie,
          origin: 'http://noderag.test',
          'x-csrf-token': csrf,
          'idempotency-key': key,
        },
        payload,
      });

    const siloPayload = { slug: 'm08-api-silo', displayName: 'M08 API Silo' };
    const siloKey = 'm08-admin-silo-create-001';
    const siloCreated = await mutate('POST', '/v1/admin/silos', siloPayload, siloKey);
    expect(siloCreated.statusCode, siloCreated.body).toBe(201);
    const siloId = siloCreated.json<{ id: number }>().id;
    const siloReplay = await mutate('POST', '/v1/admin/silos', siloPayload, siloKey);
    expect(siloReplay.statusCode).toBe(201);
    expect(siloReplay.json<{ id: number }>().id).toBe(siloId);
    const siloConflict = await mutate(
      'POST',
      '/v1/admin/silos',
      { ...siloPayload, displayName: 'Changed' },
      siloKey,
    );
    expect(siloConflict.statusCode).toBe(409);
    expect(
      (
        await mutate('PATCH', `/v1/admin/silos/${String(siloId)}`, {
          displayName: 'M08 API Silo Updated',
        })
      ).statusCode,
    ).toBe(200);

    const user = await mutate('POST', '/v1/admin/principals', {
      username: 'm08-api-user',
      password: 'M08-api-user-password!',
      mustChange: false,
    });
    expect(user.statusCode, user.body).toBe(201);
    const userId = user.json<{ id: number }>().id;
    expect(
      (await mutate('PATCH', `/v1/admin/principals/${String(userId)}`, { label: 'API User' }))
        .statusCode,
    ).toBe(200);

    const apiKey = await mutate('POST', '/v1/admin/api-keys', {
      label: 'm08-admin-created-key',
      searchOnly: true,
      ratePerMinute: 30,
    });
    expect(apiKey.statusCode, apiKey.body).toBe(201);
    const apiKeyPrincipalId = apiKey.json<{ principalId: number }>().principalId;
    const grantPath = `/v1/admin/grants/${String(apiKeyPrincipalId)}/${String(siloId)}/read`;
    expect((await mutate('PUT', grantPath, {})).statusCode).toBe(200);
    expect((await mutate('DELETE', grantPath, {})).statusCode).toBe(204);
    expect(
      (await mutate('DELETE', `/v1/admin/api-keys/${String(apiKeyPrincipalId)}`, {})).statusCode,
    ).toBe(204);

    const gateway = await mutate('POST', '/v1/admin/gateways', {
      name: 'M08TestGateway',
      port: null,
      siloIds: [siloId],
      enabled: false,
    });
    expect(gateway.statusCode, gateway.body).toBe(201);
    const gatewayId = gateway.json<{ id: number }>().id;
    expect(
      (
        await mutate('PATCH', `/v1/admin/gateways/${String(gatewayId)}`, {
          name: 'M08TestGatewayUpdated',
        })
      ).statusCode,
    ).toBe(200);
    expect((await mutate('DELETE', `/v1/admin/gateways/${String(gatewayId)}`, {})).statusCode).toBe(
      204,
    );

    expect((await mutate('PUT', '/v1/admin/settings', { efSearch: 120 })).statusCode).toBe(200);
    const storageProbe = await mutate('POST', '/v1/admin/storage/probe', {
      managedPath: join(root, 'storage-probe'),
    });
    expect(storageProbe.statusCode, storageProbe.body).toBe(200);
    expect(storageProbe.json()).toMatchObject({
      writable: true,
      availableBytes: expect.stringMatching(/^\d+$/),
      totalBytes: expect.stringMatching(/^\d+$/),
    });
    const calibration = await mutate('POST', '/v1/admin/calibration/embedding', {});
    expect(calibration.statusCode, calibration.body).toBe(200);
    expect(calibration.json()).toMatchObject({
      chunks: 20,
      charactersPerSecond: expect.any(Number),
      model: 'Qwen3-Embedding-0.6B',
    });
    expect(
      (
        await mutate('PUT', '/v1/admin/setup/progress', {
          step: 'storage',
          progress: 40,
        })
      ).statusCode,
    ).toBe(200);
    const setupEvents = await app.inject({ method: 'GET', url: '/v1/setup/events' });
    expect(setupEvents.statusCode).toBe(200);
    expect(setupEvents.headers['content-type']).toContain('text/event-stream');
    expect(setupEvents.body).toContain('event: step-completed');
    expect(setupEvents.body).not.toContain('principalId');
    const regressedProgress = await mutate('PUT', '/v1/admin/setup/progress', {
      step: 'storage',
      progress: 39,
    });
    expect(regressedProgress.statusCode).toBe(409);
    expect(regressedProgress.json()).toMatchObject({ code: 'setup_progress_regression' });
    const model = await mutate('POST', '/v1/admin/models', {
      name: 'm08-test-model',
      sourceRevision: 'm08-test-revision',
      artifactSha256: 'ef'.repeat(32),
      tokenizerRevision: 'm08-test-tokenizer',
      quantization: 'q8',
      dimensions: 1024,
      maximumTokens: 8192,
      pooling: 'last_token',
      normalization: 'l2',
      queryPrefix: 'Represent this sentence for searching relevant passages: ',
      documentPrefix: '',
      license: 'Apache-2.0',
    });
    expect(model.statusCode, model.body).toBe(201);
    const modelId = Number(model.json<{ id: number | string }>().id);
    const build = await mutate('POST', '/v1/admin/builds', {
      modelManifestId: modelId,
      reason: 'M08 administration contract exercise',
    });
    expect(build.statusCode, build.body).toBe(202);
    const buildId = Number(build.json<{ id: number | string }>().id);
    for (const action of ['pause', 'resume', 'cancel'] as const) {
      const changed = await mutate('PATCH', `/v1/admin/builds/${String(buildId)}`, { action });
      expect(changed.statusCode, `${action}: ${changed.body}`).toBe(200);
    }

    const storage = await mutate('POST', '/v1/admin/storage', {
      name: 'm08-test-backup',
      managedPath: '/var/lib/noderag/m08-test-backup',
      purpose: 'backup',
      enabled: true,
    });
    expect(storage.statusCode, storage.body).toBe(201);
    const storageId = storage.json<{ id: number }>().id;
    const backup = await mutate('POST', '/v1/admin/backups', { destinationId: storageId });
    expect(backup.statusCode, backup.body).toBe(202);
    const backupId = Number(backup.json<{ id: number | string }>().id);
    expect(
      (await mutate('POST', '/v1/admin/restores', { backupId, sourceManifest: {} })).statusCode,
    ).toBe(202);

    expect(
      (
        await mutate('POST', '/v1/admin/evaluation', {
          action: 'add_case',
          externalId: 'm08-api-case',
          siloId: firstSiloId,
          query: 'How many days notice?',
          relevant: [{ document: 'legal-register.md', pages: [0] }],
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await mutate('POST', '/v1/admin/evaluation', {
          action: 'queue_run',
          mode: 'hybrid',
        })
      ).statusCode,
    ).toBe(202);

    expect(
      (
        await mutate('DELETE', `/v1/admin/silos/${String(siloId)}`, {
          confirmSlug: 'm08-api-silo',
        })
      ).statusCode,
    ).toBe(202);
  }, 30_000);
});
