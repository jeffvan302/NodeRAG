import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Embedder, EmbedderModel } from '@noderag/shared';
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
import { withTransaction } from '../src/store/database.js';
import {
  activateVerifiedBuild,
  authorizeBuildCleanup,
  changeBuildState,
  confirmRebuildProposal,
  createRebuildProposal,
  discardBuildCheckpoints,
  rollbackBuildActivation,
  runAuthorizedBuildCleanup,
  verifyStagedSilo,
} from '../src/store/rebuilds.js';
import { processOneEvaluationRun } from '../src/search/evaluation-runner.js';

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
  const embeddingRuntime = createDeterministicRuntime();
  let embeddingGate: ((model?: EmbedderModel) => Promise<void>) | undefined;
  const embedder: Embedder = {
    countTokens: (texts, priority, model) => embeddingRuntime.countTokens(texts, priority, model),
    embed: async (texts, maximumTokens, priority, model) => {
      await embeddingGate?.(model);
      return embeddingRuntime.embed(texts, maximumTokens, priority, model);
    },
  };

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
    const realPlanningCorpus = await readFile(
      join(process.cwd(), 'docs', 'planning', 'M5-DURABLE-INGESTION-PURGE.md'),
      'utf8',
    );
    firstDocumentId = await upload(
      firstSiloId,
      'legal-register.md',
      `${realPlanningCorpus}\n\n# Continuous-search control\n\nZX-991 termination notice is thirty days.\n\n| code | days |\n|---|---:|\n| ZX-991 | 30 |\n\n${'The legal cobalt register preserves contract notice evidence. '.repeat(60)}`,
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

  it('rebuilds under search load, resumes checkpoints, swaps models atomically, and rolls back', async () => {
    const activeModel = await pool.query<{
      id: number;
      name: string;
      artifact_sha256: string;
      tokenizer_revision: string;
      quantization: string;
      dimensions: number;
      manifest_digest: string;
      maximum_tokens: number;
      pooling: string;
      normalization: string;
      query_prefix: string;
      document_prefix: string;
      license: string;
    }>('SELECT * FROM noderag.model_manifest WHERE active');
    const originalModel = activeModel.rows[0];
    if (originalModel === undefined) throw new Error('active model missing');
    const propose = async (modelManifestId: number, siloIds: readonly number[], reason: string) =>
      withTransaction(pool, (database) =>
        createRebuildProposal(database, {
          modelManifestId,
          targetChars: 1200,
          overlapChars: 200,
          maxTokens: 1024,
          snapWindow: 0.15,
          headingPrefix: true,
          rulesVersion: 2,
          siloIds,
          reason,
          createdBy: administratorId,
          embeddingCharactersPerSecond: 10_000,
          availableBytes: 100n * 1024n ** 3n,
          freeSpaceReserveBytes: 10n * 1024n ** 3n,
        }),
      );
    const confirm = async (proposalId: number) =>
      withTransaction(pool, (database) =>
        confirmRebuildProposal(database, proposalId, administratorId),
      );
    const keywordSearch = (siloIds: readonly number[] = [firstSiloId]) =>
      app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { cookie },
        payload: { query: 'register', mode: 'keyword', silos: siloIds, limit: 10 },
      });
    const vectorSearch = (siloIds: readonly number[] = [firstSiloId]) =>
      app.inject({
        method: 'POST',
        url: '/v1/search',
        headers: { cookie },
        payload: { query: 'register', mode: 'vector', silos: siloIds, limit: 10 },
      });
    const expectValidEmbeddingReferences = async () => {
      const invalid = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM (
           SELECT cache.chunk_sha256,cache.model_manifest_id
           FROM noderag.embedding_cache cache
           LEFT JOIN noderag.build build ON build.model_manifest_id=cache.model_manifest_id
           LEFT JOIN noderag.chunk chunk
             ON chunk.build_id=build.id AND chunk.chunk_sha256=cache.chunk_sha256
           GROUP BY cache.chunk_sha256,cache.model_manifest_id,cache.refcount
           HAVING cache.refcount<>count(chunk.id)
         ) invalid`,
      );
      expect(Number(invalid.rows[0]?.count)).toBe(0);
    };

    const originalActive = await pool.query<{ build_id: number }>(
      `SELECT build_id FROM noderag.silo_build_state
       WHERE silo_id=$1 AND state='active'`,
      [firstSiloId],
    );
    const originalBuildId = originalActive.rows[0]?.build_id;
    if (originalBuildId === undefined) throw new Error('active build missing');

    const sameProposal = await propose(
      originalModel.id,
      [firstSiloId, secondSiloId],
      'same-model profile change',
    );
    const sameBuild = await confirm(Number(sameProposal['id']));
    expect(sameBuild.activationKind).toBe('same_model');
    expect((await keywordSearch()).statusCode).toBe(200);
    expect(await drainDocumentJobs({ pool, files, embedder, leaseOwner: 'm11-same-model' })).toBe(
      2,
    );
    await expectValidEmbeddingReferences();
    const sameVerification = await verifyStagedSilo(
      pool,
      sameBuild.buildId,
      firstSiloId,
      administratorId,
    );
    expect(sameVerification).toMatchObject({ state: 'passed', documentCount: 1 });
    const sameActivation = await activateVerifiedBuild(
      pool,
      sameBuild.buildId,
      [firstSiloId],
      administratorId,
    );
    await expectValidEmbeddingReferences();
    expect((await keywordSearch()).json<{ items: unknown[] }>().items.length).toBeGreaterThan(0);
    const partiallyActivated = await pool.query<{ state: string }>(
      'SELECT state FROM noderag.build WHERE id=$1',
      [sameBuild.buildId],
    );
    expect(partiallyActivated.rows[0]?.state).toBe('building');
    await expect(
      activateVerifiedBuild(pool, sameBuild.buildId, [firstSiloId], administratorId),
    ).rejects.toThrow('prior-activation-requires-resolution');
    await rollbackBuildActivation(pool, sameActivation, administratorId);
    await expectValidEmbeddingReferences();
    expect(
      (
        await pool.query<{ build_id: number }>(
          `SELECT build_id FROM noderag.silo_build_state
           WHERE silo_id=$1 AND state='active'`,
          [firstSiloId],
        )
      ).rows[0]?.build_id,
    ).toBe(originalBuildId);
    const partiallyRolledBack = await pool.query<{ state: string }>(
      'SELECT state FROM noderag.build WHERE id=$1',
      [sameBuild.buildId],
    );
    expect(partiallyRolledBack.rows[0]?.state).toBe('building');
    await verifyStagedSilo(pool, sameBuild.buildId, secondSiloId, administratorId);
    const secondSiloActivation = await activateVerifiedBuild(
      pool,
      sameBuild.buildId,
      [secondSiloId],
      administratorId,
    );
    expect((await keywordSearch([secondSiloId])).statusCode).toBe(200);
    const fullyActivated = await pool.query<{ state: string }>(
      'SELECT state FROM noderag.build WHERE id=$1',
      [sameBuild.buildId],
    );
    expect(fullyActivated.rows[0]?.state).toBe('active');
    await rollbackBuildActivation(pool, secondSiloActivation, administratorId);
    const fullyRolledBack = await pool.query<{ state: string }>(
      'SELECT state FROM noderag.build WHERE id=$1',
      [sameBuild.buildId],
    );
    expect(fullyRolledBack.rows[0]?.state).toBe('superseded');

    const cleanupProposal = await propose(
      originalModel.id,
      [firstSiloId],
      'authorized rollback retirement rehearsal',
    );
    const cleanupBuild = await confirm(Number(cleanupProposal['id']));
    expect(await drainDocumentJobs({ pool, files, embedder, leaseOwner: 'm11-cleanup' })).toBe(1);
    await verifyStagedSilo(pool, cleanupBuild.buildId, firstSiloId, administratorId);
    const cleanupActivation = await activateVerifiedBuild(
      pool,
      cleanupBuild.buildId,
      [firstSiloId],
      administratorId,
    );
    await expect(
      withTransaction(pool, (database) =>
        authorizeBuildCleanup(database, cleanupActivation, 'CLEANUP', administratorId),
      ),
    ).rejects.toThrow('cleanup-confirmation-mismatch');
    const cleanupId = await withTransaction(pool, (database) =>
      authorizeBuildCleanup(
        database,
        cleanupActivation,
        `CLEANUP BUILD ${String(cleanupBuild.buildId)}`,
        administratorId,
      ),
    );
    await runAuthorizedBuildCleanup(pool, cleanupId, administratorId);
    await expectValidEmbeddingReferences();
    const cleanupState = await pool.query<{ state: string }>(
      'SELECT state FROM noderag.build_cleanup WHERE id=$1',
      [cleanupId],
    );
    expect(cleanupState.rows[0]?.state).toBe('completed');
    const cleanupAudit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM noderag.audit_log
       WHERE action IN ('build.cleanup_authorize','build.cleanup')
         AND detail->>'cleanupId'=$1`,
      [String(cleanupId)],
    );
    expect(Number(cleanupAudit.rows[0]?.count)).toBe(2);

    const cancelledProposal = await propose(
      originalModel.id,
      [firstSiloId, secondSiloId],
      'pause, resume, and cancelled checkpoint retention rehearsal',
    );
    const cancelledBuild = await confirm(Number(cancelledProposal['id']));
    expect(
      await drainDocumentJobs(
        { pool, files, embedder, leaseOwner: 'm11-before-process-restart' },
        1,
      ),
    ).toBe(1);
    await withTransaction(pool, (database) =>
      changeBuildState(database, cancelledBuild.buildId, 'pause', administratorId),
    );
    expect(
      await drainDocumentJobs({ pool, files, embedder, leaseOwner: 'm11-paused-worker' }),
    ).toBe(0);
    await withTransaction(pool, (database) =>
      changeBuildState(database, cancelledBuild.buildId, 'resume', administratorId),
    );
    expect(
      await drainDocumentJobs({ pool, files, embedder, leaseOwner: 'm11-after-process-restart' }),
    ).toBe(1);
    await withTransaction(pool, (database) =>
      changeBuildState(database, cancelledBuild.buildId, 'cancel', administratorId),
    );
    const retained = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM noderag.build_document_checkpoint WHERE build_id=$1',
      [cancelledBuild.buildId],
    );
    expect(Number(retained.rows[0]?.count)).toBe(2);
    await expect(
      withTransaction(pool, (database) =>
        discardBuildCheckpoints(database, cancelledBuild.buildId, 'DISCARD', administratorId),
      ),
    ).rejects.toThrow('checkpoint-confirmation-mismatch');
    expect(
      await withTransaction(pool, (database) =>
        discardBuildCheckpoints(
          database,
          cancelledBuild.buildId,
          `DISCARD BUILD ${String(cancelledBuild.buildId)} CHECKPOINTS`,
          administratorId,
        ),
      ),
    ).toBe(2);

    const revision = 'm11-revision-model';
    const revisionArtifact = 'ab'.repeat(32);
    const revisionDigest = createHash('sha256')
      .update(
        [
          originalModel.name,
          revision,
          revisionArtifact,
          originalModel.tokenizer_revision,
          originalModel.quantization,
          originalModel.dimensions,
          originalModel.maximum_tokens,
          originalModel.pooling,
          originalModel.normalization,
          originalModel.query_prefix,
          originalModel.document_prefix,
          originalModel.license,
        ].join('\n'),
      )
      .digest('hex');
    const revisionModel = await pool.query<{ id: number }>(
      `INSERT INTO noderag.model_manifest
         (name,source_revision,artifact_sha256,tokenizer_revision,quantization,dimensions,
          maximum_tokens,pooling,normalization,query_prefix,document_prefix,license,
          manifest_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        originalModel.name,
        revision,
        revisionArtifact,
        originalModel.tokenizer_revision,
        originalModel.quantization,
        originalModel.dimensions,
        originalModel.maximum_tokens,
        originalModel.pooling,
        originalModel.normalization,
        originalModel.query_prefix,
        originalModel.document_prefix,
        originalModel.license,
        revisionDigest,
      ],
    );
    const revisionModelId = revisionModel.rows[0]?.id;
    if (revisionModelId === undefined) throw new Error('revision model missing');
    const partialRevisionProposal = await propose(
      revisionModelId,
      [firstSiloId],
      'invalid partial model revision',
    );
    await expect(confirm(Number(partialRevisionProposal['id']))).rejects.toThrow(
      'model-change-requires-all-silos',
    );
    const revisionProposal = await propose(
      revisionModelId,
      [firstSiloId, secondSiloId],
      'model revision atomic swap',
    );
    const revisionBuild = await confirm(Number(revisionProposal['id']));
    expect(revisionBuild.activationKind).toBe('model_revision');
    expect(await drainDocumentJobs({ pool, files, embedder, leaseOwner: 'm11-revision' })).toBe(2);
    const revisedVector = await pool.query<{ old_embedding: string; new_embedding: string }>(
      `SELECT old.embedding::text AS old_embedding,revised.embedding::text AS new_embedding
       FROM noderag.embedding_cache old
       JOIN noderag.embedding_cache revised ON revised.chunk_sha256=old.chunk_sha256
       WHERE old.model_manifest_id=$1 AND revised.model_manifest_id=$2 LIMIT 1`,
      [originalModel.id, revisionModelId],
    );
    expect(revisedVector.rows[0]?.new_embedding).not.toBe(revisedVector.rows[0]?.old_embedding);
    await verifyStagedSilo(pool, revisionBuild.buildId, firstSiloId, administratorId);
    await verifyStagedSilo(pool, revisionBuild.buildId, secondSiloId, administratorId);
    let enterEmbedding!: () => void;
    let releaseEmbedding!: () => void;
    const embeddingEntered = new Promise<void>((resolve) => {
      enterEmbedding = resolve;
    });
    const embeddingReleased = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    let gated = false;
    embeddingGate = async (modelSelection) => {
      if (gated || modelSelection?.manifestDigest !== originalModel.manifest_digest) return;
      gated = true;
      enterEmbedding();
      await embeddingReleased;
    };
    const inFlightSearch = vectorSearch([firstSiloId, secondSiloId]);
    await embeddingEntered;
    let activationSettled = false;
    const activation = activateVerifiedBuild(
      pool,
      revisionBuild.buildId,
      [firstSiloId, secondSiloId],
      administratorId,
    ).finally(() => {
      activationSettled = true;
    });
    let cutoverWaiting = false;
    for (let attempt = 0; attempt < 100 && !cutoverWaiting; attempt += 1) {
      const waiting = await pool.query<{ waiting: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_locks
                       WHERE locktype='advisory' AND NOT granted) AS waiting`,
      );
      cutoverWaiting = waiting.rows[0]?.waiting ?? false;
      if (!cutoverWaiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const settledBeforeRelease = activationSettled;
    releaseEmbedding();
    const [searchResult, revisionActivation] = await Promise.all([inFlightSearch, activation]);
    embeddingGate = undefined;
    expect(cutoverWaiting).toBe(true);
    expect(settledBeforeRelease).toBe(false);
    expect(searchResult.statusCode, searchResult.body).toBe(200);
    const activeModels = await pool.query<{ count: string }>(
      `SELECT count(DISTINCT build.model_manifest_id)::text AS count
       FROM noderag.silo_build_state state JOIN noderag.build build ON build.id=state.build_id
       WHERE state.state='active'`,
    );
    expect(Number(activeModels.rows[0]?.count)).toBe(1);
    await expectValidEmbeddingReferences();
    expect(
      (await vectorSearch([firstSiloId, secondSiloId])).json<{ items: unknown[] }>().items.length,
    ).toBeGreaterThan(0);
    await rollbackBuildActivation(pool, revisionActivation as number, administratorId);
    await expectValidEmbeddingReferences();
    expect((await vectorSearch([firstSiloId, secondSiloId])).statusCode).toBe(200);
  });

  it('atomically swaps a differently typed vector parent and restores the old parent', async () => {
    const current = await pool.query<{
      id: number;
      name: string;
      tokenizer_revision: string;
      quantization: string;
      maximum_tokens: number;
      pooling: string;
      normalization: string;
      query_prefix: string;
      document_prefix: string;
      license: string;
    }>('SELECT * FROM noderag.model_manifest WHERE active');
    const model = current.rows[0];
    if (model === undefined) throw new Error('active model missing');
    const sourceRevision = 'm11-three-dimension';
    const artifactSha256 = 'cd'.repeat(32);
    const dimensions = 3;
    const manifestDigest = createHash('sha256')
      .update(
        [
          model.name,
          sourceRevision,
          artifactSha256,
          model.tokenizer_revision,
          model.quantization,
          dimensions,
          model.maximum_tokens,
          model.pooling,
          model.normalization,
          model.query_prefix,
          model.document_prefix,
          model.license,
        ].join('\n'),
      )
      .digest('hex');
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO noderag.model_manifest
         (name,source_revision,artifact_sha256,tokenizer_revision,quantization,dimensions,
          maximum_tokens,pooling,normalization,query_prefix,document_prefix,license,
          manifest_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        model.name,
        sourceRevision,
        artifactSha256,
        model.tokenizer_revision,
        model.quantization,
        dimensions,
        model.maximum_tokens,
        model.pooling,
        model.normalization,
        model.query_prefix,
        model.document_prefix,
        model.license,
        manifestDigest,
      ],
    );
    const modelId = inserted.rows[0]?.id;
    if (modelId === undefined) throw new Error('dimension model missing');
    const proposal = await withTransaction(pool, (database) =>
      createRebuildProposal(database, {
        modelManifestId: modelId,
        targetChars: 1200,
        overlapChars: 200,
        maxTokens: 1024,
        snapWindow: 0.15,
        headingPrefix: true,
        rulesVersion: 3,
        siloIds: [firstSiloId, secondSiloId],
        reason: 'dimension parent swap',
        createdBy: administratorId,
        embeddingCharactersPerSecond: 10_000,
        availableBytes: 100n * 1024n ** 3n,
        freeSpaceReserveBytes: 10n * 1024n ** 3n,
      }),
    );
    const build = await withTransaction(pool, (database) =>
      confirmRebuildProposal(database, Number(proposal['id']), administratorId),
    );
    expect(build.activationKind).toBe('dimension_change');
    await pool.query(
      "UPDATE noderag.job SET state='cancelled',finished_at=now() WHERE build_id=$1",
      [build.buildId],
    );
    const staging = await pool.query<{ silo_id: number; staging_table: string }>(
      `SELECT silo_id,staging_table FROM noderag.silo_build_state
       WHERE build_id=$1 ORDER BY silo_id`,
      [build.buildId],
    );
    for (const row of staging.rows) {
      expect(row.staging_table).toMatch(/^chunk_stage_b\d+_s\d+$/u);
      await pool.query(
        `INSERT INTO noderag.${row.staging_table}
           (silo_id,document_id,build_id,ordinal,text,page_start,page_end,
            character_start,character_end,byte_start,byte_end,embedding,token_count,
            heading_path,chunk_sha256,part_of,structure_kind,structure_kinds,continuation)
         SELECT chunk.silo_id,chunk.document_id,$1,chunk.ordinal,chunk.text,
                chunk.page_start,chunk.page_end,chunk.character_start,chunk.character_end,
                chunk.byte_start,chunk.byte_end,'[1,0,0]'::halfvec,chunk.token_count,
                chunk.heading_path,chunk.chunk_sha256,chunk.part_of,chunk.structure_kind,
                chunk.structure_kinds,chunk.continuation
         FROM noderag.chunk chunk
         JOIN noderag.silo_build_state active
           ON active.silo_id=chunk.silo_id AND active.build_id=chunk.build_id
          AND active.state='active'
         WHERE chunk.silo_id=$2`,
        [build.buildId, row.silo_id],
      );
      await pool.query(
        `INSERT INTO noderag.embedding_cache
           (chunk_sha256,model_manifest_id,dimensions,embedding,refcount)
         SELECT DISTINCT chunk_sha256,$1::smallint,$2::integer,'[1,0,0]'::halfvec,0
         FROM noderag.${row.staging_table}
         ON CONFLICT(chunk_sha256,model_manifest_id) DO NOTHING`,
        [modelId, dimensions],
      );
      await pool.query(
        `INSERT INTO noderag.build_document_checkpoint
           (build_id,silo_id,document_id,markdown_sha256,embedded_text_digest,
            model_manifest_digest,chunk_count,state)
         SELECT $1,document.silo_id,document.id,document.markdown_sha256,
                decode(repeat('00',32),'hex'),$3,count(stage.id)::integer,'complete'
         FROM noderag.document document
         JOIN noderag.${row.staging_table} stage
           ON stage.silo_id=document.silo_id AND stage.document_id=document.id
         WHERE document.silo_id=$2
         GROUP BY document.silo_id,document.id,document.markdown_sha256`,
        [build.buildId, row.silo_id, manifestDigest],
      );
      const verification = await verifyStagedSilo(
        pool,
        build.buildId,
        row.silo_id,
        administratorId,
      );
      expect(verification).toMatchObject({ state: 'passed', dimensionMismatches: 0 });
    }
    const activationId = await activateVerifiedBuild(
      pool,
      build.buildId,
      [firstSiloId, secondSiloId],
      administratorId,
    );
    const activeType = await pool.query<{ formatted: string }>(
      `SELECT format_type(atttypid,atttypmod) AS formatted
       FROM pg_attribute WHERE attrelid='noderag.chunk'::regclass AND attname='embedding'`,
    );
    expect(activeType.rows[0]?.formatted).toBe('halfvec(3)');
    const activeDimensionPartitions = await pool.query<{
      silo_id: number;
      table_name: string | null;
    }>(
      `SELECT silo.id AS silo_id,
              to_regclass('noderag.chunk_s' || silo.id::text)::text AS table_name
       FROM noderag.silo silo WHERE silo.id=ANY($1::smallint[]) ORDER BY silo.id`,
      [[firstSiloId, secondSiloId]],
    );
    expect(activeDimensionPartitions.rows).toEqual([
      { silo_id: firstSiloId, table_name: `chunk_s${String(firstSiloId)}` },
      { silo_id: secondSiloId, table_name: `chunk_s${String(secondSiloId)}` },
    ]);
    const invalidActiveReferences = await pool.query(
      `SELECT 1 FROM noderag.embedding_cache cache
       LEFT JOIN noderag.build build ON build.model_manifest_id=cache.model_manifest_id
       LEFT JOIN noderag.chunk chunk
         ON chunk.build_id=build.id AND chunk.chunk_sha256=cache.chunk_sha256
       GROUP BY cache.chunk_sha256,cache.model_manifest_id,cache.refcount
       HAVING cache.refcount<>count(chunk.id) LIMIT 1`,
    );
    expect(invalidActiveReferences.rowCount).toBe(0);
    const search = await app.inject({
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
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json<{ items: unknown[] }>().items.length).toBeGreaterThanOrEqual(2);
    const vectorSearch = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie },
      payload: {
        query: 'register',
        mode: 'vector',
        silos: [firstSiloId, secondSiloId],
        limit: 10,
      },
    });
    expect(vectorSearch.statusCode, vectorSearch.body).toBe(200);
    expect(vectorSearch.json<{ items: unknown[] }>().items.length).toBeGreaterThanOrEqual(2);
    await rollbackBuildActivation(pool, activationId, administratorId);
    const restoredType = await pool.query<{ formatted: string }>(
      `SELECT format_type(atttypid,atttypmod) AS formatted
       FROM pg_attribute WHERE attrelid='noderag.chunk'::regclass AND attname='embedding'`,
    );
    expect(restoredType.rows[0]?.formatted).toBe('halfvec(1024)');
    const restoredPartitions = await pool.query<{ silo_id: number; table_name: string | null }>(
      `SELECT silo.id AS silo_id,
              to_regclass('noderag.chunk_s' || silo.id::text)::text AS table_name
       FROM noderag.silo silo WHERE silo.id=ANY($1::smallint[]) ORDER BY silo.id`,
      [[firstSiloId, secondSiloId]],
    );
    expect(restoredPartitions.rows).toEqual(activeDimensionPartitions.rows);
    const restoredVectorSearch = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie },
      payload: {
        query: 'register',
        mode: 'vector',
        silos: [firstSiloId, secondSiloId],
        limit: 10,
      },
    });
    expect(restoredVectorSearch.statusCode, restoredVectorSearch.body).toBe(200);
    const rolledBackCleanupId = await withTransaction(pool, (database) =>
      authorizeBuildCleanup(
        database,
        activationId,
        `CLEANUP BUILD ${String(build.buildId)}`,
        administratorId,
      ),
    );
    await runAuthorizedBuildCleanup(pool, rolledBackCleanupId, administratorId);
    const removedFailedParent = await pool.query<{ table_name: string | null }>(
      `SELECT to_regclass($1)::text AS table_name`,
      [`noderag.chunk_parent_failed_b${String(build.buildId)}`],
    );
    expect(removedFailedParent.rows[0]?.table_name).toBeNull();
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
    const proposal = await mutate('POST', '/v1/admin/builds', {
      modelManifestId: modelId,
      reason: 'M08 administration contract exercise',
    });
    expect(proposal.statusCode, proposal.body).toBe(202);
    expect(proposal.json()).toMatchObject({ kind: 'rebuild_proposal', fits: true });
    const proposalId = Number(proposal.json<{ id: number | string }>().id);
    const build = await mutate('POST', `/v1/admin/build-proposals/${String(proposalId)}/confirm`, {
      confirm: true,
    });
    expect(build.statusCode, build.body).toBe(202);
    const buildId = Number(build.json<{ buildId: number | string }>().buildId);
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

    const evaluationCase = await mutate('POST', '/v1/admin/evaluation', {
      action: 'add_case',
      externalId: 'm08-api-case',
      siloId: firstSiloId,
      query: 'How many days notice?',
      queryClass: 'semantic',
      expectedFormat: 'md',
      relevant: [{ document: 'legal-register.md' }],
    });
    expect(evaluationCase.statusCode, evaluationCase.body).toBe(201);
    const evaluation = await mutate('POST', '/v1/admin/evaluation', {
      action: 'set_case_state',
      caseId: Number(evaluationCase.json<{ id: number | string }>().id),
      state: 'approved',
    });
    expect(evaluation.statusCode, evaluation.body).toBe(200);
    const evaluationRuns = await mutate('POST', '/v1/admin/evaluation', {
      action: 'queue_run',
      modes: ['vector', 'keyword', 'hybrid'],
      workload: 'idle',
      environment: { suite: 'retrieval-integration' },
    });
    expect(evaluationRuns.statusCode, evaluationRuns.body).toBe(202);
    expect(evaluationRuns.json<{ runs: unknown[] }>().runs).toHaveLength(3);
    for (let index = 0; index < 3; index += 1) {
      expect(
        await processOneEvaluationRun({
          pool,
          embedder,
          files,
          leaseOwner: `m12-evaluation-${String(index)}`,
        }),
      ).toBe(true);
    }
    expect(
      await processOneEvaluationRun({
        pool,
        embedder,
        files,
        leaseOwner: 'm12-evaluation-empty',
      }),
    ).toBe(false);
    const evaluationState = await app.inject({
      method: 'GET',
      url: '/v1/admin/evaluation',
      headers: { cookie },
    });
    expect(evaluationState.statusCode, evaluationState.body).toBe(200);
    const completedRuns = evaluationState.json<{ runs: { id: number; state: string }[] }>().runs;
    expect(completedRuns.slice(0, 3).map(({ state }) => state)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    const baseline = await mutate('POST', '/v1/admin/evaluation', {
      action: 'accept_baseline',
      runId: Number(completedRuns[0]?.id),
    });
    expect(baseline.statusCode, baseline.body).toBe(201);

    expect(
      (
        await mutate('DELETE', `/v1/admin/silos/${String(siloId)}`, {
          confirmSlug: 'm08-api-silo',
        })
      ).statusCode,
    ).toBe(202);
  }, 30_000);
});
