import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerChatRoutes } from '../src/api/chat-routes.js';
import type { RequestAuthenticator } from '../src/api/authentication.js';
import { createFakeOllamaCloudProvider } from '../src/chat/fake.js';
import {
  inspectChatEventLog,
  readChatEventLog,
  synchronizeChatEventLog,
} from '../src/chat/log-store.js';
import { processOneChatRun } from '../src/chat/runner.js';
import { CHAT_PROVIDER_CONTRACT_VERSION, type ChatProvider } from '../src/chat/contract.js';
import { probeChatStorage } from '../src/chat/storage.js';
import { runMigrations } from '../src/store/migrations.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;
let disabledApp: FastifyInstance;
let ownerId: number;
let otherId: number;
let noChatId: number;
let chatRoot: string;
let storageParent: string;

const authenticate: RequestAuthenticator = async (request) => {
  const identity = request.headers['x-test-user'];
  if (typeof identity !== 'string') return null;
  const principalId =
    identity === 'owner'
      ? ownerId
      : identity === 'other'
        ? otherId
        : identity === 'no-chat'
          ? noChatId
          : ownerId;
  return {
    principalId,
    serverAdmin: identity === 'admin',
    searchOnly: identity === 'search',
    sessionToken: identity === 'search' ? null : `session-${identity}`,
    csrfAllowed: (candidate) => candidate === 'chat-csrf',
  };
};

const headers = (identity: string, key?: string) => ({
  'x-test-user': identity,
  'x-csrf-token': 'chat-csrf',
  origin: 'http://127.0.0.1:8787',
  ...(key === undefined ? {} : { 'idempotency-key': key }),
});

const createChat = async (name: string, key: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/chats',
    headers: headers('owner', key),
    payload: { name },
  });

const blockingProvider = (): ChatProvider => ({
  kind: 'ollama_cloud',
  contractVersion: CHAT_PROVIDER_CONTRACT_VERSION,
  async listModels() {
    return [];
  },
  async *stream(request) {
    yield {
      type: 'response.started',
      sequence: 0,
      occurredAt: new Date().toISOString(),
    } as const;
    await new Promise<void>((_resolve, reject) => {
      const aborted = () => reject(request.signal.reason);
      if (request.signal.aborted) aborted();
      else request.signal.addEventListener('abort', aborted, { once: true });
    });
  },
});

const waitForRunStatus = async (runId: string, status: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ status: string }>(
      `SELECT status FROM noderag.chat_run WHERE id=$1`,
      [runId],
    );
    if (result.rows[0]?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`chat_run_status_timeout:${status}`);
};

