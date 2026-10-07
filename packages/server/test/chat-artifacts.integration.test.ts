import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import multipartPlugin from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerChatArtifactRoutes } from '../src/api/chat-artifact-routes.js';
import { registerChatFileRoutes } from '../src/api/chat-file-routes.js';
import type { RequestAuthenticator } from '../src/api/authentication.js';
import { registerChatRoutes } from '../src/api/chat-routes.js';
import { ChatArtifactService, createChatArtifactExecutor } from '../src/chat/artifacts.js';
import {
  CHAT_PROVIDER_CONTRACT_VERSION,
  type ChatProvider,
  type ChatProviderRequest,
} from '../src/chat/contract.js';
import { processOneChatRun } from '../src/chat/runner.js';
import { probeChatStorage } from '../src/chat/storage.js';
import { runMigrations } from '../src/store/migrations.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;
let disabledApp: FastifyInstance;
let storageParent: string;
let chatRoot: string;
let outsideRoot: string;
let ownerId: number;
let otherId: number;
let chatId: string;
const providerRequests: ChatProviderRequest[] = [];

const authenticate: RequestAuthenticator = async (request) => {
  const identity = request.headers['x-test-user'];
  if (identity !== 'owner' && identity !== 'other' && identity !== 'search') return null;
  return {
    principalId: identity === 'other' ? otherId : ownerId,
    serverAdmin: false,
    searchOnly: identity === 'search',
    sessionToken: `session-${identity}`,
    csrfAllowed: (candidate) => candidate === 'chat-csrf',
  };
};

const headers = (identity: 'owner' | 'other' | 'search', key?: string) => ({
  'x-test-user': identity,
  'x-csrf-token': 'chat-csrf',
  origin: 'http://127.0.0.1:8787',
  ...(key === undefined ? {} : { 'idempotency-key': key }),
});

