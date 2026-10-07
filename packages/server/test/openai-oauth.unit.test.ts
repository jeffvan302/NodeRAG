import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppServerNotification } from '../src/chat/codex-app-server.js';
import { OpenAiOAuthManager, type OpenAiOAuthRuntime } from '../src/chat/openai-oauth.js';
import { SecretVault } from '../src/identity/secrets.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface SecretRow {
  id: number;
  key_version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  fingerprint: string;
}

class FakePool {
  secret: SecretRow | null = null;
  provider = {
    id: 2,
    enabled: false,
    credentialSecretId: null as number | null,
    model: null as string | null,
  };
  models: Array<{
    model: string;
    efforts: string[];
    advertisedContextTokens: number | null;
    runtimeContextTokens: number | null;
    maximumOutputTokens: number | null;
    provenance: string;
    metadata: Record<string, unknown>;
  }> = [];
  audits: string[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/gu, ' ').trim();
    if (normalized.startsWith('SELECT key_version, nonce, ciphertext, auth_tag')) {
      return {
        rows: (this.secret === null
          ? []
          : [
              {
                key_version: this.secret.key_version,
                nonce: this.secret.nonce,
                ciphertext: this.secret.ciphertext,
                auth_tag: this.secret.auth_tag,
              },
            ]) as unknown as Row[],
        rowCount: this.secret === null ? 0 : 1,
      };
    }
    if (normalized.startsWith('INSERT INTO noderag.encrypted_secret')) {
      this.secret = {
        id: 31,
        key_version: parameters[2] as number,
        nonce: parameters[3] as Buffer,
        ciphertext: parameters[4] as Buffer,
        auth_tag: parameters[5] as Buffer,
        fingerprint: parameters[6] as string,
      };
      return {
        rows: [{ updated_at: new Date('2026-09-15T12:00:00Z') }] as unknown as Row[],
        rowCount: 1,
      };
    }
    if (normalized.startsWith('DELETE FROM noderag.encrypted_secret')) {
      const existed = this.secret !== null;
      this.secret = null;
      return { rows: [], rowCount: existed ? 1 : 0 };
    }
    if (normalized.startsWith('SELECT id FROM noderag.encrypted_secret')) {
      return {
        rows: (this.secret === null ? [] : [{ id: this.secret.id }]) as unknown as Row[],
        rowCount: this.secret === null ? 0 : 1,
      };
    }
    if (normalized.startsWith('UPDATE noderag.chat_provider_connection SET enabled=true')) {
      this.provider.enabled = true;
      this.provider.credentialSecretId = parameters[0] as number;
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE noderag.chat_provider_connection SET enabled=false')) {
      this.provider.enabled = false;
      this.provider.credentialSecretId = null;
      this.provider.model = null;
      return { rows: [], rowCount: 1 };
    }
    if (
      normalized.startsWith('SELECT id, generation_model FROM noderag.chat_provider_connection')
    ) {
      return {
        rows: [{ id: this.provider.id, generation_model: this.provider.model }] as unknown as Row[],
        rowCount: 1,
      };
    }
    if (normalized.startsWith('UPDATE noderag.chat_model_profile SET provider_metadata=')) {
      this.models = this.models.map((model) => ({
        ...model,
        metadata: { ...model.metadata, catalogStale: true },
      }));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO noderag.chat_model_profile')) {
      const next = {
        model: parameters[1] as string,
        efforts: parameters[3] as string[],
        advertisedContextTokens: parameters[4] as number | null,
        runtimeContextTokens: parameters[5] as number | null,
        maximumOutputTokens: parameters[6] as number | null,
        provenance: parameters[7] as string,
        metadata: parameters[9] as Record<string, unknown>,
      };
      this.models = [...this.models.filter(({ model }) => model !== next.model), next];
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE noderag.chat_provider_connection SET generation_model=')) {
      this.provider.model = parameters[1] as string;
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO noderag.audit_log')) {
      this.audits.push(parameters[3] as string);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE noderag.chat_provider_capability')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected fake query: ${normalized}`);
  }
}

const model = (
  name: string,
  options: {
    hidden?: boolean;
    isDefault?: boolean;
    efforts?: string[];
    modalities?: string[];
  } = {},
) => ({
  id: `id-${name}`,
  model: name,
  displayName: name.toUpperCase(),
  description: `Description for ${name}`,
  hidden: options.hidden ?? false,
  isDefault: options.isDefault ?? false,
  defaultReasoningEffort: options.efforts?.[0] ?? 'medium',
  supportedReasoningEfforts: (options.efforts ?? ['medium']).map((reasoningEffort) => ({
    reasoningEffort,
    description: reasoningEffort,
  })),
  ...(options.modalities === undefined ? {} : { inputModalities: options.modalities }),
});

