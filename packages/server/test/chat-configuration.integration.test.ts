import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerChatConfigurationRoutes } from '../src/api/chat-configuration-routes.js';
import type { RequestAuthenticator } from '../src/api/authentication.js';
import { runMigrations } from '../src/store/migrations.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;
let disabledApp: FastifyInstance;
let restartedApp: FastifyInstance;
let capacityApp: FastifyInstance;
let principalId: number;
let storageRoot: string;
let openAiProfileId: number;
let knownProfileId: number;
let tearingDown = false;

const authenticate: RequestAuthenticator = async (request) => {
  const role = request.headers['x-test-role'];
  if (role === undefined) return null;
  return {
    principalId,
    serverAdmin: role === 'admin' || role === 'search',
    searchOnly: role === 'search',
    sessionToken: role === 'admin' ? 'configuration-session' : null,
    csrfAllowed: (candidate) => candidate === 'configuration-csrf',
  };
};

const adminHeaders = (key?: string) => ({
  'x-test-role': 'admin',
  'x-csrf-token': 'configuration-csrf',
  origin: 'http://127.0.0.1:8787',
  ...(key === undefined ? {} : { 'idempotency-key': key }),
});

const contextPayload = {
  rollingTurnLimit: 16,
  inputReserveTokens: 2048,
  outputReserveTokens: 4096,
  pinnedInstructionReserveTokens: 2048,
  toolResultReserveTokens: 8192,
  managed: {
    enabled: true as const,
    triggerPercent: 72,
    keepRecentTurns: 6,
    l1PinLimitTokens: 4096,
    l2: {
      provider: 'openai_oauth' as const,
      model: 'gpt-test',
      reasoningEffort: 'low',
      instructions: 'Summarize only durable facts from the synthetic input.',
      outputTargetTokens: 1024,
    },
    l3: {
      provider: 'ollama_cloud' as const,
      model: 'minimax-m3:cloud',
      reasoningEffort: 'default',
      instructions: 'Return the synthetic state as JSON.',
      outputTargetTokens: 512,
      stateSchema: { type: 'object', additionalProperties: false },
    },
  },
};

const settingsPayload = () => ({
  defaultProvider: 'openai_oauth' as const,
  defaultModel: 'gpt-test',
  defaultReasoningEffort: 'low',
  defaultContextMode: 'managed' as const,
  defaultAllowResearch: false,
  defaultAllowRag: false,
  defaultAllowInternet: true,
  markdownOnly: true as const,
  runTimeoutMs: 180_000,
  maximumToolCalls: 10,
  maximumParallelRunsPerUser: 3,
  dailyRunQuota: 250,
  dailyInputTokenQuota: 2_000_000,
  dailyOutputTokenQuota: 500_000,
  retentionDays: 730,
  archiveAfterDays: 45,
  artifactMaxFileBytes: 12 * 1024 * 1024,
  artifactChatQuotaBytes: 512 * 1024 * 1024,
  markdownExternalImages: false,
  logSegmentMaxBytes: 4 * 1024 * 1024,
  logSegmentMaxAgeMinutes: 720,
  exportMaxOutputBytes: 64 * 1024 * 1024,
  exportTimeoutMs: 120_000,
  exportMaximumAttempts: 2,
  storagePath: storageRoot,
});

