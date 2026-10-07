import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { registerChatRoutes } from '../src/api/chat-routes.js';
import type { RequestAuthenticator } from '../src/api/authentication.js';
import {
  CHAT_PROVIDER_CONTRACT_VERSION,
  type ChatProvider,
  type ChatProviderRequest,
} from '../src/chat/contract.js';
import { processOneChatRun } from '../src/chat/runner.js';
import { processOneManualContextCompression } from '../src/chat/context-compression.js';
import { loadChatHealth } from '../src/chat/health.js';
import { readSealedChatEventLog } from '../src/chat/log-store.js';
import {
  previewChatStorageReconciliation,
  reconcileChatStorage,
  writePortableChatManifest,
} from '../src/chat/reconciliation.js';
import { probeChatStorage } from '../src/chat/storage.js';
import { runMigrations } from '../src/store/migrations.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;
let ownerId: number;
let otherId: number;
let storageParent: string;
let chatRoot: string;
let mainRequests: ChatProviderRequest[];
let activeLayers: number;
let maximumActiveLayers: number;

const headers = (user: 'owner' | 'other', key?: string) => ({
  'x-test-user': user,
  'x-csrf-token': 'context-csrf',
  origin: 'http://127.0.0.1:8787',
  ...(key === undefined ? {} : { 'idempotency-key': key }),
});

const layerState = JSON.stringify({
  goal: 'Keep the long conversation bounded.',
  constraints: ['Ollama means Ollama Cloud only.'],
  preferences: ['Preserve citations.'],
  decisions: ['Use immutable compression snapshots.'],
  failedApproaches: [],
  openQuestions: [],
  entities: [{ name: 'NodeRag', kind: 'application', notes: 'Owns the archive.' }],
  currentPhase: 'C10',
  flaggedNotes: ['Pinned text must remain exact.'],
});

const providerFor = (kind: 'ollama_cloud' | 'openai_oauth'): ChatProvider => ({
  kind,
  contractVersion: CHAT_PROVIDER_CONTRACT_VERSION,
  async listModels() {
    return [];
  },
  async *stream(request) {
    const layer = request.model === 'compress-l2' || request.model === 'compress-l3';
    if (layer) {
      activeLayers += 1;
      maximumActiveLayers = Math.max(maximumActiveLayers, activeLayers);
      await new Promise((resolve) => setTimeout(resolve, 30));
    } else {
      mainRequests.push(request);
    }
    const output =
      request.model === 'compress-l2'
        ? 'The user is implementing bounded NodeRag context and requires the Cloud-only boundary.'
        : request.model === 'compress-l3'
          ? layerState
          : 'The managed answer completed.';
    let sequence = 0;
    yield {
      type: 'response.started',
      sequence: sequence++,
      occurredAt: new Date().toISOString(),
      providerRequestId: `context-${randomUUID()}`,
    } as const;
    yield {
      type: 'response.output_text.delta',
      sequence: sequence++,
      occurredAt: new Date().toISOString(),
      text: output,
    } as const;
    yield {
      type: 'response.usage',
      sequence: sequence++,
      occurredAt: new Date().toISOString(),
      inputTokens: request.messages.reduce((total, message) => total + message.content.length, 0),
      outputTokens: output.length,
    } as const;
    yield {
      type: 'response.completed',
      sequence,
      occurredAt: new Date().toISOString(),
      finishReason: 'stop',
    } as const;
    if (layer) activeLayers -= 1;
  },
});

