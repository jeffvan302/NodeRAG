import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Embedder } from '@noderag/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeterministicRuntime } from '../../embedder/src/runtime.js';
import type { RequestAuthenticator } from '../src/api/authentication.js';
import { registerChatRoutes } from '../src/api/chat-routes.js';
import {
  CHAT_PROVIDER_CONTRACT_VERSION,
  type ChatProvider,
  type ChatProviderRequest,
  type ChatToolExecutionResult,
} from '../src/chat/contract.js';
import { processOneChatRun } from '../src/chat/runner.js';
import { acceptDocumentUpload } from '../src/ingest/upload.js';
import { drainDocumentJobs } from '../src/ingest/pipeline.js';
import { probeChatStorage } from '../src/chat/storage.js';
import { SiloScope } from '../src/identity/scope.js';
import { executeSearch } from '../src/search/retrieval.js';
import { bootstrapFirstAdministrator, issueSetupToken } from '../src/setup/bootstrap.js';
import { DocumentFileStore } from '../src/storage/document-files.js';
import { runMigrations } from '../src/store/migrations.js';
import { createSilo, setSiloCapability } from '../src/store/silos.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;
let disabledApp: FastifyInstance;
let files: DocumentFileStore;
let storageParent: string;
let administratorId: number;
let ownerId: number;
let otherId: number;
let firstSiloId: number;
let secondSiloId: number;
let firstDocumentId: number;
let chatId: string;
let citationId: string;
let originalMarkdownDigest: Buffer;
let behavior: 'normal' | 'modes' | 'revocation' | 'empty' = 'normal';
const capturedRequests: ChatProviderRequest[] = [];
const observedToolResults: ChatToolExecutionResult[] = [];
const embeddingRuntime = createDeterministicRuntime();
const embedder: Embedder = {
  countTokens: (texts, priority, model) => embeddingRuntime.countTokens(texts, priority, model),
  embed: (texts, maximumTokens, priority, model) =>
    embeddingRuntime.embed(texts, maximumTokens, priority, model),
};

const authenticate: RequestAuthenticator = async (request) => {
  const identity = request.headers['x-test-user'];
  if (identity !== 'owner' && identity !== 'other' && identity !== 'search-only') return null;
  return {
    principalId: identity === 'other' ? otherId : ownerId,
    serverAdmin: false,
    searchOnly: identity === 'search-only',
    sessionToken: `session-${identity}`,
    csrfAllowed: (candidate) => candidate === 'chat-csrf',
  };
};

const headers = (identity: 'owner' | 'other' | 'search-only', key?: string) => ({
  'x-test-user': identity,
  'x-csrf-token': 'chat-csrf',
  origin: 'http://127.0.0.1:8787',
  ...(key === undefined ? {} : { 'idempotency-key': key }),
});

