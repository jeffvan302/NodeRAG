import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerChatProviderRoutes } from '../src/api/chat-provider-routes.js';
import {
  registerChatOpenAiRoutes,
  type OpenAiOAuthRouteManager,
} from '../src/api/chat-openai-routes.js';
import type { RequestAuthenticator } from '../src/api/authentication.js';
import { OLLAMA_CLOUD_ENDPOINTS, OllamaCloudAdminClient } from '../src/chat/ollama-cloud.js';
import { SecretVault } from '../src/identity/secrets.js';
import { runMigrations } from '../src/store/migrations.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;
let disabledApp: FastifyInstance;
let principalId: number;
let vault: SecretVault;
const observedKeys: string[] = [];
const openAiCalls: string[] = [];

const fakeOpenAiManager: OpenAiOAuthRouteManager = {
  async status() {
    openAiCalls.push('status');
    return {
      account: {
        connected: false,
        requiresOpenaiAuth: true,
        email: null,
        planType: null,
      },
      login: null,
      rateLimits: null,
      runtimeState: 'ready',
    };
  },
  async startLogin() {
    openAiCalls.push('login');
    return {
      loginId: 'integration-login',
      userCode: 'SAFE-CODE',
      verificationUrl: 'https://auth.openai.com/device',
      expiresAt: '2026-09-15T12:15:00.000Z',
      state: 'pending',
      safeErrorCode: null,
    };
  },
  async cancelLogin() {
    openAiCalls.push('cancel');
    return null;
  },
  async refreshModels() {
    openAiCalls.push('models');
    return [
      {
        model: 'gpt-test',
        displayName: 'GPT Test',
        description: 'Synthetic integration model',
        reasoningEfforts: ['low', 'ultra', 'future_effort'],
        defaultReasoningEffort: 'low',
        inputModalities: ['text', 'image'],
        isDefault: true,
        supportsPersonality: false,
        effectiveContextTokens: 272_000,
        maximumContextTokens: 1_000_000,
        maximumOutputTokens: null,
      },
    ];
  },
  async testConnection() {
    openAiCalls.push('test');
    return {
      account: {
        connected: true,
        requiresOpenaiAuth: false,
        email: 'shared@example.test',
        planType: 'team',
      },
      modelCount: 1,
      rateLimits: null,
    };
  },
  async disconnect() {
    openAiCalls.push('disconnect');
  },
};

const authenticate: RequestAuthenticator = async (request) => {
  const role = request.headers['x-test-role'];
  if (role === undefined) return null;
  return {
    principalId,
    serverAdmin: role === 'admin' || role === 'search',
    searchOnly: role === 'search',
    sessionToken: role === 'admin' ? 'test-session' : null,
    csrfAllowed: (candidate) => candidate === 'csrf-test-token',
  };
};

const fakeClient = (apiKey: string): OllamaCloudAdminClient => {
  observedKeys.push(apiKey);
  return new OllamaCloudAdminClient({
    apiKey,
    fetch: vi.fn<typeof fetch>(async (input) => {
      if (apiKey === 'rejected-key') return new Response(null, { status: 401 });
      const url = String(input);
      if (url === OLLAMA_CLOUD_ENDPOINTS.chat) {
        return Response.json({
          model: 'minimax-m3:cloud',
          message: { content: 'NodeRag connection ready.' },
          done: true,
        });
      }
      if (url === OLLAMA_CLOUD_ENDPOINTS.webSearch) {
        return Response.json({
          results: [{ title: 'Ollama', url: 'https://ollama.com/', content: 'Cloud models' }],
        });
      }
      if (url === OLLAMA_CLOUD_ENDPOINTS.webFetch) {
        return Response.json({ title: 'Ollama', content: 'Cloud documentation', links: [] });
      }
      if (url === OLLAMA_CLOUD_ENDPOINTS.models) {
        return Response.json({ models: [{ name: 'minimax-m3:cloud' }] });
      }
      if (url === OLLAMA_CLOUD_ENDPOINTS.runningModels) {
        return Response.json({
          models: [{ name: 'minimax-m3:cloud', context_length: 500_000 }],
        });
      }
      if (url === OLLAMA_CLOUD_ENDPOINTS.show) {
        return Response.json({
          capabilities: ['completion', 'thinking'],
          details: { family: 'minimax-m3' },
          parameters: 'num_ctx 500000\nnum_predict 32768',
          model_info: { 'minimax-m3.context_length': 1_000_000 },
        });
      }
      throw new Error('unexpected-test-url');
    }),
  });
};