beforeAll(async () => {
  container = await new PostgreSqlContainer(postgresImage)
    .withDatabase('noderag_chat_context')
    .withUsername('noderag')
    .withPassword('synthetic-chat-context-password')
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
    `INSERT INTO noderag.principal(kind,label) VALUES ('user','context-owner'),('user','context-other')
     RETURNING id,label`,
  );
  ownerId = Number(principals.rows.find(({ label }) => label === 'context-owner')?.id);
  otherId = Number(principals.rows.find(({ label }) => label === 'context-other')?.id);
  await pool.query(
    `INSERT INTO noderag.chat_entitlement(principal_id,enabled) VALUES($1,true),($2,true)
     ON CONFLICT (principal_id) DO UPDATE SET enabled=true`,
    [ownerId, otherId],
  );
  const connections = await pool.query<{ id: number; provider_kind: string }>(
    `UPDATE noderag.chat_provider_connection SET enabled=true
     WHERE provider_kind IN ('ollama_cloud','openai_oauth') RETURNING id,provider_kind`,
  );
  const ollamaId = Number(
    connections.rows.find(({ provider_kind: provider }) => provider === 'ollama_cloud')?.id,
  );
  const openAiId = Number(
    connections.rows.find(({ provider_kind: provider }) => provider === 'openai_oauth')?.id,
  );
  await pool.query(
    `UPDATE noderag.chat_provider_capability SET status='healthy',tested_at=now()
     WHERE connection_id=ANY($1::bigint[]) AND capability='generation'`,
    [[ollamaId, openAiId]],
  );
  await pool.query(
    `INSERT INTO noderag.chat_model_profile
       (connection_id,model,display_name,reasoning_efforts,provider_metadata,
        administrator_context_tokens,administrator_output_tokens)
     VALUES
       ($1,'answer-model','Answer model',ARRAY['default'],'{"catalogStale":false}',128000,4096),
       ($1,'compress-l2','Compression narrative',ARRAY['default'],'{"catalogStale":false}',128000,1024),
       ($2,'compress-l3','Compression state',ARRAY['default'],'{"catalogStale":false}',128000,1024)`,
    [ollamaId, openAiId],
  );
  const context = await pool.query<{ id: number }>(
    `INSERT INTO noderag.chat_context_settings_revision
       (revision_id,rolling_turn_limit,input_reserve_tokens,output_reserve_tokens,
        pinned_instruction_reserve_tokens,tool_result_reserve_tokens,managed_enabled,
        managed_trigger_percent,managed_keep_recent_turns,l1_pin_limit_tokens,
        l2_connection_id,l2_model,l2_reasoning_effort,l2_instructions,l2_output_target_tokens,
        l3_connection_id,l3_model,l3_reasoning_effort,l3_instructions,l3_output_target_tokens,
        l3_state_schema,created_by)
     VALUES($1,12,256,1024,4096,2048,true,50,1,4096,
       $2,'compress-l2','default','Summarize decisions, constraints, citations, and failed approaches.',512,
       $3,'compress-l3','default','Return only the required strict JSON state.',512,
       '{}',$4) RETURNING id`,
    [randomUUID(), ollamaId, openAiId, ownerId],
  );
  storageParent = await mkdtemp(join(tmpdir(), 'noderag-chat-context-'));
  const storage = await probeChatStorage(storageParent, { policy: 'testbed' });
  chatRoot = storage.chatRoot;
  const settings = await pool.query<{ id: number }>(
    `INSERT INTO noderag.chat_settings_revision
       (revision_id,context_revision_id,default_connection_id,default_model,
        default_reasoning_effort,default_context_mode,default_allow_research,
        default_allow_rag,default_allow_internet,markdown_only,run_timeout_ms,
        maximum_tool_calls,maximum_parallel_runs_per_user,daily_run_quota,
        daily_input_token_quota,daily_output_token_quota,retention_days,archive_after_days,
        storage_requested_path,storage_resolved_path,storage_manifest_id,created_by)
     VALUES($1,$2,$3,'answer-model','default','managed',false,false,false,true,
       120000,0,2,100,1000000,250000,365,30,$4,$5,$6,$7) RETURNING id`,
    [
      randomUUID(),
      context.rows[0]?.id,
      ollamaId,
      storageParent,
      storage.chatRoot,
      storage.manifest.manifestId,
      ownerId,
    ],
  );
  await pool.query(
    `UPDATE noderag.chat_configuration_current
     SET context_revision_id=$1,settings_revision_id=$2,updated_at=now(),updated_by=$3`,
    [context.rows[0]?.id, settings.rows[0]?.id, ownerId],
  );
  const authenticate: RequestAuthenticator = async (request) => {
    const identity = request.headers['x-test-user'];
    if (identity !== 'owner' && identity !== 'other') return null;
    return {
      principalId: identity === 'owner' ? ownerId : otherId,
      serverAdmin: false,
      searchOnly: false,
      sessionToken: `context-${identity}`,
      csrfAllowed: (token) => token === 'context-csrf',
    };
  };
  app = Fastify({ logger: false });
  registerChatRoutes(app, { pool, authenticate, enabled: true });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
  await rm(storageParent, { recursive: true, force: true });
});

