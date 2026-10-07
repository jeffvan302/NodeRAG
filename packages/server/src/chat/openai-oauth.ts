import { randomUUID } from 'node:crypto';
import { chmod, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import { writeAuditEvent } from '../application/audit.js';
import type { SecretVault } from '../identity/secrets.js';
import { databaseInteger } from '../store/database.js';
import {
  CodexAppServerError,
  SupervisedCodexAppServer,
  preparePrivateCodexHome,
  type AppServerNotification,
  type AppServerRequest,
  type CodexModelCapacityEvidence,
} from './codex-app-server.js';

const CREDENTIAL_PROVIDER = 'openai_oauth';
const CREDENTIAL_NAME = 'credential-cache';
const AUTH_FILE_NAME = 'auth.json';
const MAX_AUTH_FILE_BYTES = 512 * 1024;
const LOGIN_LIFETIME_MS = 15 * 60 * 1_000;
const MODEL_PAGE_SIZE = 100;
const MAX_MODEL_PAGES = 10;

const chatGptAccountSchema = z
  .object({
    type: z.literal('chatgpt'),
    email: z.string().email().nullable(),
    planType: z.string().min(1).max(80),
  })
  .passthrough();

const accountResponseSchema = z
  .object({
    account: chatGptAccountSchema.nullable().optional(),
    requiresOpenaiAuth: z.boolean(),
  })
  .passthrough();

const deviceLoginSchema = z
  .object({
    type: z.literal('chatgptDeviceCode'),
    loginId: z.string().min(1).max(300),
    userCode: z.string().min(1).max(100),
    verificationUrl: z.string().url().max(2_000),
  })
  .strict();

const loginCompletionSchema = z
  .object({
    loginId: z.string().max(300).nullable().optional(),
    success: z.boolean(),
    error: z.string().max(1_000).nullable().optional(),
  })
  .passthrough();

const modelSchema = z
  .object({
    id: z.string().min(1).max(240),
    model: z.string().min(1).max(180),
    displayName: z.string().min(1).max(240),
    description: z.string().max(2_000),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    defaultReasoningEffort: z.string().min(1).max(32),
    supportedReasoningEfforts: z
      .array(
        z
          .object({
            reasoningEffort: z.string().min(1).max(32),
            description: z.string().max(1_000),
          })
          .passthrough(),
      )
      .max(16),
    inputModalities: z
      .array(z.enum(['text', 'image', 'audio']))
      .max(8)
      .optional(),
    supportsPersonality: z.boolean().optional(),
  })
  .passthrough();

const modelPageSchema = z
  .object({
    data: z.array(modelSchema).max(MODEL_PAGE_SIZE),
    nextCursor: z.string().max(2_000).nullable().optional(),
  })
  .passthrough();

const rateWindowSchema = z
  .object({
    usedPercent: z.number().int().min(0).max(100),
    resetsAt: z.number().int().nonnegative().nullable().optional(),
    windowDurationMins: z.number().int().positive().nullable().optional(),
  })
  .passthrough();

const rateLimitSchema = z
  .object({
    limitId: z.string().max(120).nullable().optional(),
    limitName: z.string().max(240).nullable().optional(),
    planType: z.string().max(80).nullable().optional(),
    primary: rateWindowSchema.nullable().optional(),
    secondary: rateWindowSchema.nullable().optional(),
    spendControlReached: z.boolean().nullable().optional(),
    rateLimitReachedType: z.string().max(120).nullable().optional(),
  })
  .passthrough();

const rateLimitsResponseSchema = z
  .object({
    rateLimits: rateLimitSchema,
    rateLimitsByLimitId: z.record(z.string(), rateLimitSchema).nullable().optional(),
  })
  .passthrough();

export interface OpenAiAccountSummary {
  readonly connected: boolean;
  readonly requiresOpenaiAuth: boolean;
  readonly email: string | null;
  readonly planType: string | null;
}

export interface OpenAiRateLimitSummary {
  readonly buckets: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly planType: string | null;
    readonly primary: z.infer<typeof rateWindowSchema> | null;
    readonly secondary: z.infer<typeof rateWindowSchema> | null;
    readonly spendControlReached: boolean | null;
    readonly reachedType: string | null;
  }[];
}