const adminHeaders = (idempotency?: string) => ({
  'x-test-role': 'admin',
  'x-csrf-token': 'csrf-test-token',
  origin: 'http://127.0.0.1:8787',
  ...(idempotency === undefined ? {} : { 'idempotency-key': idempotency }),
});

beforeAll(async () => {
  container = await new PostgreSqlContainer(postgresImage)
    .withDatabase('noderag_chat_provider')
    .withUsername('noderag')
    .withPassword('synthetic-chat-provider-password')
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
  const principal = await pool.query<{ id: number }>(
    `INSERT INTO noderag.principal(kind,label) VALUES('user','Chat provider administrator')
     RETURNING id`,
  );
  principalId = Number(principal.rows[0]?.id);
  await pool.query(
    `INSERT INTO noderag.app_user
       (principal_id,username,password_hash,server_admin,must_change)
     VALUES($1,'chat-admin','synthetic-password-hash',true,false)`,
    [principalId],
  );
  vault = new SecretVault(Buffer.alloc(32, 7));
  app = Fastify({ logger: false });
  registerChatProviderRoutes(app, {
    pool,
    authenticate,
    secretVault: vault,
    enabled: true,
    createOllamaClient: fakeClient,
  });
  registerChatOpenAiRoutes(app, {
    pool,
    authenticate,
    enabled: true,
    manager: fakeOpenAiManager,
  });
  await app.ready();
  disabledApp = Fastify({ logger: false });
  registerChatProviderRoutes(disabledApp, {
    pool,
    authenticate,
    secretVault: vault,
    enabled: false,
    createOllamaClient: fakeClient,
  });
  registerChatOpenAiRoutes(disabledApp, {
    pool,
    authenticate,
    enabled: false,
    manager: fakeOpenAiManager,
  });
  await disabledApp.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await disabledApp?.close();
  await pool?.end();
  await container?.stop();
});