const buildApp = async (enabled: boolean, rebuildReserveBytes = 0n): Promise<FastifyInstance> => {
  const instance = Fastify({ logger: false });
  registerChatConfigurationRoutes(instance, {
    pool,
    authenticate,
    enabled,
    importEnabled: enabled,
    storageProbeOptions: () => ({ policy: 'testbed', rebuildReserveBytes }),
  });
  await instance.ready();
  return instance;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer(postgresImage)
    .withDatabase('noderag_chat_configuration')
    .withUsername('noderag')
    .withPassword('synthetic-chat-configuration-password')
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
  pool.on('error', (error) => {
    if (!tearingDown || (error as { code?: string }).code !== '57P01') throw error;
  });
  const principal = await pool.query<{ id: number }>(
    `INSERT INTO noderag.principal(kind,label) VALUES('user','Chat configuration administrator')
     RETURNING id`,
  );
  principalId = Number(principal.rows[0]?.id);
  await pool.query(
    `INSERT INTO noderag.app_user
       (principal_id,username,password_hash,server_admin,must_change)
     VALUES($1,'chat-config-admin','synthetic-password-hash',true,false)`,
    [principalId],
  );
  const providers = await pool.query<{ id: number; provider_kind: string }>(
    `UPDATE noderag.chat_provider_connection
     SET enabled=true,generation_model=CASE provider_kind
       WHEN 'openai_oauth' THEN 'gpt-test' ELSE 'minimax-m3:cloud' END
     RETURNING id,provider_kind`,
  );
  const openAiId = Number(
    providers.rows.find(({ provider_kind }) => provider_kind === 'openai_oauth')?.id,
  );
  const ollamaId = Number(
    providers.rows.find(({ provider_kind }) => provider_kind === 'ollama_cloud')?.id,
  );
  const insertedProfile = await pool.query<{ id: number; model: string }>(
    `INSERT INTO noderag.chat_model_profile
       (connection_id,model,display_name,reasoning_efforts,provider_metadata,
        context_provenance,administrator_context_tokens,administrator_output_tokens)
     VALUES
       ($1,'gpt-test','GPT Test',ARRAY['low','medium'],'{"catalogStale":false}',
        'unknown',128000,16000),
       ($1,'gpt-known','GPT Known Capacity',ARRAY['low'],'{"catalogStale":false}',
        'unknown',NULL,NULL),
       ($2,'minimax-m3:cloud','MiniMax M3 Cloud',ARRAY['default'],'{"catalogStale":false}',
        'unknown',200000,32000)
     RETURNING id,model`,
    [openAiId, ollamaId],
  );
  openAiProfileId = Number(insertedProfile.rows.find(({ model }) => model === 'gpt-test')?.id);
  knownProfileId = Number(insertedProfile.rows.find(({ model }) => model === 'gpt-known')?.id);
  await pool.query(
    `INSERT INTO noderag.chat_known_model_capacity
       (provider_kind,model_pattern,revision,context_tokens,maximum_output_tokens,source_note)
     VALUES('openai_oauth','gpt-known','known-capacity-test-v1',64000,8000,
       'Synthetic versioned capacity evidence for the integration test.')`,
  );
  await pool.query(`UPDATE noderag.chat_provider_capability SET status='healthy',tested_at=now()`);
  storageRoot = await mkdtemp(join(tmpdir(), 'noderag-chat-config-integration-'));
  app = await buildApp(true);
  disabledApp = await buildApp(false);
  capacityApp = await buildApp(true, 1_000_000_000_000_000_000n);
});