const createManagedHistory = async (name: string, key: string, turns: number) => {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/chats',
    headers: headers('owner', key),
    payload: { name, contextMode: 'managed' },
  });
  const chatId = String(created.json().id);
  for (let turn = 0; turn < turns; turn += 1) {
    for (const [offset, role] of ['user', 'assistant'].entries()) {
      await pool.query(
        `INSERT INTO noderag.chat_message
           (id,conversation_id,sequence,role,content,state,completed_at)
         VALUES($1,$2,$3,$4,$5,'committed',now())`,
        [randomUUID(), chatId, turn * 2 + offset, role, `${role} manual turn ${String(turn)}`],
      );
    }
  }
  return chatId;
};

describe('C10 managed context and exact pins', () => {
  test('compresses complete turns, retains an exact pin, and records provider usage', async () => {
    mainRequests = [];
    activeLayers = 0;
    maximumActiveLayers = 0;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/chats',
      headers: headers('owner', 'context-create'),
      payload: { name: 'Managed context', contextMode: 'managed' },
    });
    expect(created.statusCode).toBe(201);
    const chatId = String(created.json().id);
    const prior = Array.from({ length: 4 }, (_, turn) => [
      {
        id: randomUUID(),
        sequence: turn * 2,
        role: 'user',
        content: turn === 0 ? 'Exact pinned requirement.' : `Historical question ${String(turn)}`,
      },
      {
        id: randomUUID(),
        sequence: turn * 2 + 1,
        role: 'assistant',
        content: `Historical answer ${String(turn)}`,
      },
    ]).flat();
    for (const row of prior) {
      await pool.query(
        `INSERT INTO noderag.chat_message
           (id,conversation_id,sequence,role,content,state,completed_at)
         VALUES($1,$2,$3,$4,$5,'committed',now())`,
        [row.id, chatId, row.sequence, row.role, row.content],
      );
    }
    const pinned = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/messages/${prior[0]?.id}/pin`,
      headers: headers('owner', 'context-pin'),
      payload: { pinned: true },
    });
    const denied = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/messages/${prior[0]?.id}/pin`,
      headers: headers('other', 'context-pin-other'),
      payload: { pinned: false },
    });
    expect(pinned.json()).toMatchObject({ pinned: true });
    expect(denied.json()).toMatchObject({ status: 404, code: 'chat_not_found' });
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner', 'context-send'),
      payload: { content: 'Continue from the retained state.' },
    });
    expect(sent.statusCode).toBe(202);
    expect(
      await processOneChatRun({
        pool,
        leaseOwner: 'context-worker',
        resolveProvider: async (kind) => providerFor(kind),
      }),
    ).toBe(true);
    expect(maximumActiveLayers).toBe(2);
    expect(mainRequests).toHaveLength(1);
    expect(mainRequests[0]?.messages.map(({ content }) => content)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Managed context narrative'),
        expect.stringContaining('Managed context structured state'),
        'Exact pinned requirement.',
        'Historical question 3',
        'Historical answer 3',
        'Continue from the retained state.',
      ]),
    );
    const job = await pool.query<{ state: string; progress_percent: string }>(
      `SELECT state,progress_percent::text FROM noderag.chat_context_compression_job
       WHERE conversation_id=$1`,
      [chatId],
    );
    expect(job.rows[0]).toEqual({ state: 'completed', progress_percent: '100.00' });
    const snapshot = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM noderag.chat_context_snapshot
       WHERE conversation_id=$1 AND minimum_integrity_passed`,
      [chatId],
    );
    expect(snapshot.rows[0]?.count).toBe('1');
    const segments = await pool.query<{
      segment_number: number;
      state: string;
      storage_encoding: string;
      manifest_revision_id: string | null;
    }>(
      `SELECT segment_number,state,storage_encoding,manifest_revision_id
       FROM noderag.chat_log_segment WHERE conversation_id=$1 ORDER BY segment_number`,
      [chatId],
    );
    expect(segments.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segment_number: 1,
          state: 'sealed',
          storage_encoding: 'gzip',
          manifest_revision_id: expect.any(String),
        }),
        expect.objectContaining({ segment_number: 2, state: 'active' }),
      ]),
    );
    const archivedEvents = await readSealedChatEventLog(pool, chatRoot, chatId, 1);
    expect(archivedEvents.length).toBeGreaterThan(0);
    expect(archivedEvents.at(-1)?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const folded = await pool.query<{ id: string; pinned: boolean; context_state: string }>(
      `SELECT id,pinned,context_state FROM noderag.chat_message
       WHERE conversation_id=$1 AND sequence<6 ORDER BY sequence`,
      [chatId],
    );
    expect(folded.rows).toHaveLength(6);
    expect(folded.rows.every(({ context_state: value }) => value === 'folded')).toBe(true);
    expect(folded.rows[0]).toMatchObject({ id: prior[0]?.id, pinned: true });
    const run = await pool.query<{
      status: string;
      context_snapshot_id: string;
      input_usage_source: string;
      estimated_input_tokens: string;
    }>(
      `SELECT status,context_snapshot_id,input_usage_source,estimated_input_tokens::text
       FROM noderag.chat_run WHERE id=$1`,
      [sent.json().runId],
    );
    expect(run.rows[0]).toMatchObject({
      status: 'completed',
      input_usage_source: 'provider_exact',
    });
    expect(Number(run.rows[0]?.estimated_input_tokens)).toBeGreaterThan(0);
    const history = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/messages?limit=30`,
      headers: headers('owner'),
    });
    expect(history.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: prior[0]?.id,
          pinned: true,
          contextState: 'folded',
          archive: expect.objectContaining({
            segmentNumber: 1,
            encoding: 'gzip',
            integrity: 'verified',
          }),
        }),
      ]),
    );
    expect(history.json().historySources).toEqual(['database', 'sealed_archive']);

    await writePortableChatManifest(pool, chatRoot, chatId);
    const present = await previewChatStorageReconciliation(pool, chatRoot, {
      [String(ownerId)]: ownerId,
    });
    expect(present.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: chatId, action: 'already_present' }),
      ]),
    );
    await pool.query(`DELETE FROM noderag.chat_conversation WHERE id=$1`, [chatId]);
    const unmapped = await previewChatStorageReconciliation(pool, chatRoot, {});
    expect(unmapped.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'owner_unmapped',
          detail: expect.objectContaining({ conversationId: chatId }),
        }),
      ]),
    );
    const recoverable = await previewChatStorageReconciliation(pool, chatRoot, {
      [String(ownerId)]: ownerId,
    });
    expect(recoverable.canReconcile).toBe(true);
    expect(recoverable.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: chatId, action: 'import' }),
      ]),
    );
    const imported = await reconcileChatStorage(pool, {
      chatRoot,
      requestedBy: ownerId,
      ownerMap: { [String(ownerId)]: ownerId },
    });
    expect(imported).toMatchObject({ state: 'completed', importedChats: 1 });
    const restored = await pool.query<{ messages: string; events: string; owner: string }>(
      `SELECT count(DISTINCT message.id)::text AS messages,
              count(DISTINCT event.event_id)::text AS events,
              max(conversation.owner_principal_id)::text AS owner
       FROM noderag.chat_conversation AS conversation
       JOIN noderag.chat_message AS message ON message.conversation_id=conversation.id
       JOIN noderag.chat_event AS event ON event.conversation_id=conversation.id
       WHERE conversation.id=$1`,
      [chatId],
    );
    expect(restored.rows[0]).toMatchObject({ messages: '10', owner: String(ownerId) });
    expect(Number(restored.rows[0]?.events)).toBeGreaterThan(0);
    const replay = await reconcileChatStorage(pool, {
      chatRoot,
      requestedBy: ownerId,
      ownerMap: { [String(ownerId)]: ownerId },
    });
    expect(replay).toMatchObject({ state: 'completed', idempotentReplay: true });
    const restoredArchive = await readSealedChatEventLog(pool, chatRoot, chatId, 1);
    expect(restoredArchive.map(({ eventId }) => eventId)).toEqual(
      archivedEvents.map(({ eventId }) => eventId),
    );
    await writePortableChatManifest(pool, chatRoot, chatId);
    const reexported = await previewChatStorageReconciliation(pool, chatRoot, {
      [String(ownerId)]: ownerId,
    });
    expect(reexported.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: chatId, action: 'already_present' }),
      ]),
    );
    const health = await loadChatHealth(pool);
    expect(health).toMatchObject({
      contract: 'chat-health.v1',
      storage: { configured: true, state: 'healthy' },
      archives: { failedSample: 0, unlinkedFoldedMessages: 0 },
      reconciliation: { operations: { completed: 1 } },
      performance: {
        sampleLimit: 10000,
        timeToFirstTokenMs: { samples: expect.any(Number) },
        eventCommitLatencyMs: { samples: expect.any(Number) },
        toolCallLatencyMs: { samples: expect.any(Number) },
        contextInputTokens: { samples: expect.any(Number) },
        compressionRatio: { samples: expect.any(Number) },
        runtimeMemory: { rssBytes: expect.any(String), heapUsedBytes: expect.any(String) },
      },
    });
    expect(health.providers.map(({ provider }) => provider)).toEqual([
      'ollama_cloud',
      'openai_oauth',
    ]);
    expect(health.errorsLast24Hours).toEqual([]);

    const ownerConflict = await previewChatStorageReconciliation(pool, chatRoot, {
      [String(ownerId)]: otherId,
    });
    expect(ownerConflict.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'owner_conflict' })]),
    );

    const manifestFolder = join(chatRoot, 'conversations', chatId, 'backup-manifests');
    const manifestFiles = await readdir(manifestFolder);
    const sourceManifestPath = join(manifestFolder, String(manifestFiles.sort().at(-1)));
    const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8')) as {
      createdAt: string;
      segments: Array<Record<string, unknown>>;
    };
    const activeSegment = sourceManifest.segments.find(({ state }) => state === 'active');
    expect(activeSegment).toBeDefined();
    const sourceRelativePath = String(activeSegment?.['relativePath']);
    const sourceBytes = await readFile(join(chatRoot, ...sourceRelativePath.split('/')));
    const partialBytes = sourceBytes.subarray(0, sourceBytes.length - 1);
    const partialRelativePath = `conversations/${chatId}/events.partial.ndjson`;
    await writeFile(join(chatRoot, ...partialRelativePath.split('/')), partialBytes);
    Object.assign(activeSegment ?? {}, {
      relativePath: partialRelativePath,
      byteLength: partialBytes.byteLength,
      contentSha256: createHash('sha256').update(partialBytes).digest('hex'),
      uncompressedByteLength: partialBytes.byteLength,
      uncompressedSha256: createHash('sha256').update(partialBytes).digest('hex'),
    });
    sourceManifest.createdAt = new Date(Date.now() + 60_000).toISOString();
    const partialManifestBytes = Buffer.from(`${JSON.stringify(sourceManifest, null, 2)}\n`);
    const partialManifestSha = createHash('sha256').update(partialManifestBytes).digest('hex');
    await writeFile(join(manifestFolder, `${partialManifestSha}.json`), partialManifestBytes);
    const partialPreview = await previewChatStorageReconciliation(pool, chatRoot, {
      [String(ownerId)]: ownerId,
    });
    expect(partialPreview.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'partial_segment' })]),
    );
    await writeFile(join(chatRoot, ...partialRelativePath.split('/')), Buffer.from('tampered'));
    const checksumPreview = await previewChatStorageReconciliation(pool, chatRoot, {
      [String(ownerId)]: ownerId,
    });
    expect(checksumPreview.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'checksum_mismatch' })]),
    );

    const futureId = randomUUID();
    const futureFolder = join(chatRoot, 'conversations', futureId, 'backup-manifests');
    await mkdir(futureFolder, { recursive: true });
    const futureBytes = Buffer.from(
      `${JSON.stringify({ contract: 'noderag-chat-backup.v2', schemaVersion: 2 })}\n`,
    );
    const futureSha = createHash('sha256').update(futureBytes).digest('hex');
    await writeFile(join(futureFolder, `${futureSha}.json`), futureBytes);
    const futurePreview = await previewChatStorageReconciliation(pool, chatRoot, {
      [String(ownerId)]: ownerId,
    });
    expect(futurePreview.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'future_schema' })]),
    );
  });

  test('previews, queues, blocks conflicting sends, completes, and cancels manual compression', async () => {
    const chatId = await createManagedHistory('Manual context', 'manual-context-create', 3);
    const preview = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/context/compression-preview`,
      headers: headers('owner'),
    });
    expect(preview.json()).toMatchObject({
      mode: 'dry_run',
      completeTurns: 3,
      keepRecentTurns: 1,
      projectedProviderCalls: 2,
      scheduling: 'concurrent',
    });
    expect(preview.json().foldMessageIds).toHaveLength(4);
    const queued = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/context/compressions`,
      headers: headers('owner', 'manual-context-queue'),
      payload: { confirmation: 'COMPRESS CONTEXT' },
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/context/compressions`,
      headers: headers('owner', 'manual-context-queue'),
      payload: { confirmation: 'COMPRESS CONTEXT' },
    });
    expect(queued.statusCode).toBe(202);
    expect(replay.json()).toEqual(queued.json());
    const blockedSend = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner', 'manual-context-blocked-send'),
      payload: { content: 'Wait until compression finishes.' },
    });
    expect(blockedSend.json()).toMatchObject({
      status: 409,
      code: 'chat_context_compression_busy',
    });
    expect(
      await processOneManualContextCompression({
        pool,
        leaseOwner: 'manual-context-worker',
        resolveProvider: async (kind) => providerFor(kind),
      }),
    ).toBe(true);
    const status = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/context`,
      headers: headers('owner'),
    });
    expect(status.json()).toMatchObject({
      mode: 'managed',
      job: { id: queued.json().id, state: 'completed' },
      counts: { active_messages: '2', folded_messages: '4' },
    });
    expect(status.json().snapshot.id).toMatch(/^[a-f0-9-]{36}$/u);

    const cancelChatId = await createManagedHistory('Cancel context', 'cancel-context-create', 2);
    const cancelQueued = await app.inject({
      method: 'POST',
      url: `/v1/chats/${cancelChatId}/context/compressions`,
      headers: headers('owner', 'cancel-context-queue'),
      payload: { confirmation: 'COMPRESS CONTEXT' },
    });
    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/chats/${cancelChatId}/context/compressions/${String(cancelQueued.json().id)}/cancel`,
      headers: headers('owner', 'cancel-context-cancel'),
      payload: {},
    });
    expect(cancelled.json()).toMatchObject({ id: cancelQueued.json().id, state: 'cancelled' });
  });

  test('retains valid layers, rejects malformed state, times out, cancels, and reclaims a lease', async () => {
    const queue = async (chatId: string, key: string) => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/context/compressions`,
        headers: headers('owner', key),
        payload: { confirmation: 'COMPRESS CONTEXT' },
      });
      expect(response.statusCode).toBe(202);
      return String(response.json().id);
    };

    const retainedChat = await createManagedHistory('Retain prior layer', 'retain-create', 3);
    await queue(retainedChat, 'retain-first');
    await processOneManualContextCompression({
      pool,
      leaseOwner: 'retain-first-worker',
      resolveProvider: async (kind) => providerFor(kind),
    });
    const prior = await pool.query<{ id: string; l2_summary: string }>(
      `SELECT id,l2_summary FROM noderag.chat_context_snapshot
       WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [retainedChat],
    );
    for (let sequence = 6; sequence < 10; sequence += 1) {
      await pool.query(
        `INSERT INTO noderag.chat_message
           (id,conversation_id,sequence,role,content,state,completed_at)
         VALUES($1,$2,$3,$4,$5,'committed',now())`,
        [
          randomUUID(),
          retainedChat,
          sequence,
          sequence % 2 === 0 ? 'user' : 'assistant',
          `additional retained-layer message ${String(sequence)}`,
        ],
      );
    }
    const retainedJob = await queue(retainedChat, 'retain-second');
    const failedL2Provider = (kind: 'ollama_cloud' | 'openai_oauth'): ChatProvider => {
      const base = providerFor(kind);
      return {
        ...base,
        async *stream(request) {
          if (request.model !== 'compress-l2') {
            yield* base.stream(request);
            return;
          }
          yield {
            type: 'response.started',
            sequence: 0,
            occurredAt: new Date().toISOString(),
          } as const;
          yield {
            type: 'response.failed',
            sequence: 1,
            occurredAt: new Date().toISOString(),
            code: 'synthetic_l2_failure',
            retryable: false,
          } as const;
        },
      };
    };
    await processOneManualContextCompression({
      pool,
      leaseOwner: 'retain-second-worker',
      resolveProvider: async (kind) => failedL2Provider(kind),
    });
    const retained = await pool.query<{ id: string; l2_summary: string }>(
      `SELECT id,l2_summary FROM noderag.chat_context_snapshot
       WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [retainedChat],
    );
    expect(retained.rows[0]?.id).not.toBe(prior.rows[0]?.id);
    expect(retained.rows[0]?.l2_summary).toBe(prior.rows[0]?.l2_summary);
    const retainedEvent = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM noderag.chat_context_compression_event
       WHERE job_id=$1 AND event_type='compression.completed'`,
      [retainedJob],
    );
    expect(retainedEvent.rows[0]?.payload).toMatchObject({ retainedPriorLayers: ['l2'] });

    const malformedChat = await createManagedHistory('Malformed state', 'malformed-create', 2);
    const malformedJob = await queue(malformedChat, 'malformed-queue');
    const malformedProvider = (kind: 'ollama_cloud' | 'openai_oauth'): ChatProvider => {
      const base = providerFor(kind);
      return {
        ...base,
        async *stream(request) {
          if (request.model !== 'compress-l3') {
            yield* base.stream(request);
            return;
          }
          yield {
            type: 'response.started',
            sequence: 0,
            occurredAt: new Date().toISOString(),
          } as const;
          yield {
            type: 'response.output_text.delta',
            sequence: 1,
            occurredAt: new Date().toISOString(),
            text: '{not valid JSON',
          } as const;
          yield {
            type: 'response.completed',
            sequence: 2,
            occurredAt: new Date().toISOString(),
            finishReason: 'stop',
          } as const;
        },
      };
    };
    await processOneManualContextCompression({
      pool,
      leaseOwner: 'malformed-worker',
      resolveProvider: async (kind) => malformedProvider(kind),
    });
    const malformed = await pool.query<{ state: string; safe_error_code: string }>(
      `SELECT state,safe_error_code FROM noderag.chat_context_compression_job WHERE id=$1`,
      [malformedJob],
    );
    expect(malformed.rows[0]).toEqual({
      state: 'failed',
      safe_error_code: 'chat_context_l3_invalid',
    });
    const unfolded = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM noderag.chat_message
       WHERE conversation_id=$1 AND context_state='folded'`,
      [malformedChat],
    );
    expect(unfolded.rows[0]?.count).toBe('0');

    const stalledProvider = (
      kind: 'ollama_cloud' | 'openai_oauth',
      started?: () => void,
    ): ChatProvider => ({
      kind,
      contractVersion: CHAT_PROVIDER_CONTRACT_VERSION,
      async listModels() {
        return [];
      },
      async *stream(request) {
        yield* [];
        started?.();
        await new Promise<never>((_resolve, reject) => {
          const fail = () => reject(request.signal.reason);
          if (request.signal.aborted) fail();
          else request.signal.addEventListener('abort', fail, { once: true });
        });
      },
    });
    const timeoutChat = await createManagedHistory('Timeout context', 'timeout-create', 2);
    const timeoutJob = await queue(timeoutChat, 'timeout-queue');
    await pool.query(
      `UPDATE noderag.chat_context_compression_job SET maximum_attempts=1 WHERE id=$1`,
      [timeoutJob],
    );
    await processOneManualContextCompression({
      pool,
      leaseOwner: 'timeout-worker',
      resolveProvider: async (kind) => stalledProvider(kind),
      timeoutMilliseconds: 50,
    });
    const timedOut = await pool.query<{ state: string; safe_error_code: string }>(
      `SELECT state,safe_error_code FROM noderag.chat_context_compression_job WHERE id=$1`,
      [timeoutJob],
    );
    expect(timedOut.rows[0]).toEqual({
      state: 'failed',
      safe_error_code: 'chat_context_compression_timeout',
    });

    const cancelledChat = await createManagedHistory('Running cancel', 'running-cancel-create', 2);
    const cancelledJob = await queue(cancelledChat, 'running-cancel-queue');
    const controller = new AbortController();
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const cancelling = processOneManualContextCompression({
      pool,
      leaseOwner: 'running-cancel-worker',
      resolveProvider: async (kind) => stalledProvider(kind, announceStarted),
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error('chat_context_compression_cancelled'));
    await cancelling;
    const cancelled = await pool.query<{ state: string; safe_error_code: string }>(
      `SELECT state,safe_error_code FROM noderag.chat_context_compression_job WHERE id=$1`,
      [cancelledJob],
    );
    expect(cancelled.rows[0]).toEqual({
      state: 'cancelled',
      safe_error_code: 'chat_context_compression_cancelled',
    });

    const recoveredChat = await createManagedHistory('Recovered context', 'recovered-create', 2);
    const recoveredJob = await queue(recoveredChat, 'recovered-queue');
    await pool.query(
      `UPDATE noderag.chat_context_compression_job
       SET state='running',lease_owner='stopped-worker',lease_epoch=1,attempts=1,
           leased_until=now()-interval '1 second',heartbeat_at=now()-interval '1 minute'
       WHERE id=$1`,
      [recoveredJob],
    );
    await processOneManualContextCompression({
      pool,
      leaseOwner: 'replacement-worker',
      resolveProvider: async (kind) => providerFor(kind),
    });
    const recovered = await pool.query<{ state: string; attempts: number; recovered: string }>(
      `SELECT job.state,job.attempts,
              count(event.*) FILTER (WHERE event.event_type='compression.recovered')::text AS recovered
       FROM noderag.chat_context_compression_job AS job
       LEFT JOIN noderag.chat_context_compression_event AS event ON event.job_id=job.id
       WHERE job.id=$1 GROUP BY job.id`,
      [recoveredJob],
    );
    expect(recovered.rows[0]).toEqual({ state: 'completed', attempts: 2, recovered: '1' });
  });
});