class FakeRuntime implements OpenAiOAuthRuntime {
  state = 'stopped';
  connected = false;
  calls: Array<{ method: string; params: unknown }> = [];
  pages: unknown[] = [{ data: [model('gpt-default', { isDefault: true })], nextCursor: null }];
  capacities: Array<{
    model: string;
    effectiveContextTokens: number;
    maximumContextTokens: number;
    maximumOutputTokens: number | null;
  }> = [];
  readonly #notification: (notification: AppServerNotification) => void;

  constructor(notification: (notification: AppServerNotification) => void) {
    this.#notification = notification;
  }

  async start(): Promise<void> {
    this.state = 'ready';
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
  }

  async call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'account/read') {
      return this.connected
        ? {
            account: { type: 'chatgpt', email: 'shared@example.test', planType: 'team' },
            requiresOpenaiAuth: false,
          }
        : { account: null, requiresOpenaiAuth: true };
    }
    if (method === 'account/login/start') {
      return {
        type: 'chatgptDeviceCode',
        loginId: 'login-1',
        verificationUrl: 'https://auth.openai.com/device',
        userCode: 'ABCD-EFGH',
      };
    }
    if (method === 'account/login/cancel') return { status: 'canceled' };
    if (method === 'account/logout') {
      this.connected = false;
      return {};
    }
    if (method === 'model/list') {
      const page = this.pages.shift();
      if (page === undefined) throw new Error('No fake model page.');
      return page;
    }
    if (method === 'account/rateLimits/read') {
      return {
        rateLimits: {
          limitId: 'codex',
          limitName: 'Codex',
          planType: 'team',
          primary: { usedPercent: 25, resetsAt: 2_000_000_000, windowDurationMins: 300 },
        },
      };
    }
    throw new Error(`Unexpected fake app-server call: ${method}`);
  }

  async readModelCapacities() {
    return this.capacities;
  }

  complete(success: boolean): void {
    this.connected = success;
    this.#notification({
      method: 'account/login/completed',
      params: { loginId: 'login-1', success, ...(success ? {} : { error: 'denied' }) },
    });
  }
}