describe('Chat provider administration', () => {
  it('keeps disabled provider routes hidden and enforces administrator access', async () => {
    const disabled = await disabledApp.inject({
      method: 'GET',
      url: '/v1/admin/chat/providers',
      headers: { 'x-test-role': 'admin' },
    });
    expect(disabled).toMatchObject({ statusCode: 404 });

    const anonymous = await app.inject({ method: 'GET', url: '/v1/admin/chat/providers' });
    expect(anonymous).toMatchObject({ statusCode: 401 });
    const ordinary = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/providers',
      headers: { 'x-test-role': 'user' },
    });
    expect(ordinary).toMatchObject({ statusCode: 403 });
    const searchOnly = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/providers',
      headers: { 'x-test-role': 'search' },
    });
    expect(searchOnly).toMatchObject({ statusCode: 404 });
  });

  it('starts with a fixed disabled Ollama Cloud connection and independent capabilities', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/providers',
      headers: { 'x-test-role': 'admin' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const ollama = body.providers.find(
      (provider: { provider: string }) => provider.provider === 'ollama_cloud',
    );
    expect(ollama).toMatchObject({
      label: 'Ollama Cloud',
      serviceRoot: 'https://ollama.com',
      serviceRootEditable: false,
      enabled: false,
      credential: { configured: false, fingerprint: null },
      generationModel: null,
      webToolUsage: {
        requestsThisMinute: 0,
        requestsLast24Hours: 0,
        activeMinutesLast24Hours: 0,
        lastRequestAt: null,
      },
    });
    expect(
      ollama.capabilities.map(({ capability }: { capability: string }) => capability).sort(),
    ).toEqual(['generation', 'model_catalog', 'web_fetch', 'web_search']);

    const customAddress = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/ollama-cloud',
      headers: adminHeaders('custom-address-cloud-001'),
      payload: { serviceRoot: 'http://127.0.0.1:11434' },
    });
    expect(customAddress).toMatchObject({ statusCode: 400 });
    expect(customAddress.json()).toMatchObject({ code: 'invalid_request' });
  });

  it('reports safe hosted web usage counters without prompts or page content', async () => {
    await pool.query(
      `INSERT INTO noderag.chat_web_usage_minute(connection_id,minute_start,request_count)
       SELECT id,date_trunc('minute',now()),3
       FROM noderag.chat_provider_connection WHERE provider_kind='ollama_cloud'`,
    );
    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/providers',
      headers: { 'x-test-role': 'admin' },
    });
    const ollama = response
      .json()
      .providers.find((provider: { provider: string }) => provider.provider === 'ollama_cloud');
    expect(ollama.webToolUsage).toMatchObject({
      requestsThisMinute: 3,
      requestsLast24Hours: 3,
      activeMinutesLast24Hours: 1,
      lastRequestAt: expect.any(String),
    });
    expect(JSON.stringify(ollama.webToolUsage)).not.toContain('query');
    expect(JSON.stringify(ollama.webToolUsage)).not.toContain('content');
  });

  it('encrypts a key, persists settings, and retains the key when a blank field is submitted', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/ollama-cloud',
      headers: adminHeaders('save-cloud-001'),
      payload: {
        enabled: true,
        apiKey: 'stored-cloud-key',
        generationModel: 'minimax-m3:cloud',
        maxParallelCalls: 4,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('stored-cloud-key');
    const first = saved
      .json()
      .providers.find((provider: { provider: string }) => provider.provider === 'ollama_cloud');
    expect(first).toMatchObject({
      enabled: true,
      credential: { configured: true },
      generationModel: 'minimax-m3:cloud',
      limits: { maxParallelCalls: 4 },
    });
    expect(first.credential.fingerprint).toMatch(/^[a-f0-9]{16}$/u);

    const retained = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/ollama-cloud',
      headers: adminHeaders('save-cloud-002'),
      payload: { apiKey: '', maxParallelCalls: 3 },
    });
    expect(retained.statusCode).toBe(200);
    const second = retained
      .json()
      .providers.find((provider: { provider: string }) => provider.provider === 'ollama_cloud');
    expect(second.credential.fingerprint).toBe(first.credential.fingerprint);
    expect(second.limits.maxParallelCalls).toBe(3);

    const stored = await pool.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM noderag.encrypted_secret
       WHERE provider='ollama_cloud' AND name='api-key'`,
    );
    expect(stored.rows[0]?.ciphertext.toString('utf8')).not.toContain('stored-cloud-key');

    const replaced = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/ollama-cloud',
      headers: adminHeaders('save-cloud-003'),
      payload: { apiKey: 'replacement-cloud-key' },
    });
    expect(replaced).toMatchObject({ statusCode: 200 });
    const third = replaced
      .json()
      .providers.find((provider: { provider: string }) => provider.provider === 'ollama_cloud');
    expect(third.credential.fingerprint).not.toBe(first.credential.fingerprint);
    expect(replaced.body).not.toContain('replacement-cloud-key');
  });

  it('tests generation, search, and fetch independently with the stored key', async () => {
    const endpoints = [
      ['test-generation', 'test-cloud-generation-001', { model: 'minimax-m3:cloud' }],
      ['test-web-search', 'test-cloud-search-001', {}],
      ['test-web-fetch', 'test-cloud-fetch-001', {}],
    ] as const;
    for (const [endpoint, key, payload] of endpoints) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/admin/chat/providers/ollama-cloud/${endpoint}`,
        headers: adminHeaders(key),
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true });
    }
    expect(observedKeys.slice(-3)).toEqual([
      'replacement-cloud-key',
      'replacement-cloud-key',
      'replacement-cloud-key',
    ]);

    const status = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/providers',
      headers: { 'x-test-role': 'admin' },
    });
    const ollama = status
      .json()
      .providers.find((provider: { provider: string }) => provider.provider === 'ollama_cloud');
    const health = Object.fromEntries(
      ollama.capabilities.map((item: { capability: string; status: string }) => [
        item.capability,
        item.status,
      ]),
    );
    expect(health).toMatchObject({
      generation: 'healthy',
      web_search: 'healthy',
      web_fetch: 'healthy',
    });
    expect(health.model_catalog).toBe('untested');
  });

  it('refreshes and persists the authenticated Ollama Cloud model catalog across an API restart', async () => {
    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/providers/ollama-cloud/refresh-models',
      headers: adminHeaders('refresh-cloud-models-001'),
      payload: {},
    });
    expect(refreshed).toMatchObject({ statusCode: 200 });
    expect(refreshed.json()).toMatchObject({ ok: true, modelCount: 1 });
    const ollama = refreshed
      .json()
      .providers.find((provider: { provider: string }) => provider.provider === 'ollama_cloud');
    expect(ollama.models).toMatchObject([
      {
        model: 'minimax-m3:cloud',
        reasoningEfforts: ['default', 'none', 'low', 'medium', 'high', 'max'],
        advertisedContextTokens: 1_000_000,
        configuredContextTokens: 500_000,
        runtimeContextTokens: 500_000,
        maximumOutputTokens: 32_768,
        contextProvenance: 'provider_metadata',
      },
    ]);
    expect(
      ollama.capabilities.find(
        ({ capability }: { capability: string }) => capability === 'model_catalog',
      ),
    ).toMatchObject({ status: 'healthy', metadata: { modelCount: 1 } });

    await pool.query(
      `UPDATE noderag.chat_model_profile
       SET administrator_context_tokens=200000,administrator_output_tokens=32000,
           administrator_note='Verified Cloud capacity'
       WHERE connection_id=(
         SELECT id FROM noderag.chat_provider_connection WHERE provider_kind='ollama_cloud'
       ) AND model='minimax-m3:cloud'`,
    );
    const refreshedAgain = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/providers/ollama-cloud/refresh-models',
      headers: adminHeaders('refresh-cloud-models-002'),
      payload: {},
    });
    expect(refreshedAgain.statusCode).toBe(200);
    const retainedOverride = await pool.query<{
      administrator_context_tokens: number;
      administrator_output_tokens: number;
      administrator_note: string;
      catalog_stale: boolean;
    }>(
      `SELECT administrator_context_tokens,administrator_output_tokens,administrator_note,
              (provider_metadata->>'catalogStale')::boolean AS catalog_stale
       FROM noderag.chat_model_profile
       WHERE connection_id=(
         SELECT id FROM noderag.chat_provider_connection WHERE provider_kind='ollama_cloud'
       ) AND model='minimax-m3:cloud'`,
    );
    expect(retainedOverride.rows[0]).toEqual({
      administrator_context_tokens: 200000,
      administrator_output_tokens: 32000,
      administrator_note: 'Verified Cloud capacity',
      catalog_stale: false,
    });

    const restarted = Fastify({ logger: false });
    registerChatProviderRoutes(restarted, {
      pool,
      authenticate,
      secretVault: vault,
      enabled: true,
      createOllamaClient: fakeClient,
    });
    await restarted.ready();
    try {
      const afterRestart = await restarted.inject({
        method: 'GET',
        url: '/v1/admin/chat/providers',
        headers: { 'x-test-role': 'admin' },
      });
      const persisted = afterRestart
        .json()
        .providers.find((provider: { provider: string }) => provider.provider === 'ollama_cloud');
      expect(persisted).toMatchObject({
        enabled: true,
        generationModel: 'minimax-m3:cloud',
        credential: { configured: true },
        models: [{ model: 'minimax-m3:cloud' }],
      });
    } finally {
      await restarted.close();
    }
  });

  it('records a rejected candidate test without replacing the saved key', async () => {
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/providers/ollama-cloud/test-web-search',
      headers: adminHeaders('test-cloud-search-002'),
      payload: { apiKey: 'rejected-key' },
    });
    expect(rejected).toMatchObject({ statusCode: 422 });
    expect(rejected.json()).toMatchObject({ code: 'ollama_cloud_credentials_rejected' });

    const mixedStatus = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/providers',
      headers: { 'x-test-role': 'admin' },
    });
    const mixedCapabilities = Object.fromEntries(
      mixedStatus
        .json()
        .providers.find((provider: { provider: string }) => provider.provider === 'ollama_cloud')
        .capabilities.map((item: { capability: string; status: string }) => [
          item.capability,
          item.status,
        ]),
    );
    expect(mixedCapabilities).toMatchObject({
      generation: 'healthy',
      model_catalog: 'healthy',
      web_search: 'failed',
      web_fetch: 'healthy',
    });

    const restored = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/providers/ollama-cloud/test-web-search',
      headers: adminHeaders('test-cloud-search-003'),
      payload: { apiKey: '' },
    });
    expect(restored).toMatchObject({ statusCode: 200 });
    expect(observedKeys.at(-1)).toBe('replacement-cloud-key');
  });

  it('explicitly disables Cloud activity while retaining the protected key', async () => {
    const disabled = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/providers/ollama-cloud/disable',
      headers: adminHeaders('disable-cloud-001'),
      payload: {},
    });
    expect(disabled).toMatchObject({ statusCode: 200 });
    const connection = disabled
      .json()
      .providers.find((provider: { provider: string }) => provider.provider === 'ollama_cloud');
    expect(connection).toMatchObject({
      enabled: false,
      credential: { configured: true },
    });
    expect(
      connection.capabilities.every(({ status }: { status: string }) => status === 'disabled'),
    ).toBe(true);

    const reenabled = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/ollama-cloud',
      headers: adminHeaders('reenable-cloud-001'),
      payload: { enabled: true },
    });
    expect(reenabled).toMatchObject({ statusCode: 200 });
    const active = reenabled
      .json()
      .providers.find((provider: { provider: string }) => provider.provider === 'ollama_cloud');
    expect(active.enabled).toBe(true);
    expect(
      active.capabilities.every(({ status }: { status: string }) => status === 'untested'),
    ).toBe(true);
  });

  it('requires an explicit disable before clearing the credential and audits safe metadata', async () => {
    const denied = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/ollama-cloud',
      headers: adminHeaders('clear-cloud-001'),
      payload: { clearApiKey: true },
    });
    expect(denied).toMatchObject({ statusCode: 422 });
    expect(denied.json()).toMatchObject({ code: 'ollama_cloud_key_required' });

    const cleared = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/ollama-cloud',
      headers: adminHeaders('clear-cloud-002'),
      payload: { enabled: false, clearApiKey: true },
    });
    expect(cleared).toMatchObject({ statusCode: 200 });
    expect(cleared.body).not.toContain('replacement-cloud-key');
    const ollama = cleared
      .json()
      .providers.find((provider: { provider: string }) => provider.provider === 'ollama_cloud');
    expect(ollama).toMatchObject({
      enabled: false,
      credential: { configured: false, fingerprint: null },
    });
    expect(
      ollama.capabilities.every(({ status }: { status: string }) => status === 'disabled'),
    ).toBe(true);

    const audit = await pool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM noderag.audit_log
       WHERE action='chat.provider.ollama_cloud.updated'
       ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.detail).toMatchObject({
      enabled: false,
      credentialConfigured: false,
      credentialChanged: true,
    });
    expect(JSON.stringify(audit.rows[0]?.detail)).not.toContain('replacement-cloud-key');
  });

  it('enforces CSRF and idempotency semantics', async () => {
    const csrf = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/ollama-cloud',
      headers: { 'x-test-role': 'admin', 'idempotency-key': 'csrf-cloud-001' },
      payload: { enabled: false },
    });
    expect(csrf).toMatchObject({ statusCode: 403 });

    const first = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/ollama-cloud',
      headers: adminHeaders('idempotency-cloud-001'),
      payload: { enabled: false, maxParallelCalls: 2 },
    });
    const replay = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/ollama-cloud',
      headers: adminHeaders('idempotency-cloud-001'),
      payload: { enabled: false, maxParallelCalls: 2 },
    });
    const conflict = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/ollama-cloud',
      headers: adminHeaders('idempotency-cloud-001'),
      payload: { enabled: false, maxParallelCalls: 5 },
    });
    expect(first).toMatchObject({ statusCode: 200 });
    expect(replay).toMatchObject({ statusCode: 200 });
    expect(conflict).toMatchObject({ statusCode: 409 });
  });

  it('keeps OpenAI OAuth administrator-only and rejects browser-supplied credentials', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/providers/openai-oauth/status',
    });
    const ordinary = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/providers/openai-oauth/status',
      headers: { 'x-test-role': 'user' },
    });
    const searchOnly = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/providers/openai-oauth/status',
      headers: { 'x-test-role': 'search' },
    });
    const disabled = await disabledApp.inject({
      method: 'GET',
      url: '/v1/admin/chat/providers/openai-oauth/status',
      headers: { 'x-test-role': 'admin' },
    });
    expect([
      anonymous.statusCode,
      ordinary.statusCode,
      searchOnly.statusCode,
      disabled.statusCode,
    ]).toEqual([401, 403, 404, 404]);

    const rejectedToken = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/providers/openai-oauth/login',
      headers: adminHeaders('openai-login-browser-token-001'),
      payload: { accessToken: 'browser-token-must-not-cross-api' },
    });
    expect(rejectedToken).toMatchObject({ statusCode: 400 });
    expect(rejectedToken.body).not.toContain('browser-token-must-not-cross-api');
  });

  it('starts and replays the copyable OpenAI device challenge with idempotency', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/providers/openai-oauth/login',
      headers: adminHeaders('openai-login-001'),
      payload: {},
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/providers/openai-oauth/login',
      headers: adminHeaders('openai-login-001'),
      payload: {},
    });
    expect(first).toMatchObject({ statusCode: 200 });
    expect(first.json()).toMatchObject({
      userCode: 'SAFE-CODE',
      verificationUrl: 'https://auth.openai.com/device',
      state: 'pending',
    });
    expect(replay.json()).toEqual(first.json());
    expect(openAiCalls.filter((value) => value === 'login')).toHaveLength(1);
  });

  it('resets OpenAI capability health when the provider is re-enabled or its model changes', async () => {
    await vault.store(
      pool,
      'openai_oauth',
      'credential-cache',
      '{"auth":"synthetic"}',
      principalId,
    );
    const connection = await pool.query<{ id: number }>(
      `UPDATE noderag.chat_provider_connection AS connection
       SET credential_secret_id=secret.id
       FROM noderag.encrypted_secret AS secret
       WHERE connection.provider_kind='openai_oauth'
         AND secret.provider='openai_oauth' AND secret.name='credential-cache'
       RETURNING connection.id`,
    );
    const connectionId = Number(connection.rows[0]?.id);
    await pool.query(
      `INSERT INTO noderag.chat_model_profile
         (connection_id,model,display_name,reasoning_efforts,context_provenance)
       VALUES ($1,'gpt-test','GPT Test',ARRAY['low'],'unknown'),
              ($1,'gpt-next','GPT Next',ARRAY['medium'],'unknown')
       ON CONFLICT (connection_id,model) DO NOTHING`,
      [connectionId],
    );

    const enabled = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/openai-oauth',
      headers: adminHeaders('openai-enable-001'),
      payload: { enabled: true, generationModel: 'gpt-test' },
    });
    expect(enabled).toMatchObject({ statusCode: 200 });
    const enabledCapabilities = await pool.query<{ status: string; tested_at: Date | null }>(
      `SELECT status,tested_at FROM noderag.chat_provider_capability
       WHERE connection_id=$1 ORDER BY capability`,
      [connectionId],
    );
    expect(enabledCapabilities.rows).toEqual([
      { status: 'untested', tested_at: null },
      { status: 'untested', tested_at: null },
    ]);

    await pool.query(
      `UPDATE noderag.chat_provider_capability
       SET status='healthy',tested_at=now() WHERE connection_id=$1`,
      [connectionId],
    );
    const changedModel = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/openai-oauth',
      headers: adminHeaders('openai-model-change-001'),
      payload: { generationModel: 'gpt-next' },
    });
    expect(changedModel).toMatchObject({ statusCode: 200 });
    const changedCapabilities = await pool.query<{ capability: string; status: string }>(
      `SELECT capability,status FROM noderag.chat_provider_capability
       WHERE connection_id=$1 ORDER BY capability`,
      [connectionId],
    );
    expect(changedCapabilities.rows).toEqual([
      { capability: 'generation', status: 'untested' },
      { capability: 'model_catalog', status: 'healthy' },
    ]);

    const disabled = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/openai-oauth',
      headers: adminHeaders('openai-disable-001'),
      payload: { enabled: false },
    });
    expect(disabled).toMatchObject({ statusCode: 200 });
    const reenabled = await app.inject({
      method: 'PUT',
      url: '/v1/admin/chat/providers/openai-oauth',
      headers: adminHeaders('openai-reenable-001'),
      payload: { enabled: true },
    });
    expect(reenabled).toMatchObject({ statusCode: 200 });
    const reenabledStatuses = await pool.query<{ status: string; tested_at: Date | null }>(
      `SELECT status,tested_at FROM noderag.chat_provider_capability
       WHERE connection_id=$1 ORDER BY capability`,
      [connectionId],
    );
    expect(reenabledStatuses.rows).toEqual([
      { status: 'untested', tested_at: null },
      { status: 'untested', tested_at: null },
    ]);
  });

  it('exposes model refresh, account test, cancellation, and confirmed disconnect operations', async () => {
    const operations = [
      ['refresh-models', 'openai-models-001', {}, 'models'],
      ['test', 'openai-test-001', {}, 'test'],
      ['login/cancel', 'openai-cancel-001', {}, 'cancel'],
    ] as const;
    for (const [endpoint, key, payload, observed] of operations) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/admin/chat/providers/openai-oauth/${endpoint}`,
        headers: adminHeaders(key),
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(openAiCalls).toContain(observed);
    }

    const unconfirmed = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/providers/openai-oauth/disconnect',
      headers: adminHeaders('openai-disconnect-001'),
      payload: {},
    });
    expect(unconfirmed).toMatchObject({ statusCode: 400 });
    const disconnected = await app.inject({
      method: 'POST',
      url: '/v1/admin/chat/providers/openai-oauth/disconnect',
      headers: adminHeaders('openai-disconnect-002'),
      payload: { confirmation: 'DISCONNECT' },
    });
    expect(disconnected).toMatchObject({ statusCode: 200 });
    expect(openAiCalls).toContain('disconnect');
  });
});