const configureChat = async (): Promise<void> => {
  const provider = await pool.query<{ id: number }>(
    `UPDATE noderag.chat_provider_connection
     SET enabled=true,generation_model='minimax-m3:cloud'
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
  const current = await pool.query<{ context_revision_id: number }>(
    `SELECT context_revision_id FROM noderag.chat_configuration_current WHERE singleton=true`,
  );
  const storage = await probeChatStorage(storageParent, { policy: 'testbed' });
  const settings = await pool.query<{ id: number }>(
    `INSERT INTO noderag.chat_settings_revision
       (revision_id,context_revision_id,default_connection_id,default_model,
        default_reasoning_effort,default_context_mode,default_allow_research,
        default_allow_rag,default_allow_internet,markdown_only,run_timeout_ms,
        maximum_tool_calls,maximum_parallel_runs_per_user,daily_run_quota,
        daily_input_token_quota,daily_output_token_quota,retention_days,archive_after_days,
        storage_requested_path,storage_resolved_path,storage_manifest_id,created_by)
     VALUES($1,$2,$3,'minimax-m3:cloud','default','rolling',false,true,false,true,
       120000,8,2,100,1000000,250000,365,30,$4,$5,$6,$7) RETURNING id`,
    [
      randomUUID(),
      current.rows[0]?.context_revision_id,
      providerId,
      storageParent,
      storage.chatRoot,
      storage.manifest.manifestId,
      administratorId,
    ],
  );
  await pool.query(
    `UPDATE noderag.chat_configuration_current SET settings_revision_id=$1,updated_at=now()`,
    [settings.rows[0]?.id],
  );
};

const ingestMarkdown = async (siloId: number, filename: string, markdown: string) => {
  const staged = await files.stageUpload(Readable.from([markdown]), 2 * 1024 * 1024, 0);
  const accepted = await acceptDocumentUpload(pool, files, {
    siloId,
    principalId: administratorId,
    filename,
    mimeType: 'text/markdown',
    staged,
  });
  return accepted.documentId;
};

const decodeToolData = (result: ChatToolExecutionResult) =>
  (JSON.parse(result.content) as { data: Record<string, unknown> }).data;

const ragProvider = (): ChatProvider => ({
  kind: 'ollama_cloud',
  contractVersion: CHAT_PROVIDER_CONTRACT_VERSION,
  async listModels() {
    return [];
  },
  async *stream(request) {
    capturedRequests.push(request);
    const occurredAt = new Date().toISOString();
    yield { type: 'response.started', sequence: 0, occurredAt } as const;
    const searchCall = {
      callId: `${behavior}-search`,
      name: 'rag.search.v1',
      arguments: {
        query: 'ZX-991',
        mode: 'keyword',
        minimumConfidence: 0.05,
        siloIds: [firstSiloId, secondSiloId],
        limit: 8,
      },
    } as const;
    yield { type: 'response.tool_call', sequence: 1, occurredAt, ...searchCall } as const;
    const searchResult = await request.executeTool?.(searchCall);
    if (searchResult === undefined) throw new Error('missing-rag-tool-executor');
    observedToolResults.push(searchResult);

    if (behavior === 'modes') {
      const additional = [
        {
          callId: 'modes-semantic',
          arguments: {
            query: 'legal register preserves admissible notice evidence',
            mode: 'semantic',
            minimumConfidence: 0.05,
            siloIds: [firstSiloId, secondSiloId],
            limit: 8,
          },
        },
        {
          callId: 'modes-hybrid',
          arguments: {
            query: 'termination notice',
            mode: 'hybrid',
            minimumConfidence: 0.05,
            siloIds: [firstSiloId, secondSiloId],
            limit: 8,
          },
        },
        {
          callId: 'modes-vector',
          arguments: {
            query: 'thirty day notice requirement',
            mode: 'vector',
            minimumConfidence: 0.05,
            siloIds: [firstSiloId, secondSiloId],
            limit: 8,
          },
        },
      ] as const;
      for (const [index, call] of additional.entries()) {
        const toolCall = { name: 'rag.search.v1', ...call } as const;
        yield {
          type: 'response.tool_call',
          sequence: index + 2,
          occurredAt,
          ...toolCall,
        } as const;
        const result = await request.executeTool?.(toolCall);
        if (result === undefined) throw new Error('missing-mode-search-result');
        observedToolResults.push(result);
      }
      yield {
        type: 'response.output_text.delta',
        sequence: 5,
        occurredAt,
        text: 'All four local retrieval modes returned permission-scoped evidence.',
      } as const;
      yield { type: 'response.completed', sequence: 6, occurredAt, finishReason: 'stop' } as const;
      return;
    }

    if (behavior === 'normal') {
      const firstItem = (decodeToolData(searchResult)['items'] as Array<{ citationId: string }>)[0];
      if (firstItem === undefined) throw new Error('expected-rag-search-result');
      citationId = firstItem.citationId;
      const readCall = {
        callId: 'normal-read',
        name: 'document.read_markdown.v1',
        arguments: { citationId, offset: 0 },
      } as const;
      yield { type: 'response.tool_call', sequence: 2, occurredAt, ...readCall } as const;
      const readResult = await request.executeTool?.(readCall);
      if (readResult === undefined) throw new Error('missing-document-tool-executor');
      observedToolResults.push(readResult);
      yield {
        type: 'response.tool_call',
        sequence: 3,
        occurredAt,
        ...{ ...searchCall, callId: 'normal-duplicate-search' },
      } as const;
      const duplicate = await request.executeTool?.({
        ...searchCall,
        callId: 'normal-duplicate-search',
      });
      if (duplicate === undefined) throw new Error('missing-duplicate-result');
      observedToolResults.push(duplicate);
      yield {
        type: 'response.output_text.delta',
        sequence: 4,
        occurredAt,
        text: 'The authorized source gives a thirty-day notice period [S1].',
      } as const;
      yield { type: 'response.completed', sequence: 5, occurredAt, finishReason: 'stop' } as const;
      return;
    }

    if (behavior === 'revocation') {
      const firstItem = (decodeToolData(searchResult)['items'] as Array<{ citationId: string }>)[0];
      if (firstItem === undefined) throw new Error('expected-revocation-search-result');
      await pool.query(
        `DELETE FROM noderag.silo_grant
         WHERE principal_id=$1 AND silo_id=$2 AND capability='read'`,
        [ownerId, firstSiloId],
      );
      const readCall = {
        callId: 'revocation-read',
        name: 'document.read_markdown.v1',
        arguments: { citationId: firstItem.citationId, offset: 0 },
      } as const;
      yield { type: 'response.tool_call', sequence: 2, occurredAt, ...readCall } as const;
      const readResult = await request.executeTool?.(readCall);
      if (readResult === undefined) throw new Error('missing-revocation-result');
      observedToolResults.push(readResult);
      yield {
        type: 'response.output_text.delta',
        sequence: 3,
        occurredAt,
        text: 'Access changed while the source was being read.',
      } as const;
      yield { type: 'response.completed', sequence: 4, occurredAt, finishReason: 'stop' } as const;
      return;
    }

    yield {
      type: 'response.output_text.delta',
      sequence: 2,
      occurredAt,
      text: 'No authorized local source was available.',
    } as const;
    yield { type: 'response.completed', sequence: 3, occurredAt, finishReason: 'stop' } as const;
  },
});

const sendAndProcess = async (idempotencyKey: string, content: string) => {
  const sent = await app.inject({
    method: 'POST',
    url: `/v1/chats/${chatId}/messages`,
    headers: headers('owner', idempotencyKey),
    payload: { content },
  });
  expect(sent.statusCode, sent.body).toBe(202);
  expect(
    await processOneChatRun({
      pool,
      leaseOwner: `c06-${idempotencyKey}`,
      ragEnabled: true,
      embedder,
      files,
      resolveProvider: async () => ragProvider(),
    }),
  ).toBe(true);
  return sent.json<{ runId: string; responseMessageId: string }>();
};

beforeAll(async () => {
  container = await new PostgreSqlContainer(postgresImage)
    .withDatabase('noderag_chat_rag')
    .withUsername('noderag')
    .withPassword('synthetic-chat-rag-password')
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
    username: 'c06-admin',
    password: 'C06-admin-password!',
  });
  administratorId = setup.principalId;
  firstSiloId = setup.defaultSilo.id;
  secondSiloId = (
    await createSilo(pool, {
      slug: 'private-space',
      displayName: 'Private Space',
      creatingPrincipalId: administratorId,
    })
  ).id;
  const principals = await pool.query<{ id: number; label: string }>(
    `INSERT INTO noderag.principal(kind,label) VALUES('user','rag-owner'),('user','rag-other')
     RETURNING id,label`,
  );
  ownerId = Number(principals.rows.find(({ label }) => label === 'rag-owner')?.id);
  otherId = Number(principals.rows.find(({ label }) => label === 'rag-other')?.id);
  await pool.query(
    `INSERT INTO noderag.chat_entitlement(principal_id,enabled) VALUES($1,true),($2,true)`,
    [ownerId, otherId],
  );
  await setSiloCapability(pool, administratorId, ownerId, firstSiloId, 'read', true);

  storageParent = await mkdtemp(join(tmpdir(), 'noderag-chat-rag-'));
  files = new DocumentFileStore(storageParent);
  await files.initialize();
  firstDocumentId = await ingestMarkdown(
    firstSiloId,
    'legal-register.md',
    `# Legal register\n\nZX-991 requires a thirty-day termination notice.\n\n${'The legal register preserves admissible notice evidence. '.repeat(600)}`,
  );
  await ingestMarkdown(
    secondSiloId,
    'private-register.md',
    `# Private register\n\nZX-991 private merger terms are confidential.\n\n${'This evidence must never cross the knowledge-space boundary. '.repeat(80)}`,
  );
  expect(await drainDocumentJobs({ pool, files, embedder, leaseOwner: 'c06-ingest' })).toBe(4);
  const digest = await pool.query<{ markdown_sha256: Buffer }>(
    `SELECT markdown_sha256 FROM noderag.document WHERE id=$1`,
    [firstDocumentId],
  );
  originalMarkdownDigest = digest.rows[0]?.markdown_sha256 ?? Buffer.alloc(0);
  await configureChat();

  app = Fastify({ logger: false });
  registerChatRoutes(app, {
    pool,
    authenticate,
    enabled: true,
    researchEnabled: false,
    ragEnabled: true,
    files,
  });
  await app.ready();
  disabledApp = Fastify({ logger: false });
  registerChatRoutes(disabledApp, {
    pool,
    authenticate,
    enabled: true,
    researchEnabled: false,
    ragEnabled: false,
    files,
  });
  await disabledApp.ready();

  const created = await app.inject({
    method: 'POST',
    url: '/v1/chats',
    headers: headers('owner', 'c06-create-chat'),
    payload: { name: 'Permission-aware RAG', allowRag: true },
  });
  expect(created.statusCode, created.body).toBe(201);
  chatId = String(created.json().id);
});