const multipart = (filename: string, mimeType: string, body: Buffer) => {
  const boundary = `noderag-${randomUUID()}`;
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

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const provider: ChatProvider = {
  kind: 'ollama_cloud',
  contractVersion: CHAT_PROVIDER_CONTRACT_VERSION,
  async listModels() {
    return [];
  },
  async *stream(request) {
    providerRequests.push(request);
    const occurredAt = new Date().toISOString();
    yield { type: 'response.started', sequence: 0, occurredAt } as const;
    const call = {
      callId: 'create-model-report',
      name: 'files.create.v1',
      arguments: {
        path: 'model-report.md',
        content: '# Model report\n\nCreated without shell access.\n',
        sourceCitations: [],
      },
    } as const;
    yield { type: 'response.tool_call', sequence: 1, occurredAt, ...call } as const;
    const result = await request.executeTool?.(call);
    if (result === undefined || result.isError) throw new Error('artifact-tool-failed');
    yield {
      type: 'response.output_text.delta',
      sequence: 2,
      occurredAt,
      text: 'I created model-report.md.',
    } as const;
    yield { type: 'response.completed', sequence: 3, occurredAt, finishReason: 'stop' } as const;
  },
};

beforeAll(async () => {
  container = await new PostgreSqlContainer(postgresImage).start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations({ connectionString: container.getConnectionUri() });
  const principals = await pool.query<{ id: number; label: string }>(
    `INSERT INTO noderag.principal (kind,label)
     VALUES ('user','artifact-owner'),('user','artifact-other') RETURNING id,label`,
  );
  ownerId = Number(principals.rows.find(({ label }) => label === 'artifact-owner')?.id);
  otherId = Number(principals.rows.find(({ label }) => label === 'artifact-other')?.id);
  await pool.query(
    `INSERT INTO noderag.chat_entitlement(principal_id,enabled,updated_by)
     VALUES($1,true,$1),($2,true,$1)`,
    [ownerId, otherId],
  );
  const connection = await pool.query<{ id: number }>(
    `UPDATE noderag.chat_provider_connection
     SET enabled=true,generation_model='minimax-m3:cloud'
     WHERE provider_kind='ollama_cloud' RETURNING id`,
  );
  const connectionId = Number(connection.rows[0]?.id);
  await pool.query(
    `UPDATE noderag.chat_provider_capability SET status='healthy',tested_at=now()
     WHERE connection_id=$1 AND capability='generation'`,
    [connectionId],
  );
  await pool.query(
    `INSERT INTO noderag.chat_model_profile
       (connection_id,model,display_name,reasoning_efforts,provider_metadata,
        administrator_context_tokens,administrator_output_tokens)
     VALUES($1,'minimax-m3:cloud','MiniMax M3 Cloud',ARRAY['default'],'{}',128000,4096)`,
    [connectionId],
  );
  storageParent = await mkdtemp(join(tmpdir(), 'noderag-chat-artifacts-'));
  outsideRoot = await mkdtemp(join(tmpdir(), 'noderag-chat-artifacts-outside-'));
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
        storage_requested_path,storage_resolved_path,storage_manifest_id,
        artifact_max_file_bytes,artifact_chat_quota_bytes,created_by)
     VALUES($1,$2,$3,'minimax-m3:cloud','default','rolling',false,false,false,true,
       120000,8,2,100,1000000,250000,365,30,$4,$5,$6,1024,4096,$7)
     RETURNING id`,
    [
      randomUUID(),
      current.rows[0]?.context_revision_id,
      connectionId,
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
  await app.register(multipartPlugin, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: 100 * 1024 * 1024 },
  });
  registerChatRoutes(app, {
    pool,
    authenticate,
    enabled: true,
    artifactsEnabled: true,
  });
  registerChatArtifactRoutes(app, { pool, authenticate, enabled: true });
  registerChatFileRoutes(app, { pool, authenticate, enabled: true });
  await app.ready();
  disabledApp = Fastify({ logger: false });
  await disabledApp.register(multipartPlugin, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: 100 * 1024 * 1024 },
  });
  registerChatArtifactRoutes(disabledApp, { pool, authenticate, enabled: false });
  registerChatFileRoutes(disabledApp, { pool, authenticate, enabled: false });
  await disabledApp.ready();
  const created = await app.inject({
    method: 'POST',
    url: '/v1/chats',
    headers: headers('owner', 'artifact-create-chat'),
    payload: { name: 'Artifact workspace' },
  });
  expect(created.statusCode, created.body).toBe(201);
  chatId = String(created.json().id);
}, 120_000);

afterAll(async () => {
  if (disabledApp !== undefined) await disabledApp.close();
  if (app !== undefined) await app.close();
  if (pool !== undefined) await pool.end();
  if (container !== undefined) await container.stop();
  if (storageParent !== undefined) await rm(storageParent, { recursive: true, force: true });
  if (outsideRoot !== undefined) await rm(outsideRoot, { recursive: true, force: true });
});

describe.sequential('C08 contained Chat artifact workspace', () => {
  it('keeps the feature hidden from search-only, other-owner, and disabled clients', async () => {
    const disabled = await disabledApp.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/artifacts`,
      headers: headers('owner'),
    });
    expect(disabled.statusCode).toBe(404);
    const search = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/artifacts`,
      headers: headers('search'),
    });
    expect(search.statusCode).toBe(404);
    const other = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/artifacts`,
      headers: headers('other'),
    });
    expect(other.json()).toMatchObject({ status: 404, code: 'chat_artifact_not_found' });
  });

  it('creates folders and immutable revisions, then enforces optimistic patches', async () => {
    const folder = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts/directories`,
      headers: headers('owner', 'artifact-mkdir-notes'),
      payload: { path: 'Notes' },
    });
    expect(folder.statusCode, folder.body).toBe(201);
    const created = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts`,
      headers: headers('owner', 'artifact-create-report'),
      payload: { path: 'Notes/report.md', content: '# Report\n\nOriginal revenue note.\n' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const artifact = created.json().artifact;
    expect(artifact).toMatchObject({ path: 'Notes/report.md', revision: 1 });
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts`,
      headers: headers('owner', 'artifact-create-report'),
      payload: { path: 'Notes/report.md', content: '# Report\n\nOriginal revenue note.\n' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(created.json());

    const collision = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts`,
      headers: headers('owner', 'artifact-case-collision'),
      payload: { path: 'notes/REPORT.md', content: 'collision' },
    });
    expect(collision.json()).toMatchObject({ status: 409, code: 'chat_artifact_path_conflict' });
    const traversal = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts`,
      headers: headers('owner', 'artifact-traversal'),
      payload: { path: '../outside.md', content: 'escape' },
    });
    expect(traversal.json()).toMatchObject({ status: 400, code: 'chat_artifact_path_invalid' });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/chats/${chatId}/artifacts/${String(artifact.id)}/content`,
      headers: headers('owner', 'artifact-stale-patch'),
      payload: {
        expectedSha256: '0'.repeat(64),
        patches: [
          {
            startLine: 3,
            deleteCount: 1,
            expectedLines: ['Original revenue note.'],
            replacementLines: ['Updated.'],
          },
        ],
      },
    });
    expect(stale.json()).toMatchObject({ status: 409, code: 'chat_artifact_patch_conflict' });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/chats/${chatId}/artifacts/${String(artifact.id)}/content`,
      headers: headers('owner', 'artifact-valid-patch'),
      payload: {
        expectedSha256: artifact.sha256,
        patches: [
          {
            startLine: 3,
            deleteCount: 1,
            expectedLines: ['Original revenue note.'],
            replacementLines: ['Updated revenue note.'],
          },
        ],
      },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().artifact.revision).toBe(2);
    const content = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/artifacts/${String(artifact.id)}/content`,
      headers: headers('owner'),
    });
    expect(content.json()).toMatchObject({ content: '# Report\n\nUpdated revenue note.\n' });
    const history = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/artifacts/${String(artifact.id)}/history`,
      headers: headers('owner'),
    });
    expect(history.json().items.map(({ revision }: { revision: number }) => revision)).toEqual([
      2, 1,
    ]);
    await expect(
      pool.query(`UPDATE noderag.chat_artifact_revision SET revision=7 WHERE artifact_id=$1`, [
        artifact.id,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('renames, copies, downloads, confirms deletion, and reports quota use', async () => {
    const listing = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/artifacts?directory=Notes`,
      headers: headers('owner'),
    });
    const artifact = listing.json().items[0];
    const renamed = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts/${String(artifact.id)}/rename`,
      headers: headers('owner', 'artifact-rename-report'),
      payload: { destination: 'Notes/Revenue Report.md' },
    });
    expect(renamed.json()).toMatchObject({ path: 'Notes/Revenue Report.md' });
    const copied = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts/${String(artifact.id)}/copy`,
      headers: headers('owner', 'artifact-copy-report'),
      payload: { destination: 'Notes/Revenue Copy.md' },
    });
    expect(copied.statusCode, copied.body).toBe(201);
    const copy = copied.json().artifact;
    const downloaded = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/artifacts/${String(copy.id)}/download`,
      headers: headers('owner'),
    });
    expect(downloaded.headers['content-type']).toContain('text/markdown');
    expect(downloaded.body).toContain('Updated revenue note.');
    const listAfterCopy = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/artifacts?directory=Notes`,
      headers: headers('owner'),
    });
    expect(listAfterCopy.json().quota).toMatchObject({ quotaBytes: 4096, fileCount: 2 });
    const unconfirmed = await app.inject({
      method: 'DELETE',
      url: `/v1/chats/${chatId}/artifacts/${String(copy.id)}`,
      headers: headers('owner', 'artifact-delete-no-confirm'),
      payload: { confirmation: 'NO' },
    });
    expect(unconfirmed.json()).toMatchObject({
      status: 400,
      code: 'chat_artifact_delete_confirmation_required',
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/chats/${chatId}/artifacts/${String(copy.id)}`,
      headers: headers('owner', 'artifact-delete-confirmed'),
      payload: { confirmation: 'DELETE' },
    });
    expect(removed.json()).toMatchObject({ deleted: true, affected: 1 });
  });

  it('stores duplicate image names under private ID-based website URLs', async () => {
    const upload = async (key: string) => {
      const body = multipart('diagram.png', 'image/png', onePixelPng);
      return app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/files`,
        headers: { ...headers('owner', key), 'content-type': body.contentType },
        payload: body.payload,
      });
    };
    const firstResponse = await upload('chat-file-upload-first');
    const secondResponse = await upload('chat-file-upload-second');
    expect(firstResponse.statusCode, firstResponse.body).toBe(201);
    expect(secondResponse.statusCode, secondResponse.body).toBe(201);
    const first = firstResponse.json();
    const second = secondResponse.json();
    expect(first.originalFilename).toBe('diagram.png');
    expect(second.originalFilename).toBe('diagram.png');
    expect(first.id).not.toBe(second.id);
    expect(first.websitePath).toBe(`/chat/${chatId}/file/${String(first.id)}.png`);
    expect(second.websitePath).toBe(`/chat/${chatId}/file/${String(second.id)}.png`);

    const listing = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/files`,
      headers: headers('owner'),
    });
    expect(listing.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, originalFilename: 'diagram.png' }),
        expect.objectContaining({ id: second.id, originalFilename: 'diagram.png' }),
      ]),
    );
    const content = await app.inject({
      method: 'GET',
      url: first.websitePath,
      headers: headers('owner'),
    });
    expect(content.statusCode, content.body).toBe(200);
    expect(content.headers['content-type']).toContain('image/png');
    expect(content.headers['cache-control']).toBe('private, no-cache');
    expect(content.rawPayload).toEqual(onePixelPng);
    const conditional = await app.inject({
      method: 'GET',
      url: first.websitePath,
      headers: { ...headers('owner'), 'if-none-match': String(content.headers.etag) },
    });
    expect(conditional.statusCode).toBe(304);

    for (const [target, identity] of [
      [first.websitePath, 'other'],
      [first.websitePath, 'search'],
    ] as const) {
      const hidden = await app.inject({ method: 'GET', url: target, headers: headers(identity) });
      expect(hidden.statusCode).toBe(404);
    }
    const disabled = await disabledApp.inject({
      method: 'GET',
      url: first.websitePath,
      headers: headers('owner'),
    });
    expect(disabled.statusCode).toBe(404);
    const wrongExtension = await app.inject({
      method: 'GET',
      url: String(first.websitePath).replace(/\.png$/u, '.jpg'),
      headers: headers('owner'),
    });
    expect(wrongExtension.statusCode).toBe(404);

    const quota = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/artifacts`,
      headers: headers('owner'),
    });
    expect(Number(quota.json().quota.usedBytes)).toBeGreaterThanOrEqual(onePixelPng.byteLength * 2);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/chats/${chatId}/files/${String(first.id)}`,
      headers: headers('owner', 'chat-file-delete-first'),
      payload: { confirmation: 'DELETE' },
    });
    expect(removed.json()).toMatchObject({ deleted: true, fileId: first.id });
    const missing = await app.inject({
      method: 'GET',
      url: first.websitePath,
      headers: headers('owner'),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects oversized/quota-breaking writes and serializes simultaneous edits', async () => {
    const missingKey = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts`,
      headers: headers('owner'),
      payload: { path: 'missing-key.md', content: 'No key.' },
    });
    expect(missingKey.json()).toMatchObject({ status: 400, code: 'idempotency_key_required' });
    const oversized = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts`,
      headers: headers('owner', 'artifact-too-large'),
      payload: { path: 'too-large.md', content: 'x'.repeat(1025) },
    });
    expect(oversized.json()).toMatchObject({ status: 413, code: 'chat_artifact_file_too_large' });

    let quotaFailure: { status?: number; code?: string } | null = null;
    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/artifacts`,
        headers: headers('owner', `artifact-quota-${String(index)}`),
        payload: { path: `quota-${String(index)}.md`, content: 'q'.repeat(1000) },
      });
      if (response.statusCode !== 201) {
        quotaFailure = response.json();
        break;
      }
    }
    expect(quotaFailure).toMatchObject({ status: 413, code: 'chat_artifact_quota_exceeded' });

    const listing = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/artifacts?directory=Notes`,
      headers: headers('owner'),
    });
    const report = listing
      .json()
      .items.find(({ path }: { path: string }) => path === 'Notes/Revenue Report.md');
    const patch = (replacement: string, key: string) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/chats/${chatId}/artifacts/${String(report.id)}/content`,
        headers: headers('owner', key),
        payload: {
          expectedSha256: report.sha256,
          patches: [
            {
              startLine: 3,
              deleteCount: 1,
              expectedLines: ['Updated revenue note.'],
              replacementLines: [replacement],
            },
          ],
        },
      });
    const concurrent = await Promise.all([
      patch('First concurrent edit.', 'artifact-race-first'),
      patch('Second concurrent edit.', 'artifact-race-second'),
    ]);
    expect(concurrent.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    const current = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/artifacts/${String(report.id)}/content`,
      headers: headers('owner'),
    });
    expect(current.json().content).toMatch(/(?:First|Second) concurrent edit\./u);
  });

  it('ignores an abandoned atomic-write temp file and keeps the committed revision readable', async () => {
    const temporaryRoot = join(chatRoot, 'users', String(ownerId), 'chats', chatId, 'tmp');
    await writeFile(join(temporaryRoot, 'abandoned-write.tmp'), 'partial secret', 'utf8');
    const service = new ChatArtifactService(pool);
    const report = await service.find({
      conversationId: chatId,
      principalId: ownerId,
      path: 'Notes/Revenue Report.md',
    });
    const committed = await service.read({
      conversationId: chatId,
      principalId: ownerId,
      artifactId: report.id,
    });
    expect(committed.content).toMatch(/concurrent edit/u);
    const inventory = await service.inventory({ conversationId: chatId, principalId: ownerId });
    expect(inventory.untracked).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'abandoned-write.tmp' })]),
    );
  });

  it('detects untracked and symlinked paths without importing them', async () => {
    const docsRoot = join(chatRoot, 'users', String(ownerId), 'chats', chatId, 'docs');
    await writeFile(join(docsRoot, 'untracked.md'), '# Not imported\n', 'utf8');
    await mkdir(join(outsideRoot, 'outside-folder'));
    await symlink(join(outsideRoot, 'outside-folder'), join(docsRoot, 'unsafe-link'), 'junction');
    const preview = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/artifacts-reconciliation`,
      headers: headers('owner'),
    });
    expect(preview.json()).toMatchObject({ readOnly: true, mutationsApplied: 0 });
    expect(preview.json().untracked).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'untracked.md' })]),
    );
    expect(preview.json().unsafePaths).toContain('unsafe-link');
  });

  it('offers model file tools without RAG/web tools and records model provenance', async () => {
    const sent = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/messages`,
      headers: headers('owner', 'artifact-model-message'),
      payload: { content: 'Create a short Markdown report.' },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    const service = new ChatArtifactService(pool);
    expect(
      await processOneChatRun({
        pool,
        leaseOwner: 'artifact-worker',
        resolveProvider: async () => provider,
        artifactEnabled: true,
        artifactExecutor: createChatArtifactExecutor(service),
      }),
    ).toBe(true);
    const tools = providerRequests.at(-1)?.tools.map(({ name }) => name) ?? [];
    expect(tools).toEqual([
      'files.list.v1',
      'files.read.v1',
      'files.create.v1',
      'files.mkdir.v1',
      'files.rename.v1',
      'files.copy.v1',
      'files.patch.v1',
    ]);
    expect(tools).not.toEqual(expect.arrayContaining(['web.search.v1', 'rag.search.v1']));
    const modelArtifact = await service.find({
      conversationId: chatId,
      principalId: ownerId,
      path: 'model-report.md',
    });
    const revisions = await service.history({
      conversationId: chatId,
      principalId: ownerId,
      artifactId: modelArtifact.id,
    });
    expect(revisions[0]).toMatchObject({
      createdByKind: 'model',
      runId: sent.json().runId,
      toolCallId: expect.any(String),
    });
  });
});