const fixture = async (now = new Date('2026-09-15T12:00:00Z')) => {
  const root = await mkdtemp(join(tmpdir(), 'noderag-openai-oauth-test-'));
  temporaryRoots.push(root);
  const home = join(root, 'codex-home');
  const pool = new FakePool();
  const vault = new SecretVault(randomBytes(32));
  let currentTime = now;
  let runtime: FakeRuntime | undefined;
  const manager = new OpenAiOAuthManager({
    pool: pool as never as Pool,
    secretVault: vault,
    credentialHome: home,
    now: () => currentTime,
    createRuntime: (notification) => {
      runtime = new FakeRuntime(notification);
      return runtime;
    },
  });
  return {
    root,
    home,
    pool,
    vault,
    manager,
    runtime: () => runtime as FakeRuntime,
    advance: (milliseconds: number) => {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
  };
};

describe('OpenAI OAuth manager', () => {
  it('starts a device-code login, reuses it, and never accepts a browser token', async () => {
    const item = await fixture();
    const challenge = await item.manager.startLogin(7);
    expect(challenge).toMatchObject({
      state: 'pending',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.openai.com/device',
    });
    await expect(item.manager.startLogin(7)).resolves.toEqual(challenge);
    expect(
      item.runtime().calls.filter(({ method }) => method === 'account/login/start'),
    ).toHaveLength(1);
    expect(JSON.stringify(item.runtime().calls)).not.toContain('accessToken');
    expect(JSON.stringify(item.runtime().calls)).not.toContain('apiKey');
  });

  it('expires and cancels a stale pending login', async () => {
    const item = await fixture();
    await item.manager.startLogin(7);
    item.advance(15 * 60 * 1_000 + 1);
    const status = await item.manager.status();
    expect(status.login?.state).toBe('expired');
    expect(item.runtime().calls).toContainEqual({
      method: 'account/login/cancel',
      params: { loginId: 'login-1' },
    });
  });

  it('supports explicit cancellation and prevents another administrator from cancelling', async () => {
    const item = await fixture();
    await item.manager.startLogin(7);
    await expect(item.manager.cancelLogin(8)).rejects.toMatchObject({
      code: 'openai_login_owned_by_another_administrator',
    });
    await expect(item.manager.cancelLogin(7)).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('encrypts a successful credential cache and restores it after a manager restart', async () => {
    const item = await fixture();
    await item.manager.startLogin(7);
    await mkdir(item.home, { recursive: true });
    const rawCredential = JSON.stringify({
      tokens: { access_token: 'secret-a', refresh_token: 'secret-r' },
    });
    await writeFile(join(item.home, 'auth.json'), rawCredential, { mode: 0o600 });
    item.runtime().complete(true);
    await expect(item.manager.status()).resolves.toMatchObject({
      account: { connected: true, planType: 'team' },
      login: { state: 'succeeded' },
    });
    expect(item.pool.secret).not.toBeNull();
    expect(item.pool.secret?.ciphertext.toString('utf8')).not.toContain('secret-a');
    expect(item.pool.provider.enabled).toBe(true);

    const restoredHome = join(item.root, 'restored-home');
    let restoredRuntime: FakeRuntime | undefined;
    const restarted = new OpenAiOAuthManager({
      pool: item.pool as never as Pool,
      secretVault: item.vault,
      credentialHome: restoredHome,
      createRuntime: (notification) => {
        restoredRuntime = new FakeRuntime(notification);
        restoredRuntime.connected = true;
        return restoredRuntime;
      },
    });
    await restarted.ensureStarted();
    expect(await readFile(join(restoredHome, 'auth.json'), 'utf8')).toBe(rawCredential);
    await restarted.stop();
  });

  it('records a denied login without persisting a credential', async () => {
    const item = await fixture();
    await item.manager.startLogin(7);
    item.runtime().complete(false);
    await expect(item.manager.status()).resolves.toMatchObject({
      account: { connected: false },
      login: { state: 'denied', safeErrorCode: 'openai_login_denied' },
    });
    expect(item.pool.secret).toBeNull();
    expect(item.pool.audits).toContain('chat.provider.openai_oauth.login.completed');
  });

  it('paginates and persists live visible models, future efforts, and default modalities', async () => {
    const item = await fixture();
    await item.manager.ensureStarted();
    item.runtime().connected = true;
    item.runtime().pages = [
      {
        data: [
          model('hidden-model', { hidden: true }),
          model('gpt-existing', { efforts: ['low', 'future_effort'] }),
        ],
        nextCursor: 'page-2',
      },
      {
        data: [model('gpt-new-default', { isDefault: true, modalities: ['text', 'audio'] })],
        nextCursor: null,
      },
    ];
    item.runtime().capacities = [
      {
        model: 'gpt-existing',
        effectiveContextTokens: 272_000,
        maximumContextTokens: 1_000_000,
        maximumOutputTokens: 128_000,
      },
    ];
    item.pool.provider.model = 'removed-model';
    const models = await item.manager.refreshModels(7);
    expect(models.map(({ model: name }) => name)).toEqual(['gpt-existing', 'gpt-new-default']);
    expect(models[0]?.reasoningEfforts).toEqual(['low', 'future_effort']);
    expect(models[0]?.inputModalities).toEqual(['text', 'image']);
    expect(item.pool.models).toHaveLength(2);
    expect(item.pool.models[0]?.efforts).toEqual(['low', 'future_effort']);
    expect(item.pool.models[0]).toMatchObject({
      advertisedContextTokens: 1_000_000,
      runtimeContextTokens: 272_000,
      maximumOutputTokens: 128_000,
      provenance: 'provider_catalog',
      metadata: {
        capacityEvidence: {
          source: 'codex_live_model_catalog',
          effectiveContextTokens: 272_000,
          maximumContextTokens: 1_000_000,
          maximumOutputTokens: 128_000,
        },
      },
    });
    expect(item.pool.models[1]).toMatchObject({
      advertisedContextTokens: null,
      runtimeContextTokens: null,
      maximumOutputTokens: null,
      provenance: 'unknown',
    });
    expect(item.pool.provider.model).toBe('gpt-new-default');
    expect(item.pool.models.every(({ metadata }) => !('contextTokens' in metadata))).toBe(true);
  });

  it('detects repeated catalog cursors and disconnects without retaining credentials', async () => {
    const item = await fixture();
    await item.manager.ensureStarted();
    item.runtime().connected = true;
    item.runtime().pages = [
      { data: [model('one')], nextCursor: 'repeat' },
      { data: [model('two')], nextCursor: 'repeat' },
    ];
    await expect(item.manager.refreshModels(7)).rejects.toMatchObject({
      code: 'openai_model_catalog_cursor_repeated',
    });

    await item.manager.startLogin(7);
    await mkdir(item.home, { recursive: true });
    await writeFile(
      join(item.home, 'auth.json'),
      JSON.stringify({ tokens: { refresh_token: 'x' } }),
    );
    item.runtime().complete(true);
    await item.manager.status();
    await item.manager.disconnect(7);
    expect(item.pool.secret).toBeNull();
    expect(item.pool.provider).toMatchObject({
      enabled: false,
      credentialSecretId: null,
      model: null,
    });
    await expect(readFile(join(item.home, 'auth.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