beforeAll(async () => {
  container = await new PostgreSqlContainer(postgresImage)
    .withDatabase('noderag_chat_core')
    .withUsername('noderag')
    .withPassword('synthetic-chat-core-password')
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
  const principals = await pool.query<{ id: number; label: string }>(
    `INSERT INTO noderag.principal(kind,label) VALUES
       ('user','owner'),('user','other'),('user','no-chat') RETURNING id,label`,
  );
  ownerId = Number(principals.rows.find(({ label }) => label === 'owner')?.id);
  otherId = Number(principals.rows.find(({ label }) => label === 'other')?.id);
  noChatId = Number(principals.rows.find(({ label }) => label === 'no-chat')?.id);
  await pool.query(
    `INSERT INTO noderag.chat_entitlement(principal_id,enabled)
     VALUES($1,true),($2,true),($3,false)
     ON CONFLICT (principal_id) DO UPDATE SET enabled=EXCLUDED.enabled`,
    [ownerId, otherId, noChatId],
  );
  const provider = await pool.query<{ id: number }>(
    `UPDATE noderag.chat_provider_connection SET enabled=true,generation_model='minimax-m3:cloud'
     WHERE provider_kind='ollama_cloud' RETURNING id`,
  );
  const providerId = Number(provider.rows[0]?.id);
  await pool.query(
    `UPDATE noderag.chat_provider_capability SET status='healthy',tested_at=now()
     WHERE connection_id=$1 AND capability='generation'`,
    [providerId],
  );
  await pool.query(
    `INSERT INTO noderag.chat_model_profile
       (connection_id,model,display_name,reasoning_efforts,provider_metadata,
        administrator_context_tokens,administrator_output_tokens)
     VALUES($1,'minimax-m3:cloud','MiniMax M3 Cloud',ARRAY['default'],
       '{"catalogStale":false}',128000,4096)`,
    [providerId],
  );
  storageParent = await mkdtemp(join(tmpdir(), 'noderag-chat-core-'));
  const storage = await probeChatStorage(storageParent, { policy: 'testbed' });
  chatRoot = storage.chatRoot;
  const current = await pool.query<{ context_revision_id: number }>(
    `SELECT context_revision_id FROM noderag.chat_configuration_current WHERE singleton=true`,
  );
  const settings = await pool.query<{ id: number }>(
    `INSERT INTO noderag.chat_settings_revision
       (revision_id,context_revision_id,default_connection_id,default_model,
        default_reasoning_effort,default_context_mode,default_allow_research,
        default_allow_rag,default_allow_internet,markdown_only,run_timeout_ms,
        maximum_tool_calls,maximum_parallel_runs_per_user,daily_run_quota,
        daily_input_token_quota,daily_output_token_quota,retention_days,archive_after_days,
        storage_requested_path,storage_resolved_path,storage_manifest_id,created_by)
     VALUES($1,$2,$3,'minimax-m3:cloud','default','rolling',false,false,false,true,
       120000,0,2,100,1000000,250000,365,30,$4,$5,$6,$7)
     RETURNING id`,
    [
      randomUUID(),
      current.rows[0]?.context_revision_id,
      providerId,
      storageParent,
      chatRoot,
      storage.manifest.manifestId,
      ownerId,
    ],
  );
  await pool.query(
    `UPDATE noderag.chat_configuration_current SET settings_revision_id=$1,updated_at=now()`,
    [settings.rows[0]?.id],
  );
  app = Fastify({ logger: false });
  registerChatRoutes(app, { pool, authenticate, enabled: true });
  await app.ready();
  disabledApp = Fastify({ logger: false });
  registerChatRoutes(disabledApp, { pool, authenticate, enabled: false });
  await disabledApp.ready();
});

afterAll(async () => {
  await Promise.all([app.close(), disabledApp.close()]);
  await pool.end();
  await container.stop();
  await rm(storageParent, { recursive: true, force: true });
});