afterAll(async () => {
  await Promise.all([app.close(), disabledApp.close(), restartedApp?.close(), capacityApp.close()]);
  tearingDown = true;
  await pool.end();
  await container.stop();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('Chat configuration administration', () => {
  it('is feature-gated, server-admin-only, search-key hidden, and CSRF protected', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/v1/admin/chat/configuration' });
    const ordinary = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/configuration',
      headers: { 'x-test-role': 'user' },
    });
    const search = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/configuration',
      headers: { 'x-test-role': 'search' },
    });
    const disabled = await disabledApp.inject({
      method: 'GET',
      url: '/v1/admin/chat/configuration',
      headers: { 'x-test-role': 'admin' },
    });
    const csrf = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/context',
      headers: { 'x-test-role': 'admin', 'idempotency-key': 'context-csrf-001' },
      payload: contextPayload,
    });
    expect([
      anonymous.statusCode,
      ordinary.statusCode,
      search.statusCode,
      disabled.statusCode,
    ]).toEqual([401, 403, 404, 404]);
    expect(csrf.statusCode).toBe(403);
  });

  it('starts with conservative rolling defaults and Unknown capacity where no evidence exists', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/configuration',
      headers: { 'x-test-role': 'admin' },
    });
    expect(response).toMatchObject({ statusCode: 200 });
    expect(response.json()).toMatchObject({
      executionEnabled: false,
      internetProvider: 'ollama_cloud',
      context: { rollingTurnLimit: 12, managed: { enabled: false } },
      settings: {
        defaultProvider: null,
        defaultModel: null,
        defaultContextMode: 'rolling',
        defaults: { allowResearch: false, allowRag: false, allowInternet: false },
        markdownOnly: true,
      },
    });
    expect(
      response.json().models.find(({ id }: { id: number }) => id === knownProfileId),
    ).toMatchObject({
      knownModelRevision: 'known-capacity-test-v1',
      capacity: {
        contextTokens: 64000,
        contextSource: 'known_model_table',
        maximumOutputTokens: 8000,
        outputSource: 'known_model_table',
      },
    });
  });

  it('creates immutable context revisions and tests OpenAI and Ollama Cloud managed layers', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/configuration',
      headers: { 'x-test-role': 'admin' },
    });
    const previousContext = before.json().context.revisionId;
    const previousSettings = before.json().settings.revisionId;
    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/context',
      headers: adminHeaders('context-save-001'),
      payload: contextPayload,
    });
    const replay = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/context',
      headers: adminHeaders('context-save-001'),
      payload: contextPayload,
    });
    expect(saved).toMatchObject({ statusCode: 200 });
    expect(replay.json()).toEqual(saved.json());
    expect(saved.json().revisionId).not.toBe(previousContext);
    expect(saved.json().settingsRevisionId).not.toBe(previousSettings);

    const preview = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/context/preview',
      headers: adminHeaders('context-preview-001'),
      payload: { turnCount: 30, averageCharactersPerMessage: 900, pinnedCharacters: 500 },
    });
    expect(preview).toMatchObject({ statusCode: 200 });
    expect(preview.json()).toMatchObject({
      syntheticInput: true,
      projectedProviderCalls: 2,
      layerErrors: [],
      summary: { status: 'ready' },
      structuredState: { status: 'ready' },
    });
    await expect(
      pool.query(`UPDATE noderag.chat_context_settings_revision SET rolling_turn_limit=9`),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('saves model overrides, Ollama-Cloud-backed internet defaults, quotas, and contained storage', async () => {
    const override = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/chat/models/${String(openAiProfileId)}`,
      headers: adminHeaders('model-capacity-001'),
      payload: {
        administratorContextTokens: 196000,
        administratorOutputTokens: 24000,
        note: 'Capacity confirmed by the administrator for this deployment.',
      },
    });
    expect(override).toMatchObject({ statusCode: 200 });
    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/settings',
      headers: adminHeaders('settings-save-001'),
      payload: settingsPayload(),
    });
    expect(saved).toMatchObject({ statusCode: 200 });
    const current = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/configuration',
      headers: { 'x-test-role': 'admin' },
    });
    const body = current.json();
    expect(body.settings).toMatchObject({
      defaultProvider: 'openai_oauth',
      defaultModel: 'gpt-test',
      defaultContextMode: 'managed',
      defaults: { allowInternet: true },
      limits: { maximumParallelRunsPerUser: 3, dailyRunQuota: 250 },
      retention: { retentionDays: 730, archiveAfterDays: 45 },
      storage: { requestedPath: storageRoot },
    });
    expect(body.settings.storage.resolvedPath).toBe(
      join(await realpath(storageRoot), '.noderag-chat'),
    );
    expect(body.models.find(({ id }: { id: number }) => id === openAiProfileId)).toMatchObject({
      note: 'Capacity confirmed by the administrator for this deployment.',
      capacity: {
        contextTokens: 196000,
        contextSource: 'administrator_override',
        maximumOutputTokens: 24000,
      },
    });

    restartedApp = await buildApp(true);
    const afterRestart = await restartedApp.inject({
      method: 'GET',
      url: '/v1/admin/chat/configuration',
      headers: { 'x-test-role': 'admin' },
    });
    expect(afterRestart.json().settings.revisionId).toBe(body.settings.revisionId);
    expect(afterRestart.json().settings.storage.manifestId).toBe(body.settings.storage.manifestId);
    const health = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/health',
      headers: { 'x-test-role': 'admin' },
    });
    const hiddenHealth = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/health',
      headers: { 'x-test-role': 'search' },
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      contract: 'chat-health.v1',
      storage: { configured: true, state: 'healthy' },
      runs: { active: [], failedLast24Hours: 0 },
      archives: { failedSample: 0 },
    });
    expect(hiddenHealth.json()).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('fails closed for stale models, unhealthy Ollama Cloud internet, and invalid storage', async () => {
    const missingModel = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/context',
      headers: adminHeaders('context-missing-model-001'),
      payload: {
        ...contextPayload,
        managed: {
          ...contextPayload.managed,
          l2: { ...contextPayload.managed.l2, model: 'missing-model' },
        },
      },
    });
    expect(missingModel.json()).toMatchObject({ status: 422, code: 'chat_model_not_available' });

    await pool.query(
      `UPDATE noderag.chat_model_profile SET provider_metadata='{"catalogStale":true}'::jsonb
       WHERE id=$1`,
      [openAiProfileId],
    );
    const stale = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/settings',
      headers: adminHeaders('settings-stale-model-001'),
      payload: { ...settingsPayload(), storagePath: null },
    });
    expect(stale.json()).toMatchObject({ status: 422, code: 'chat_model_catalog_stale' });
    await pool.query(
      `UPDATE noderag.chat_model_profile SET provider_metadata='{"catalogStale":false}'::jsonb
       WHERE id=$1`,
      [openAiProfileId],
    );
    await pool.query(
      `UPDATE noderag.chat_provider_capability AS capability SET status='failed',tested_at=now()
       FROM noderag.chat_provider_connection AS connection
       WHERE connection.id=capability.connection_id AND connection.provider_kind='ollama_cloud'
         AND capability.capability='web_fetch'`,
    );
    const internet = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/settings',
      headers: adminHeaders('settings-internet-unhealthy-001'),
      payload: { ...settingsPayload(), storagePath: null },
    });
    expect(internet.json()).toMatchObject({ status: 422, code: 'ollama_cloud_internet_not_ready' });

    const missingReconcileKey = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/storage/reconcile/preview',
      headers: adminHeaders(),
      payload: { ownerMap: {} },
    });
    expect(missingReconcileKey.json()).toMatchObject({
      status: 400,
      code: 'idempotency_key_required',
    });
    const emptyInventory = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/storage/reconcile/preview',
      headers: adminHeaders('settings-reconcile-preview-001'),
      payload: { ownerMap: {} },
    });
    expect(emptyInventory.json()).toMatchObject({
      contract: 'chat-reconciliation-preview.v1',
      candidates: [],
      conflicts: [],
      canReconcile: false,
    });

    const occupied = join(storageRoot, 'occupied');
    await writeFile(occupied, 'not a folder', 'utf8');
    const invalidStorage = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/storage/probe',
      headers: adminHeaders('settings-invalid-storage-001'),
      payload: { storagePath: occupied },
    });
    expect(invalidStorage.json()).toMatchObject({
      status: 422,
      code: 'storage_path_not_directory',
    });

    const fullDisk = await capacityApp.inject({
      method: 'POST',
      url: '/v1/admin/chat/storage/probe',
      headers: adminHeaders('settings-full-storage-001'),
      payload: { storagePath: join(storageRoot, 'capacity-check') },
    });
    expect(fullDisk.json()).toMatchObject({
      status: 507,
      code: 'storage_capacity_insufficient',
    });

    await pool.query(
      `UPDATE noderag.chat_provider_capability AS capability SET status='failed',tested_at=now()
       FROM noderag.chat_provider_connection AS connection
       WHERE connection.id=capability.connection_id AND connection.provider_kind='openai_oauth'
         AND capability.capability='generation'`,
    );
    const failedLayer = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/context/preview',
      headers: adminHeaders('context-failed-layer-001'),
      payload: { turnCount: 12, averageCharactersPerMessage: 500, pinnedCharacters: 0 },
    });
    expect(failedLayer.json()).toMatchObject({
      syntheticInput: true,
      layerErrors: ['l2_not_ready'],
      summary: { status: 'unavailable' },
    });
  });
});