export type OpenAiLoginState = 'pending' | 'succeeded' | 'denied' | 'cancelled' | 'expired';

export interface OpenAiLoginChallenge {
  readonly loginId: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresAt: string;
  readonly state: OpenAiLoginState;
  readonly safeErrorCode: string | null;
}

export interface OpenAiCatalogModel {
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly reasoningEfforts: readonly string[];
  readonly defaultReasoningEffort: string;
  readonly inputModalities: readonly ('text' | 'image' | 'audio')[];
  readonly isDefault: boolean;
  readonly supportsPersonality: boolean;
  readonly effectiveContextTokens: number | null;
  readonly maximumContextTokens: number | null;
  readonly maximumOutputTokens: number | null;
}

export interface OpenAiOAuthRuntime {
  readonly state: string;
  start(): Promise<void>;
  call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  readModelCapacities?(): Promise<readonly CodexModelCapacityEvidence[]>;
  stop(): Promise<void>;
}

export interface OpenAiOAuthManagerOptions {
  readonly pool: Pool;
  readonly secretVault: SecretVault;
  readonly credentialHome: string;
  readonly now?: () => Date;
  readonly createRuntime?: (
    notificationHandler: (notification: AppServerNotification) => void,
    requestHandler: (request: AppServerRequest) => Promise<unknown>,
  ) => OpenAiOAuthRuntime;
}

interface PendingLogin extends OpenAiLoginChallenge {
  readonly principalId: number;
  readonly expiresAtMs: number;
}

const safeVerificationUrl = (raw: string): string => {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    !(
      hostname === 'openai.com' ||
      hostname.endsWith('.openai.com') ||
      hostname === 'chatgpt.com' ||
      hostname.endsWith('.chatgpt.com')
    )
  ) {
    throw new CodexAppServerError(
      'openai_verification_url_rejected',
      'The OpenAI verification address was not approved.',
    );
  }
  return url.toString();
};

const assertCredentialCache = (value: string): string => {
  if (Buffer.byteLength(value, 'utf8') > MAX_AUTH_FILE_BYTES) {
    throw new CodexAppServerError(
      'openai_credential_cache_too_large',
      'The OpenAI credential cache is larger than allowed.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CodexAppServerError(
      'openai_credential_cache_invalid',
      'The encrypted OpenAI credential cache is invalid.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CodexAppServerError(
      'openai_credential_cache_invalid',
      'The encrypted OpenAI credential cache is invalid.',
    );
  }
  return value;
};

const safeAuthPath = async (credentialHome: string): Promise<string> => {
  const home = await preparePrivateCodexHome(credentialHome);
  return join(home, AUTH_FILE_NAME);
};

const readCredentialFile = async (credentialHome: string): Promise<string> => {
  const path = await safeAuthPath(credentialHome);
  const information = await lstat(path).catch(() => null);
  if (information === null || !information.isFile() || information.isSymbolicLink()) {
    throw new CodexAppServerError(
      'openai_credential_cache_missing',
      'The OpenAI credential cache was not created.',
    );
  }
  if (information.size > MAX_AUTH_FILE_BYTES) {
    throw new CodexAppServerError(
      'openai_credential_cache_too_large',
      'The OpenAI credential cache is larger than allowed.',
    );
  }
  await chmod(path, 0o600);
  return assertCredentialCache(await readFile(path, 'utf8'));
};