afterAll(async () => {
  await disabledApp.close();
  await app.close();
  await pool.end();
  await container.stop();
  await rm(storageParent, { recursive: true, force: true });
});

describe.sequential('C06 permission-aware RAG tools', () => {
  it('is opt-in, exposes only local RAG tools, and keeps all internet tools absent', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/chats', headers: headers('owner') });
    expect(list.json()).toMatchObject({
      internetProvider: 'ollama_cloud',
      researchEnabled: false,
      ragEnabled: true,
    });
    const disabled = await disabledApp.inject({
      method: 'POST',
      url: '/v1/chats',
      headers: headers('owner', 'c06-disabled-create'),
      payload: { name: 'RAG unavailable', allowRag: true },
    });
    expect(disabled.json()).toMatchObject({ status: 422, code: 'chat_rag_not_available' });
    const searchOnly = await app.inject({
      method: 'GET',
      url: '/v1/chats',
      headers: headers('search-only'),
    });
    expect(searchOnly.json()).toMatchObject({ status: 404, code: 'not_found' });

    behavior = 'normal';
    observedToolResults.length = 0;
    const sent = await sendAndProcess('c06-normal-run', 'Find the ZX-991 notice period.');
    expect(capturedRequests.at(-1)?.tools.map(({ name }) => name)).toEqual([
      'rag.search.v1',
      'document.read_markdown.v1',
    ]);
    expect(capturedRequests.at(-1)?.tools.some(({ name }) => name.startsWith('web.'))).toBe(false);
    expect(capturedRequests.at(-1)?.tools.some(({ name }) => name.startsWith('research.'))).toBe(
      false,
    );
    expect(observedToolResults).toHaveLength(3);
    expect(observedToolResults[0]).toMatchObject({ isError: false });
    expect(
      decodeToolData(observedToolResults[0] ?? { content: '{}', isError: true }),
    ).toMatchObject({
      mode: 'keyword',
      items: [
        expect.objectContaining({
          citationLabel: 'S1',
          siloId: firstSiloId,
          documentId: firstDocumentId,
          modelManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ],
    });
    expect(observedToolResults[0]?.content).not.toContain('private merger terms');
    expect(observedToolResults[1]?.content).toContain('thirty-day termination notice');
    expect(
      decodeToolData(observedToolResults[1] ?? { content: '{}', isError: true }),
    ).toMatchObject({
      offset: 0,
      nextOffset: 24_000,
      untrusted: true,
    });
    expect(
      String(
        decodeToolData(observedToolResults[1] ?? { content: '{}', isError: true })['content'] ?? '',
      ).length,
    ).toBe(24_000);
    expect(observedToolResults[2]).toMatchObject({
      isError: true,
      content: expect.stringContaining('chat_rag_query_duplicate'),
    });

    const toolCalls = await pool.query<{
      status: string;
      tool_name: string;
      request_sha256: Buffer;
      result_sha256: Buffer;
      duration_ms: number;
      result_count: number;
      result_summary: Record<string, unknown>;
    }>(
      `SELECT status,tool_name,request_sha256,result_sha256,duration_ms,result_count,result_summary
       FROM noderag.chat_tool_call WHERE run_id=$1 ORDER BY ordinal`,
      [sent.runId],
    );
    expect(toolCalls.rows).toHaveLength(2);
    expect(toolCalls.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'completed',
          tool_name: 'rag.search.v1',
          request_sha256: expect.any(Buffer),
          result_sha256: expect.any(Buffer),
          result_count: 1,
          result_summary: expect.objectContaining({ kind: 'rag_search', resultCount: 1 }),
        }),
        expect.objectContaining({
          status: 'completed',
          tool_name: 'document.read_markdown.v1',
          result_count: 1,
        }),
      ]),
    );
    expect(toolCalls.rows.every(({ duration_ms }) => duration_ms >= 0)).toBe(true);
    const revision = await pool.query<{ allow_rag: boolean; allow_internet: boolean }>(
      `SELECT allow_rag,allow_internet FROM noderag.chat_conversation_configuration_revision
       WHERE id=(SELECT configuration_revision_id FROM noderag.chat_conversation WHERE id=$1)`,
      [chatId],
    );
    expect(revision.rows[0]).toEqual({ allow_rag: true, allow_internet: false });
  });

  it('returns stable citations and exact page, document, and original viewers', async () => {
    const messages = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner'),
    });
    const answer = messages.json().items.at(-1);
    expect(answer).toMatchObject({
      role: 'assistant',
      state: 'committed',
      citations: [
        expect.objectContaining({
          sourceKind: 'rag',
          id: citationId,
          citationLabel: 'S1',
          status: 'active',
          buildId: expect.any(Number),
          modelManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ],
    });
    const page = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/citations/${citationId}/page`,
      headers: headers('owner'),
    });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json()).toMatchObject({ pageOrdinal: 0, pageNumber: 1, untrusted: true });
    expect(page.json().markdown).toContain('ZX-991');
    const document = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/citations/${citationId}/document?offset=3`,
      headers: headers('owner'),
    });
    expect(document.json()).toMatchObject({ offset: 3, untrusted: true });
    expect(document.json().content).toContain('ZX-991');
    const original = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/citations/${citationId}/original`,
      headers: headers('owner'),
    });
    expect(original.statusCode, original.body).toBe(200);
    expect(original.body).toContain('thirty-day termination notice');
    const isolated = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/citations/${citationId}/page`,
      headers: headers('other'),
    });
    expect(isolated.json()).toMatchObject({ status: 404, code: 'chat_not_found' });
  });

  it('preserves ordinary Search confidence and locators across all retrieval modes', async () => {
    behavior = 'modes';
    observedToolResults.length = 0;
    await sendAndProcess('c06-mode-parity', 'Compare every local retrieval mode.');
    expect(observedToolResults).toHaveLength(4);
    const requests = [
      { query: 'ZX-991', mode: 'keyword' as const },
      {
        query: 'legal register preserves admissible notice evidence',
        mode: 'semantic' as const,
      },
      { query: 'termination notice', mode: 'hybrid' as const },
      { query: 'thirty day notice requirement', mode: 'vector' as const },
    ];
    const scope = await SiloScope.resolve(pool, ownerId, 'search', {
      requestedSiloIds: [firstSiloId, secondSiloId],
    });
    expect(scope.siloIds).toEqual([firstSiloId]);
    for (const [index, request] of requests.entries()) {
      const ordinary = await executeSearch({
        pool,
        embedder,
        files,
        principalId: ownerId,
        scope,
        requestId: `c06-parity-${request.mode}`,
        request: {
          query: request.query,
          mode: request.mode,
          limit: 8,
          filters: { minimumConfidence: 0.05 },
        },
      });
      expect(observedToolResults[index], JSON.stringify(observedToolResults)).toMatchObject({
        isError: false,
      });
      const tool = decodeToolData(observedToolResults[index] ?? { content: '{}', isError: true });
      const toolItem = (tool['items'] as Array<Record<string, unknown>>)[0];
      expect(toolItem).toBeDefined();
      expect(toolItem).toMatchObject({
        siloId: firstSiloId,
        documentId: ordinary.items[0]?.documentId,
        confidence: ordinary.items[0]?.confidence,
        locator: ordinary.items[0]?.locator,
      });
      expect((tool['items'] as unknown[]).length).toBeLessThanOrEqual(8);
      expect(String(toolItem?.['text'] ?? '').length).toBeLessThanOrEqual(12_000);
      expect(JSON.stringify(tool)).not.toContain('private merger terms');
    }
    expect(
      observedToolResults
        .map(decodeToolData)
        .flatMap((result) => result['items'] as Array<Record<string, unknown>>)
        .some(({ passageTruncated }) => passageTruncated === true),
    ).toBe(true);
  });

  it('rechecks permissions during a run and returns no results with zero current grants', async () => {
    behavior = 'revocation';
    observedToolResults.length = 0;
    const revokedRun = await sendAndProcess('c06-revocation-run', 'Read the source again.');
    expect(observedToolResults).toHaveLength(2);
    expect(observedToolResults[1]).toMatchObject({
      isError: true,
      content: expect.stringContaining('chat_rag_access_revoked'),
    });
    const persisted = await pool.query<{ status: string; safe_error_code: string | null }>(
      `SELECT status,safe_error_code FROM noderag.chat_tool_call
       WHERE run_id=$1 ORDER BY ordinal`,
      [revokedRun.runId],
    );
    expect(persisted.rows).toMatchObject([
      { status: 'completed', safe_error_code: null },
      { status: 'failed', safe_error_code: 'chat_rag_access_revoked' },
    ]);

    behavior = 'empty';
    observedToolResults.length = 0;
    await sendAndProcess('c06-zero-grant-run', 'Search without a current grant.');
    expect(
      decodeToolData(observedToolResults[0] ?? { content: '{}', isError: true }),
    ).toMatchObject({
      items: [],
    });
    await setSiloCapability(pool, administratorId, ownerId, firstSiloId, 'read', true);
  });

  it('marks citations stale when the source identity changes and never substitutes content', async () => {
    await pool.query(`UPDATE noderag.document SET markdown_sha256=$2 WHERE id=$1`, [
      firstDocumentId,
      createHash('sha256').update('changed source').digest(),
    ]);
    const messages = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner'),
    });
    const cited = (
      messages.json().items as Array<{ citations: Array<Record<string, unknown>> }>
    ).find(({ citations }) => citations.some(({ id }) => id === citationId));
    expect(cited?.citations.find(({ id }) => id === citationId)).toMatchObject({
      status: 'source_stale',
      text: null,
    });
    const stale = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/citations/${citationId}/document`,
      headers: headers('owner'),
    });
    expect(stale.json()).toMatchObject({ status: 409, code: 'chat_rag_source_stale' });
    await pool.query(`UPDATE noderag.document SET markdown_sha256=$2 WHERE id=$1`, [
      firstDocumentId,
      originalMarkdownDigest,
    ]);
  });
});