describe('C04 durable Chat core', () => {
  it('enforces the feature gate, browser session, entitlement, CSRF, and API-key denial', async () => {
    const disabled = await disabledApp.inject({
      method: 'GET',
      url: '/v1/chats',
      headers: headers('owner'),
    });
    const search = await app.inject({
      method: 'GET',
      url: '/v1/chats',
      headers: headers('search'),
    });
    const noChat = await app.inject({
      method: 'GET',
      url: '/v1/chats',
      headers: headers('no-chat'),
    });
    const csrf = await app.inject({
      method: 'POST',
      url: '/v1/chats',
      headers: { 'x-test-user': 'owner', 'idempotency-key': 'chat-bad-csrf' },
      payload: { name: 'Denied' },
    });
    expect([disabled.statusCode, search.statusCode, noChat.statusCode, csrf.statusCode]).toEqual([
      404, 404, 403, 403,
    ]);
  });

  it('creates immutable tool-free snapshots and isolates owners', async () => {
    const created = await createChat('Owner notes', 'chat-create-owner-001');
    const replay = await createChat('Owner notes', 'chat-create-owner-001');
    expect(created).toMatchObject({ statusCode: 201 });
    expect(replay.json()).toEqual(created.json());
    expect(created.json()).toMatchObject({
      provider: 'ollama_cloud',
      model: 'minimax-m3:cloud',
      capabilities: { research: false, rag: false, internet: false },
    });
    const chatId = String(created.json().id);
    const other = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}`,
      headers: headers('other'),
    });
    expect(other.json()).toMatchObject({ status: 404, code: 'chat_not_found' });
    await expect(
      pool.query(`UPDATE noderag.chat_conversation_configuration_revision SET model='changed'`),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('queues exactly one active run, persists streaming output, and resumes events/logs', async () => {
    const created = await createChat('Streaming chat', 'chat-create-stream-001');
    const chatId = String(created.json().id);
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner', 'chat-send-stream-001'),
      payload: { content: 'Give me a short answer.' },
    });
    const conflict = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner', 'chat-send-stream-002'),
      payload: { content: 'This must not queue.' },
    });
    expect(sent).toMatchObject({ statusCode: 202 });
    expect(conflict.json()).toMatchObject({ status: 409, code: 'chat_run_active' });
    expect(
      await processOneChatRun({
        pool,
        leaseOwner: 'integration-worker',
        resolveProvider: async () =>
          createFakeOllamaCloudProvider({
            model: 'minimax-m3:cloud',
            output: 'A durable Cloud answer.',
            reasoningSummary: 'Used the supplied conversation only.',
          }),
      }),
    ).toBe(true);
    await pool.query(
      `INSERT INTO noderag.chat_tool_call
         (id,run_id,ordinal,call_id,tool_name,arguments,status,result_bytes,duration_ms,
          result_count,result_summary,finished_at)
       VALUES($1,$2,0,'call-test-1','research.list_sources.v1','{}'::jsonb,'completed',
              128,250,2,'{"kind":"research"}'::jsonb,now())`,
      [randomUUID(), String(sent.json().runId)],
    );
    const messages = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner'),
    });
    expect(messages.json().items).toMatchObject([
      { role: 'user', content: 'Give me a short answer.', state: 'committed' },
      {
        role: 'assistant',
        content: 'A durable Cloud answer.',
        state: 'committed',
        reasoning_summary: 'Used the supplied conversation only.',
        toolCalls: [
          {
            ordinal: 0,
            name: 'research.list_sources.v1',
            arguments: {},
            status: 'completed',
            resultBytes: 128,
            durationMs: 250,
            resultCount: 2,
            resultSummary: { kind: 'research' },
            safeErrorCode: null,
          },
        ],
        activities: [
          {
            type: 'thinking',
            sequence: 2,
            text: 'Used the supplied conversation only.',
          },
          {
            type: 'tool',
            sequence: 3,
            toolCall: {
              ordinal: 0,
              name: 'research.list_sources.v1',
              arguments: {},
              status: 'completed',
              resultBytes: 128,
              durationMs: 250,
              resultCount: 2,
              resultSummary: { kind: 'research' },
              safeErrorCode: null,
            },
          },
        ],
      },
    ]);
    const events = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/events?once=true`,
      headers: headers('owner'),
    });
    expect(events.statusCode).toBe(200);
    expect(events.body).toContain('event: response.completed');
    expect(events.body).not.toContain('api-key');
    const firstEvent = await pool.query<{ id: string }>(
      `SELECT id FROM noderag.chat_event WHERE conversation_id=$1 ORDER BY id LIMIT 1`,
      [chatId],
    );
    const replay = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/events?once=true`,
      headers: {
        ...headers('owner'),
        'last-event-id': String(firstEvent.rows[0]?.id),
      },
    });
    expect(replay.body).not.toContain(`id: ${String(firstEvent.rows[0]?.id)}\n`);
    expect(replay.body).toContain('event: response.completed');
    const restartedApi = Fastify({ logger: false });
    registerChatRoutes(restartedApi, { pool, authenticate, enabled: true });
    await restartedApi.ready();
    const afterRestart = await restartedApi.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner'),
    });
    await restartedApi.close();
    expect(afterRestart.json().items).toEqual(messages.json().items);
    const log = await readChatEventLog(chatRoot, chatId);
    expect(log.at(-1)?.type).toBe('response.completed');
    expect(
      log.every((event, index) => index === 0 || event.previousSha256 === log[index - 1]?.sha256),
    ).toBe(true);
    const beforeRecovery = await inspectChatEventLog(chatRoot, chatId);
    const segment = await pool.query<{
      event_count: number;
      byte_length: unknown;
      content_sha256: Buffer;
      storage_relative_path: string;
    }>(
      `SELECT event_count,byte_length,content_sha256,storage_relative_path
       FROM noderag.chat_log_segment WHERE conversation_id=$1 AND state='active'`,
      [chatId],
    );
    expect(segment.rows[0]).toMatchObject({
      event_count: log.length,
      storage_relative_path: `conversations/${chatId}/events.ndjson`,
    });
    expect(Number(segment.rows[0]?.byte_length)).toBe(beforeRecovery.byteLength);
    expect(segment.rows[0]?.content_sha256.toString('hex')).toBe(beforeRecovery.contentSha256);
    await appendFile(
      join(chatRoot, 'conversations', chatId, 'events.ndjson'),
      '{"contract":"chat-core.v1"',
      'utf8',
    );
    expect(await synchronizeChatEventLog(pool, chatRoot, chatId)).toBe(0);
    expect(await readChatEventLog(chatRoot, chatId)).toEqual(log);
    const afterRecovery = await inspectChatEventLog(chatRoot, chatId);
    expect(afterRecovery).toMatchObject({
      eventCount: log.length,
      lastDatabaseEventId: log.at(-1)?.databaseEventId,
    });
    expect(afterRecovery.byteLength).toBe(beforeRecovery.byteLength);
    expect(afterRecovery.contentSha256).toBe(beforeRecovery.contentSha256);
  });

  it('reclaims an expired worker lease and replaces the abandoned partial response', async () => {
    const created = await createChat('Recovered worker chat', 'chat-create-recovery-001');
    const chatId = String(created.json().id);
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner', 'chat-send-recovery-001'),
      payload: { content: 'Recover this response.' },
    });
    await pool.query(
      `UPDATE noderag.chat_run
       SET status='running',attempts=1,lease_owner='stopped-worker',
           leased_until=now()-interval '1 second',heartbeat_at=now()-interval '1 minute',
           safe_error_code='chat_provider_timeout',error_retryable=true
       WHERE id=$1`,
      [sent.json().runId],
    );
    await pool.query(
      `UPDATE noderag.chat_message SET content='abandoned partial text'
       WHERE id=$1`,
      [sent.json().responseMessageId],
    );
    expect(
      await processOneChatRun({
        pool,
        leaseOwner: 'replacement-worker',
        leaseMilliseconds: 5_000,
        resolveProvider: async () =>
          createFakeOllamaCloudProvider({
            model: 'minimax-m3:cloud',
            output: 'Recovered exactly once.',
          }),
      }),
    ).toBe(true);
    const run = await pool.query<{
      status: string;
      attempts: number;
      safe_error_code: string | null;
      error_retryable: boolean;
    }>(
      `SELECT status,attempts,safe_error_code,error_retryable
       FROM noderag.chat_run WHERE id=$1`,
      [sent.json().runId],
    );
    const response = await pool.query<{ content: string; state: string }>(
      `SELECT content,state FROM noderag.chat_message WHERE id=$1`,
      [sent.json().responseMessageId],
    );
    const recovered = await pool.query<{ count: string }>(
      `SELECT count(*) FROM noderag.chat_event
       WHERE run_id=$1 AND event_type='run.recovered'`,
      [sent.json().runId],
    );
    expect(run.rows[0]).toEqual({
      status: 'completed',
      attempts: 2,
      safe_error_code: null,
      error_retryable: false,
    });
    expect(response.rows[0]).toEqual({ content: 'Recovered exactly once.', state: 'committed' });
    expect(Number(recovered.rows[0]?.count)).toBe(1);
  });

  it('fails closed when a provider repeats an event sequence', async () => {
    const created = await createChat('Invalid provider stream', 'chat-create-order-001');
    const chatId = String(created.json().id);
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner', 'chat-send-order-001'),
      payload: { content: 'Do not accept duplicated events.' },
    });
    await pool.query(`UPDATE noderag.chat_run SET maximum_attempts=1 WHERE id=$1`, [
      sent.json().runId,
    ]);
    const invalidProvider: ChatProvider = {
      kind: 'ollama_cloud',
      contractVersion: CHAT_PROVIDER_CONTRACT_VERSION,
      async listModels() {
        return [];
      },
      async *stream() {
        yield {
          type: 'response.started',
          sequence: 0,
          occurredAt: new Date().toISOString(),
        } as const;
        yield {
          type: 'response.output_text.delta',
          sequence: 0,
          occurredAt: new Date().toISOString(),
          text: 'duplicated',
        } as const;
      },
    };
    await processOneChatRun({
      pool,
      leaseOwner: 'order-worker',
      resolveProvider: async () => invalidProvider,
    });
    const run = await pool.query<{ status: string; safe_error_code: string }>(
      `SELECT status,safe_error_code FROM noderag.chat_run WHERE id=$1`,
      [sent.json().runId],
    );
    const response = await pool.query<{ content: string; state: string }>(
      `SELECT content,state FROM noderag.chat_message WHERE id=$1`,
      [sent.json().responseMessageId],
    );
    expect(run.rows[0]).toEqual({
      status: 'failed',
      safe_error_code: 'chat_provider_invalid_event_order',
    });
    expect(response.rows[0]).toEqual({ content: '', state: 'failed' });
  });

  it('times out an unresponsive provider and persists only a safe failure code', async () => {
    const created = await createChat('Timeout chat', 'chat-create-timeout-001');
    const chatId = String(created.json().id);
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner', 'chat-send-timeout-001'),
      payload: { content: 'This provider will not return.' },
    });
    await pool.query(`UPDATE noderag.chat_run SET maximum_attempts=1 WHERE id=$1`, [
      sent.json().runId,
    ]);
    await processOneChatRun({
      pool,
      leaseOwner: 'timeout-worker',
      runTimeoutCeilingMilliseconds: 25,
      resolveProvider: async () => blockingProvider(),
    });
    const run = await pool.query<{ status: string; safe_error_code: string }>(
      `SELECT status,safe_error_code FROM noderag.chat_run WHERE id=$1`,
      [sent.json().runId],
    );
    expect(run.rows[0]).toEqual({ status: 'failed', safe_error_code: 'chat_provider_timeout' });
  });

  it('interrupts a running provider after Stop and leaves a resumable cancelled run', async () => {
    const created = await createChat('Cancellation chat', 'chat-create-cancel-001');
    const chatId = String(created.json().id);
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner', 'chat-send-cancel-001'),
      payload: { content: 'Stop this response.' },
    });
    const processing = processOneChatRun({
      pool,
      leaseOwner: 'cancellation-worker',
      leaseMilliseconds: 3_000,
      resolveProvider: async () => blockingProvider(),
    });
    await waitForRunStatus(String(sent.json().runId), 'running');
    const stopped = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/runs/${String(sent.json().runId)}/stop`,
      headers: headers('owner', 'chat-stop-cancel-001'),
      payload: {},
    });
    expect(stopped.json()).toMatchObject({ status: 'cancelling' });
    await processing;
    const run = await pool.query<{
      status: string;
      safe_error_code: string | null;
      lease_owner: string | null;
    }>(`SELECT status,safe_error_code,lease_owner FROM noderag.chat_run WHERE id=$1`, [
      sent.json().runId,
    ]);
    const response = await pool.query<{ state: string }>(
      `SELECT state FROM noderag.chat_message WHERE id=$1`,
      [sent.json().responseMessageId],
    );
    const eventTypes = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM noderag.chat_event WHERE run_id=$1 ORDER BY sequence`,
      [sent.json().runId],
    );
    expect({ run: run.rows[0], response: response.rows[0], events: eventTypes.rows }).toEqual({
      run: { status: 'cancelled', safe_error_code: null, lease_owner: null },
      response: { state: 'cancelled' },
      events: expect.arrayContaining([
        { event_type: 'run.queued' },
        { event_type: 'response.started' },
        { event_type: 'run.cancel_requested' },
        { event_type: 'response.completed' },
      ]),
    });
  });

  it('supports rename, archive, failed-run retry, stop, and confirmed purge', async () => {
    const created = await createChat('Lifecycle chat', 'chat-create-life-001');
    const chatId = String(created.json().id);
    const rename = await app.inject({
      method: 'PATCH',
      url: `/v1/chats/${chatId}`,
      headers: headers('owner', 'chat-rename-life-001'),
      payload: { name: 'Renamed lifecycle chat' },
    });
    expect(rename.json().name).toBe('Renamed lifecycle chat');
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner', 'chat-send-life-001'),
      payload: { content: 'Fail once.' },
    });
    await processOneChatRun({
      pool,
      leaseOwner: 'failure-worker',
      resolveProvider: async () =>
        createFakeOllamaCloudProvider({
          model: 'minimax-m3:cloud',
          failWith: { code: 'synthetic_permanent', retryable: false },
        }),
    });
    const retry = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/runs/${String(sent.json().runId)}/retry`,
      headers: headers('owner', 'chat-retry-life-001'),
      payload: {},
    });
    expect(retry.statusCode).toBe(202);
    const stop = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/runs/${String(retry.json().runId)}/stop`,
      headers: headers('owner', 'chat-stop-life-001'),
      payload: {},
    });
    expect(stop.json()).toMatchObject({ status: 'cancelled' });
    const archived = await app.inject({
      method: 'PATCH',
      url: `/v1/chats/${chatId}`,
      headers: headers('owner', 'chat-archive-life-001'),
      payload: { archived: true },
    });
    expect(archived.json().archived).toBe(true);
    const purge = await app.inject({
      method: 'DELETE',
      url: `/v1/chats/${chatId}`,
      headers: headers('owner', 'chat-purge-life-001'),
      payload: { confirmation: 'PURGE' },
    });
    expect(purge.json()).toEqual({ purged: true });
  });
});