const writeCredentialFile = async (credentialHome: string, value: string): Promise<void> => {
  const checked = assertCredentialCache(value);
  const target = await safeAuthPath(credentialHome);
  const existing = await lstat(target).catch(() => null);
  if (existing !== null && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new CodexAppServerError(
      'openai_credential_cache_unsafe',
      'The OpenAI credential cache path is unsafe.',
    );
  }
  const temporary = join(dirname(target), `.auth-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(checked, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await chmod(target, 0o600);
};

const unlinkCredentialFile = async (credentialHome: string): Promise<void> => {
  const path = await safeAuthPath(credentialHome);
  const information = await lstat(path).catch(() => null);
  if (information === null) return;
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new CodexAppServerError(
      'openai_credential_cache_unsafe',
      'The OpenAI credential cache path is unsafe.',
    );
  }
  await unlink(path);
};

const accountSummary = (value: unknown): OpenAiAccountSummary => {
  const response = accountResponseSchema.parse(value);
  const account = response.account ?? null;
  return {
    connected: account !== null && !response.requiresOpenaiAuth,
    requiresOpenaiAuth: response.requiresOpenaiAuth,
    email: account?.email ?? null,
    planType: account?.planType ?? null,
  };
};

const safeCapabilityError = (error: unknown): string =>
  error instanceof CodexAppServerError ? error.code : 'openai_oauth_operation_failed';

export class OpenAiOAuthManager {
  readonly #options: OpenAiOAuthManagerOptions;
  readonly #runtime: OpenAiOAuthRuntime;
  #startPromise: Promise<void> | null = null;
  #pending: PendingLogin | null = null;
  #notificationWork: Promise<void> = Promise.resolve();
  readonly #chatNotificationListeners = new Set<(notification: AppServerNotification) => void>();
  readonly #chatRequestListeners = new Set<
    (request: AppServerRequest) => Promise<unknown | null>
  >();

  constructor(options: OpenAiOAuthManagerOptions) {
    this.#options = options;
    const notificationHandler = (notification: AppServerNotification): void => {
      for (const listener of this.#chatNotificationListeners) listener(notification);
      this.#notificationWork = this.#notificationWork
        .then(() => this.#handleNotification(notification))
        .catch(() => undefined);
    };
    const requestHandler = async (request: AppServerRequest): Promise<unknown> => {
      if (request.method !== 'item/tool/call') {
        throw new CodexAppServerError('app_server_method_denied', 'Server request denied.');
      }
      for (const listener of this.#chatRequestListeners) {
        const response = await listener(request);
        if (response !== null) return response;
      }
      throw new CodexAppServerError('app_server_request_unclaimed', 'Server request unclaimed.');
    };
    this.#runtime =
      options.createRuntime?.(notificationHandler, requestHandler) ??
      new SupervisedCodexAppServer({
        credentialHome: options.credentialHome,
        onNotification: notificationHandler,
        onRequest: requestHandler,
      });
  }

  get runtimeState(): string {
    return this.#runtime.state;
  }

  subscribeChatNotifications(listener: (notification: AppServerNotification) => void): () => void {
    this.#chatNotificationListeners.add(listener);
    return () => this.#chatNotificationListeners.delete(listener);
  }

  subscribeChatRequests(
    listener: (request: AppServerRequest) => Promise<unknown | null>,
  ): () => void {
    this.#chatRequestListeners.add(listener);
    return () => this.#chatRequestListeners.delete(listener);
  }

  async callChatRuntime(
    method: 'thread/start' | 'turn/start' | 'turn/interrupt' | 'thread/delete',
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.ensureStarted();
    return this.#runtime.call(method, params, signal);
  }

  async ensureStarted(): Promise<void> {
    if (this.#runtime.state === 'ready') return;
    if (this.#startPromise !== null) return this.#startPromise;
    this.#startPromise = (async () => {
      if (this.#runtime.state === 'failed') await this.#runtime.stop();
      const encrypted = await this.#options.secretVault.reveal(
        this.#options.pool,
        CREDENTIAL_PROVIDER,
        CREDENTIAL_NAME,
      );
      if (encrypted !== null) await writeCredentialFile(this.#options.credentialHome, encrypted);
      await this.#runtime.start();
    })();
    try {
      await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  async status(refreshToken = false): Promise<{
    account: OpenAiAccountSummary;
    login: OpenAiLoginChallenge | null;
    rateLimits: OpenAiRateLimitSummary | null;
    runtimeState: string;
  }> {
    await this.ensureStarted();
    await this.#notificationWork;
    await this.#expirePendingIfNeeded();
    const account = accountSummary(await this.#runtime.call('account/read', { refreshToken }));
    if (refreshToken && account.connected && this.#pending !== null) {
      await this.#persistCredential(this.#pending.principalId, account);
    }
    let rateLimits: OpenAiRateLimitSummary | null = null;
    if (account.connected) {
      try {
        rateLimits = await this.#readRateLimits();
      } catch {
        rateLimits = null;
      }
    }
    return {
      account,
      login: this.#publicPending(),
      rateLimits,
      runtimeState: this.#runtime.state,
    };
  }

  async startLogin(principalId: number): Promise<OpenAiLoginChallenge> {
    await this.ensureStarted();
    await this.#notificationWork;
    await this.#expirePendingIfNeeded();
    if (this.#pending?.state === 'pending') return this.#publicPending() as OpenAiLoginChallenge;
    const response = deviceLoginSchema.parse(
      await this.#runtime.call('account/login/start', { type: 'chatgptDeviceCode' }),
    );
    const now = this.#now().getTime();
    this.#pending = {
      loginId: response.loginId,
      userCode: response.userCode,
      verificationUrl: safeVerificationUrl(response.verificationUrl),
      expiresAt: new Date(now + LOGIN_LIFETIME_MS).toISOString(),
      expiresAtMs: now + LOGIN_LIFETIME_MS,
      state: 'pending',
      safeErrorCode: null,
      principalId,
    };
    return this.#publicPending() as OpenAiLoginChallenge;
  }

  async cancelLogin(principalId: number): Promise<OpenAiLoginChallenge | null> {
    await this.ensureStarted();
    await this.#notificationWork;
    if (this.#pending === null) return null;
    if (this.#pending.principalId !== principalId) {
      throw new CodexAppServerError(
        'openai_login_owned_by_another_administrator',
        'Another administrator started this sign-in.',
      );
    }
    if (this.#pending.state === 'pending') {
      await this.#runtime.call('account/login/cancel', { loginId: this.#pending.loginId });
      this.#pending = { ...this.#pending, state: 'cancelled' };
    }
    return this.#publicPending();
  }

  async refreshModels(principalId: number): Promise<readonly OpenAiCatalogModel[]> {
    await this.ensureStarted();
    const account = accountSummary(
      await this.#runtime.call('account/read', { refreshToken: false }),
    );
    if (!account.connected) {
      throw new CodexAppServerError('openai_oauth_required', 'OpenAI sign-in is required.');
    }
    const models: OpenAiCatalogModel[] = [];
    const capacityEvidence = await this.#runtime.readModelCapacities?.().catch(() => []);
    const capacities = new Map(
      (capacityEvidence ?? []).map((capacity) => [capacity.model.toLowerCase(), capacity]),
    );
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const response = modelPageSchema.parse(
        await this.#runtime.call('model/list', {
          cursor,
          includeHidden: false,
          limit: MODEL_PAGE_SIZE,
        }),
      );
      for (const model of response.data) {
        if (model.hidden) continue;
        const efforts = model.supportedReasoningEfforts.map(({ reasoningEffort }) =>
          reasoningEffort.trim().toLowerCase(),
        );
        const validEfforts = [...new Set(efforts)].filter((effort) =>
          /^[a-z][a-z0-9_-]{0,31}$/u.test(effort),
        );
        const defaultEffort = model.defaultReasoningEffort.trim().toLowerCase();
        const capacity = capacities.get(model.model.toLowerCase());
        models.push({
          model: model.model,
          displayName: model.displayName,
          description: model.description,
          reasoningEfforts: validEfforts.length === 0 ? [defaultEffort || 'default'] : validEfforts,
          defaultReasoningEffort: defaultEffort || 'default',
          inputModalities: model.inputModalities ?? ['text', 'image'],
          isDefault: model.isDefault,
          supportsPersonality: model.supportsPersonality ?? false,
          effectiveContextTokens: capacity?.effectiveContextTokens ?? null,
          maximumContextTokens: capacity?.maximumContextTokens ?? null,
          maximumOutputTokens: capacity?.maximumOutputTokens ?? null,
        });
      }
      cursor = response.nextCursor ?? null;
      if (cursor === null) break;
      if (seenCursors.has(cursor)) {
        throw new CodexAppServerError(
          'openai_model_catalog_cursor_repeated',
          'The OpenAI model catalog repeated a page.',
        );
      }
      seenCursors.add(cursor);
      if (page === MAX_MODEL_PAGES - 1) {
        throw new CodexAppServerError(
          'openai_model_catalog_too_large',
          'The OpenAI model catalog exceeded its safe page limit.',
        );
      }
    }
    if (models.length === 0) {
      throw new CodexAppServerError(
        'openai_model_catalog_empty',
        'The connected account returned no available models.',
      );
    }
    await this.#replaceModels(models, principalId);
    return models;
  }

  async testConnection(principalId: number): Promise<{
    account: OpenAiAccountSummary;
    modelCount: number;
    rateLimits: OpenAiRateLimitSummary | null;
  }> {
    const account = accountSummary(
      await (async () => {
        await this.ensureStarted();
        return this.#runtime.call('account/read', { refreshToken: true });
      })(),
    );
    if (!account.connected) {
      throw new CodexAppServerError('openai_oauth_required', 'OpenAI sign-in is required.');
    }
    await this.#persistCredential(principalId, account);
    const models = await this.refreshModels(principalId);
    const rateLimits = await this.#readRateLimits().catch(() => null);
    return { account, modelCount: models.length, rateLimits };
  }

  async disconnect(principalId: number): Promise<void> {
    await this.ensureStarted();
    if (this.#pending?.state === 'pending') {
      await this.#runtime.call('account/login/cancel', { loginId: this.#pending.loginId });
    }
    await this.#runtime.call('account/logout', {});
    await this.#options.secretVault.remove(
      this.#options.pool,
      CREDENTIAL_PROVIDER,
      CREDENTIAL_NAME,
    );
    await unlinkCredentialFile(this.#options.credentialHome);
    await this.#options.pool.query(
      `UPDATE noderag.chat_provider_connection
       SET enabled=false, credential_secret_id=NULL, generation_model=NULL,
           metadata='{}'::jsonb, updated_at=now(), updated_by=$1
       WHERE provider_kind='openai_oauth'`,
      [principalId],
    );
    await this.#options.pool.query(
      `UPDATE noderag.chat_provider_capability capability
       SET status='disabled', latency_ms=NULL, safe_error_code=NULL,
           metadata='{}'::jsonb, tested_at=now(), updated_at=now()
       FROM noderag.chat_provider_connection connection
       WHERE connection.id=capability.connection_id
         AND connection.provider_kind='openai_oauth'`,
    );
    this.#pending = null;
  }

  async stop(): Promise<void> {
    await this.#notificationWork;
    await this.#runtime.stop();
  }

  async #handleNotification(notification: AppServerNotification): Promise<void> {
    if (notification.method !== 'account/login/completed') return;
    const completion = loginCompletionSchema.parse(notification.params);
    const pending = this.#pending;
    if (
      pending === null ||
      (completion.loginId !== null && completion.loginId !== pending.loginId)
    ) {
      return;
    }
    if (!completion.success) {
      this.#pending = {
        ...pending,
        state: 'denied',
        safeErrorCode: 'openai_login_denied',
      };
      await writeAuditEvent(this.#options.pool, {
        principalId: pending.principalId,
        action: 'chat.provider.openai_oauth.login.completed',
        result: 'error',
        detail: { errorCode: 'openai_login_denied' },
      });
      return;
    }
    try {
      const account = accountSummary(
        await this.#runtime.call('account/read', { refreshToken: true }),
      );
      if (!account.connected) {
        throw new CodexAppServerError(
          'openai_login_incomplete',
          'OpenAI sign-in did not return an account.',
        );
      }
      await this.#persistCredential(pending.principalId, account);
      this.#pending = { ...pending, state: 'succeeded', safeErrorCode: null };
      await writeAuditEvent(this.#options.pool, {
        principalId: pending.principalId,
        action: 'chat.provider.openai_oauth.login.completed',
        result: 'ok',
        detail: { planType: account.planType },
      });
    } catch (error) {
      this.#pending = {
        ...pending,
        state: 'denied',
        safeErrorCode: safeCapabilityError(error),
      };
    }
  }

  async #persistCredential(principalId: number, account: OpenAiAccountSummary): Promise<void> {
    let credential: string | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        credential = await readCredentialFile(this.#options.credentialHome);
        break;
      } catch (error) {
        if (
          !(error instanceof CodexAppServerError) ||
          error.code !== 'openai_credential_cache_missing' ||
          attempt === 4
        ) {
          throw error;
        }
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50 * (attempt + 1)));
      }
    }
    if (credential === null) {
      throw new CodexAppServerError(
        'openai_credential_cache_missing',
        'The OpenAI credential cache was not created.',
      );
    }
    await this.#options.secretVault.store(
      this.#options.pool,
      CREDENTIAL_PROVIDER,
      CREDENTIAL_NAME,
      credential,
      principalId,
    );
    const secret = await this.#options.pool.query<{ id: unknown }>(
      `SELECT id FROM noderag.encrypted_secret WHERE provider=$1 AND name=$2`,
      [CREDENTIAL_PROVIDER, CREDENTIAL_NAME],
    );
    const secretId = secret.rows[0]?.id;
    if (secretId === undefined) {
      throw new CodexAppServerError(
        'openai_credential_persistence_failed',
        'The encrypted OpenAI credential was not saved.',
      );
    }
    await this.#options.pool.query(
      `UPDATE noderag.chat_provider_connection
       SET enabled=true, credential_secret_id=$1,
           metadata=jsonb_build_object(
             'accountEmail',$2::text,
             'planType',$3::text,
             'sharedAccount',true,
             'credentialUpdatedAt',now()
           ),
           updated_at=now(), updated_by=$4
       WHERE provider_kind='openai_oauth'`,
      [
        databaseInteger(secretId, 'OpenAI OAuth secret id'),
        account.email,
        account.planType,
        principalId,
      ],
    );
    await this.#options.pool.query(
      `UPDATE noderag.chat_provider_capability capability
       SET status='untested', latency_ms=NULL, safe_error_code=NULL,
           metadata='{}'::jsonb, tested_at=NULL, updated_at=now()
       FROM noderag.chat_provider_connection connection
       WHERE connection.id=capability.connection_id
         AND connection.provider_kind='openai_oauth'`,
    );
  }

  async #replaceModels(models: readonly OpenAiCatalogModel[], principalId: number): Promise<void> {
    const result = await this.#options.pool.query<{ id: unknown; generation_model: string | null }>(
      `SELECT id, generation_model FROM noderag.chat_provider_connection
       WHERE provider_kind='openai_oauth'`,
    );
    const connection = result.rows[0];
    if (connection === undefined) {
      throw new CodexAppServerError(
        'chat_provider_unavailable',
        'The OpenAI provider record is unavailable.',
      );
    }
    const connectionId = databaseInteger(connection.id, 'OpenAI provider connection id');
    await this.#options.pool.query(
      `UPDATE noderag.chat_model_profile
       SET provider_metadata=provider_metadata || '{"catalogStale":true}'::jsonb,updated_at=now()
       WHERE connection_id=$1`,
      [connectionId],
    );
    for (const model of models) {
      const hasContextEvidence =
        model.effectiveContextTokens !== null || model.maximumContextTokens !== null;
      await this.#options.pool.query(
        `INSERT INTO noderag.chat_model_profile
           (connection_id, model, display_name, reasoning_efforts,
            advertised_context_tokens, configured_context_tokens, runtime_context_tokens,
            maximum_output_tokens, context_provenance, provenance_note,
            provider_metadata, checked_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,now(),$11)
         ON CONFLICT (connection_id,model) DO UPDATE SET
           display_name=EXCLUDED.display_name,reasoning_efforts=EXCLUDED.reasoning_efforts,
           advertised_context_tokens=EXCLUDED.advertised_context_tokens,
           configured_context_tokens=EXCLUDED.configured_context_tokens,
           runtime_context_tokens=EXCLUDED.runtime_context_tokens,
           maximum_output_tokens=EXCLUDED.maximum_output_tokens,
           context_provenance=EXCLUDED.context_provenance,
           provenance_note=EXCLUDED.provenance_note,
           provider_metadata=EXCLUDED.provider_metadata,checked_at=EXCLUDED.checked_at,
           updated_at=now(),updated_by=EXCLUDED.updated_by`,
        [
          connectionId,
          model.model,
          model.displayName,
          model.reasoningEfforts,
          model.maximumContextTokens,
          model.effectiveContextTokens,
          model.maximumOutputTokens,
          hasContextEvidence ? 'provider_catalog' : 'unknown',
          hasContextEvidence
            ? 'The live Codex model catalog reported the effective and maximum context windows. Output capacity is retained only when that catalog reports it.'
            : 'The live Codex model catalog did not report a usable context or output token limit for this model.',
          {
            description: model.description,
            inputModalities: model.inputModalities,
            defaultReasoningEffort: model.defaultReasoningEffort,
            isDefault: model.isDefault,
            supportsPersonality: model.supportsPersonality,
            capacityEvidence: {
              source: 'codex_live_model_catalog',
              effectiveContextTokens: model.effectiveContextTokens,
              maximumContextTokens: model.maximumContextTokens,
              maximumOutputTokens: model.maximumOutputTokens,
            },
            catalogStale: false,
          },
          principalId,
        ],
      );
    }
    const currentStillExists = models.some(({ model }) => model === connection.generation_model);
    const selected = currentStillExists
      ? connection.generation_model
      : (models.find(({ isDefault }) => isDefault)?.model ?? models[0]?.model ?? null);
    await this.#options.pool.query(
      `UPDATE noderag.chat_provider_connection
       SET generation_model=$2, updated_at=now(), updated_by=$3
       WHERE id=$1`,
      [connectionId, selected, principalId],
    );
    await this.#options.pool.query(
      `UPDATE noderag.chat_provider_capability
       SET status='healthy', latency_ms=NULL, safe_error_code=NULL,
           metadata=jsonb_build_object('modelCount',$2::integer),
           tested_at=now(), updated_at=now()
       WHERE connection_id=$1 AND capability='model_catalog'`,
      [connectionId, models.length],
    );
  }

  async #readRateLimits(): Promise<OpenAiRateLimitSummary> {
    const response = rateLimitsResponseSchema.parse(
      await this.#runtime.call('account/rateLimits/read', {}),
    );
    const entries = response.rateLimitsByLimitId ?? { default: response.rateLimits };
    return {
      buckets: Object.entries(entries).map(([id, limit]) => ({
        id,
        name: limit.limitName ?? null,
        planType: limit.planType ?? null,
        primary: limit.primary ?? null,
        secondary: limit.secondary ?? null,
        spendControlReached: limit.spendControlReached ?? null,
        reachedType: limit.rateLimitReachedType ?? null,
      })),
    };
  }

  async #expirePendingIfNeeded(): Promise<void> {
    if (
      this.#pending === null ||
      this.#pending.state !== 'pending' ||
      this.#pending.expiresAtMs > this.#now().getTime()
    ) {
      return;
    }
    try {
      await this.#runtime.call('account/login/cancel', { loginId: this.#pending.loginId });
    } catch {
      // Expiry remains authoritative even if app-server already discarded the login.
    }
    this.#pending = { ...this.#pending, state: 'expired' };
  }

  #publicPending(): OpenAiLoginChallenge | null {
    if (this.#pending === null) return null;
    return {
      loginId: this.#pending.loginId,
      userCode: this.#pending.userCode,
      verificationUrl: this.#pending.verificationUrl,
      expiresAt: this.#pending.expiresAt,
      state: this.#pending.state,
      safeErrorCode: this.#pending.safeErrorCode,
    };
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
}
