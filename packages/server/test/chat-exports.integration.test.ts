import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerChatArtifactRoutes } from '../src/api/chat-artifact-routes.js';
import { registerChatExportRoutes } from '../src/api/chat-export-routes.js';
import type { RequestAuthenticator } from '../src/api/authentication.js';
import { registerChatRoutes } from '../src/api/chat-routes.js';
import { ChatExportService, processOneChatExport } from '../src/chat/exports.js';
import { probeChatStorage } from '../src/chat/storage.js';
import { extractDocument } from '../src/extract/index.js';
import { DocumentFileStore } from '../src/storage/document-files.js';
import { runMigrations } from '../src/store/migrations.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;
let disabledApp: FastifyInstance;
let storageParent: string;
let chatRoot: string;
let dataRoot: string;
let documentFiles: DocumentFileStore;
let ownerId: number;
let otherId: number;
let siloId: number;
let deniedSiloId: number;
let chatId: string;

const authenticate: RequestAuthenticator = async (request) => {
  const identity = request.headers['x-test-user'];
  if (!['owner', 'admin', 'other', 'search'].includes(String(identity))) return null;
  return {
    principalId: identity === 'other' ? otherId : ownerId,
    serverAdmin: identity === 'admin',
    searchOnly: identity === 'search',
    sessionToken: `session-${String(identity)}`,
    csrfAllowed: (candidate) => candidate === 'chat-csrf',
  };
};

const headers = (identity: 'owner' | 'admin' | 'other' | 'search', key?: string) => ({
  'x-test-user': identity,
  'x-csrf-token': 'chat-csrf',
  origin: 'http://127.0.0.1:8787',
  ...(key === undefined ? {} : { 'idempotency-key': key }),
});

const createArtifact = async (name: string, content: string) => {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/chats/${chatId}/artifacts`,
    headers: headers('owner', `create-${name}-${randomUUID()}`),
    payload: { path: name, content },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().artifact as {
    id: string;
    revision: number;
    sha256: string;
    name: string;
  };
};

const queueExport = async (artifactId: string, format: 'docx' | 'pdf', revision = 1) => {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/chats/${chatId}/artifacts/${artifactId}/exports`,
    headers: headers('owner', `export-${format}-${randomUUID()}`),
    payload: { format, revision },
  });
  expect(response.statusCode, response.body).toBe(202);
  return response.json() as {
    id: string;
    sourceRevision: number;
    sourceSha256: string;
    format: 'docx' | 'pdf';
  };
};

beforeAll(async () => {
  container = await new PostgreSqlContainer(postgresImage)
    .withDatabase('noderag_chat_exports')
    .withUsername('noderag')
    .withPassword('synthetic-chat-export-password')
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
    `INSERT INTO noderag.principal(kind,label)
     VALUES('user','export-owner'),('user','export-other') RETURNING id,label`,
  );
  ownerId = Number(principals.rows.find(({ label }) => label === 'export-owner')?.id);
  otherId = Number(principals.rows.find(({ label }) => label === 'export-other')?.id);
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
  const silos = await pool.query<{ id: number; slug: string }>(
    `INSERT INTO noderag.silo(slug,display_name,description,created_by)
     VALUES('export-target','Export target','Authorized target',$1),
           ('export-denied','Export denied','No upload grant',$1)
     RETURNING id,slug`,
    [ownerId],
  );
  siloId = Number(silos.rows.find(({ slug }) => slug === 'export-target')?.id);
  deniedSiloId = Number(silos.rows.find(({ slug }) => slug === 'export-denied')?.id);
  await pool.query(
    `INSERT INTO noderag.silo_grant(principal_id,silo_id,capability,granted_by)
     VALUES($1,$2,'read',$1),($1,$2,'upload',$1),($3,$2,'upload',$1)`,
    [ownerId, siloId, otherId],
  );
  storageParent = await mkdtemp(join(tmpdir(), 'noderag-chat-exports-'));
  dataRoot = await mkdtemp(join(tmpdir(), 'noderag-chat-export-documents-'));
  const storage = await probeChatStorage(storageParent, { policy: 'testbed' });
  chatRoot = storage.chatRoot;
  const current = await pool.query<{ context_revision_id: number }>(
    'SELECT context_revision_id FROM noderag.chat_configuration_current WHERE singleton=true',
  );
  const settings = await pool.query<{ id: number }>(
    `INSERT INTO noderag.chat_settings_revision
       (revision_id,context_revision_id,default_connection_id,default_model,
        default_reasoning_effort,default_context_mode,default_allow_research,
        default_allow_rag,default_allow_internet,markdown_only,run_timeout_ms,
        maximum_tool_calls,maximum_parallel_runs_per_user,daily_run_quota,
        daily_input_token_quota,daily_output_token_quota,retention_days,archive_after_days,
        storage_requested_path,storage_resolved_path,storage_manifest_id,
        artifact_max_file_bytes,artifact_chat_quota_bytes,export_max_output_bytes,
        export_timeout_ms,export_maximum_attempts,created_by)
     VALUES($1,$2,$3,'minimax-m3:cloud','default','rolling',false,false,false,true,
       120000,8,2,100,1000000,250000,365,30,$4,$5,$6,1048576,16777216,67108864,120000,2,$7)
     RETURNING id`,
    [
      randomUUID(),
      current.rows[0]?.context_revision_id,
      connectionId,
      storageParent,
      storage.chatRoot,
      storage.manifest.manifestId,
      ownerId,
    ],
  );
  await pool.query(
    'UPDATE noderag.chat_configuration_current SET settings_revision_id=$1,updated_at=now()',
    [settings.rows[0]?.id],
  );
  documentFiles = new DocumentFileStore(dataRoot);
  await documentFiles.initialize();
  app = Fastify({ logger: false });
  registerChatRoutes(app, {
    pool,
    authenticate,
    enabled: true,
    artifactsEnabled: true,
    exportsEnabled: true,
  });
  registerChatArtifactRoutes(app, { pool, authenticate, enabled: true });
  registerChatExportRoutes(app, {
    pool,
    authenticate,
    files: documentFiles,
    enabled: true,
    minimumFreeBytes: 0,
  });
  await app.ready();
  disabledApp = Fastify({ logger: false });
  registerChatExportRoutes(disabledApp, {
    pool,
    authenticate,
    files: documentFiles,
    enabled: false,
  });
  await disabledApp.ready();
  const created = await app.inject({
    method: 'POST',
    url: '/v1/chats',
    headers: headers('owner', 'create-export-chat'),
    payload: { name: 'Export workspace' },
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
  if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
});

describe.sequential('C09 durable document export and RAG promotion', () => {
  it('keeps export routes behind feature, owner, entitlement, and administrator boundaries', async () => {
    const artifact = await createArtifact('boundaries.md', '# Boundaries');
    const disabled = await disabledApp.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/exports`,
      headers: headers('owner'),
    });
    expect(disabled.statusCode).toBe(404);
    const search = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/exports`,
      headers: headers('search'),
    });
    expect(search.statusCode).toBe(404);
    const other = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts/${artifact.id}/exports`,
      headers: headers('other', 'cross-owner-export'),
      payload: { format: 'pdf', revision: 1 },
    });
    expect(other.json()).toMatchObject({ status: 404, code: 'chat_artifact_not_found' });
    const missingIdempotency = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts/${artifact.id}/exports`,
      headers: headers('owner'),
      payload: { format: 'pdf', revision: 1 },
    });
    expect(missingIdempotency.json()).toMatchObject({
      status: 400,
      code: 'idempotency_key_required',
    });
    const deniedCapability = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/exports/capabilities',
      headers: headers('owner'),
    });
    expect(deniedCapability.json()).toMatchObject({ status: 403, code: 'server_admin_required' });
    const capability = await app.inject({
      method: 'GET',
      url: '/v1/admin/chat/exports/capabilities',
      headers: headers('admin'),
    });
    expect(capability.json()).toMatchObject({
      status: 'healthy',
      shellConversion: false,
      networkConversion: false,
      formats: { docx: { available: true }, pdf: { available: true, embeddedFonts: true } },
    });
  });

  it('exports PDF durably with progress, provenance, safe inline preview, and idempotency', async () => {
    const artifact = await createArtifact(
      'revenue.pdf-source.md',
      '# Revenue report\n\nTax revenue supports public services.\n',
    );
    const key = `pdf-idempotency-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts/${artifact.id}/exports`,
      headers: headers('owner', key),
      payload: { format: 'pdf', revision: 1 },
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts/${artifact.id}/exports`,
      headers: headers('owner', key),
      payload: { format: 'pdf', revision: 1 },
    });
    expect(first.statusCode, first.body).toBe(202);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(await processOneChatExport({ pool, leaseOwner: 'test-pdf-worker' })).toBe(true);
    const status = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/exports/${String(first.json().id)}`,
      headers: headers('owner'),
    });
    expect(status.json()).toMatchObject({
      state: 'succeeded',
      phase: 'complete',
      progressPercent: 100,
      sourceRevision: 1,
      sourceSha256: artifact.sha256,
      format: 'pdf',
    });
    expect(status.json().events.map(({ type }: { type: string }) => type)).toEqual(
      expect.arrayContaining(['queued', 'leased', 'progress', 'succeeded']),
    );
    const download = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/exports/${String(first.json().id)}/download?disposition=inline`,
      headers: headers('owner'),
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.headers['content-disposition']).toContain('inline');
    expect(download.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const stored = await pool.query<{ output_relative_path: string }>(
      'SELECT output_relative_path FROM noderag.chat_export_job WHERE id=$1',
      [first.json().id],
    );
    await writeFile(join(chatRoot, String(stored.rows[0]?.output_relative_path)), 'tampered');
    const rejectedTamper = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/exports/${String(first.json().id)}/download`,
      headers: headers('owner'),
    });
    expect(rejectedTamper.json()).toMatchObject({
      status: 422,
      code: 'chat_export_storage_unsafe',
    });
  });

  it('exports the selected DOCX revision even after the working artifact changes', async () => {
    const artifact = await createArtifact(
      'immutable.md',
      '# Immutable\n\nOriginal tax evidence.\n',
    );
    const queued = await queueExport(artifact.id, 'docx');
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/chats/${chatId}/artifacts/${artifact.id}/content`,
      headers: headers('owner', `patch-after-export-${randomUUID()}`),
      payload: {
        expectedSha256: artifact.sha256,
        patches: [
          {
            startLine: 3,
            deleteCount: 1,
            expectedLines: ['Original tax evidence.'],
            replacementLines: ['Later unrelated edit.'],
          },
        ],
      },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await processOneChatExport({ pool, leaseOwner: 'test-docx-worker' })).toBe(true);
    const download = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/exports/${queued.id}/download`,
      headers: headers('owner'),
    });
    const extracted = await extractDocument(download.rawPayload, 'docx');
    expect(extracted.markdown).toContain('Original tax evidence.');
    expect(extracted.markdown).not.toContain('Later unrelated edit.');
  });

  it('cancels queued work and reclaims an interrupted lease without duplicating output', async () => {
    const cancelledArtifact = await createArtifact('cancelled.md', '# Cancel me');
    const cancelled = await queueExport(cancelledArtifact.id, 'pdf');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/exports/${cancelled.id}/cancel`,
      headers: headers('owner', `cancel-${randomUUID()}`),
      payload: {},
    });
    expect(response.json()).toMatchObject({
      state: 'cancelled',
      errorCode: 'chat_export_cancelled',
    });

    const interruptedArtifact = await createArtifact('restart.md', '# Restart\n\nResume safely.');
    const interrupted = await queueExport(interruptedArtifact.id, 'pdf');
    const service = new ChatExportService(pool);
    const abandoned = await service.claim('stopped-worker');
    expect(abandoned?.id).toBe(interrupted.id);
    await pool.query(
      `UPDATE noderag.chat_export_job SET leased_until=now()-interval '1 second' WHERE id=$1`,
      [interrupted.id],
    );
    expect(await processOneChatExport({ pool, leaseOwner: 'replacement-worker', service })).toBe(
      true,
    );
    const status = await service.get({
      conversationId: chatId,
      principalId: ownerId,
      exportId: interrupted.id,
    });
    expect(status).toMatchObject({ state: 'succeeded', attempts: 2 });
    expect(status.events.map(({ type }) => type)).toContain('lease_reclaimed');
  });

  it('cleans published output on cancellation and retries converter crashes without leaking details', async () => {
    const cancellationArtifact = await createArtifact(
      'cancel-after-publish.md',
      '# Cancel after publish\n\nDo not retain output.',
    );
    const cancellation = await queueExport(cancellationArtifact.id, 'pdf');
    class CancelAfterPublishService extends ChatExportService {
      override async heartbeat(...args: Parameters<ChatExportService['heartbeat']>): Promise<void> {
        if (args[2] === 95) {
          await this.cancel({
            conversationId: chatId,
            principalId: ownerId,
            exportId: args[0].id,
          });
        }
        return super.heartbeat(...args);
      }
    }
    await processOneChatExport({
      pool,
      leaseOwner: 'cancel-after-publish-worker',
      service: new CancelAfterPublishService(pool),
    });
    const cancelled = await new ChatExportService(pool).get({
      conversationId: chatId,
      principalId: ownerId,
      exportId: cancellation.id,
    });
    expect(cancelled).toMatchObject({ state: 'cancelled', outputSha256: null });
    const retained = await readdir(join(chatRoot, 'exports', cancellation.id)).catch(
      (error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
      },
    );
    expect(retained).toEqual([]);

    const crashingArtifact = await createArtifact('crashing.md', '# Converter crash');
    const crashing = await queueExport(crashingArtifact.id, 'docx');
    class CrashingExportService extends ChatExportService {
      override async publish(): Promise<never> {
        throw new Error('secret converter path and implementation detail');
      }
    }
    const crashingService = new CrashingExportService(pool);
    await processOneChatExport({ pool, leaseOwner: 'crash-worker-1', service: crashingService });
    let failed = await crashingService.get({
      conversationId: chatId,
      principalId: ownerId,
      exportId: crashing.id,
    });
    expect(failed).toMatchObject({ state: 'retry_wait', attempts: 1 });
    await pool.query('UPDATE noderag.chat_export_job SET run_after=now() WHERE id=$1', [
      crashing.id,
    ]);
    await processOneChatExport({ pool, leaseOwner: 'crash-worker-2', service: crashingService });
    failed = await crashingService.get({
      conversationId: chatId,
      principalId: ownerId,
      exportId: crashing.id,
    });
    expect(failed).toMatchObject({
      state: 'failed',
      attempts: 2,
      errorCode: 'chat_export_generation_failed',
      errorDetail: 'Export stopped safely (chat_export_generation_failed).',
    });
    expect(String(failed.errorDetail)).not.toContain('secret converter path');
  });

  it('claims simultaneous exports once across independent workers', async () => {
    const [firstArtifact, secondArtifact] = await Promise.all([
      createArtifact('parallel-one.md', '# Parallel one\n\nFirst export.'),
      createArtifact('parallel-two.md', '# Parallel two\n\nSecond export.'),
    ]);
    const [first, second] = await Promise.all([
      queueExport(firstArtifact.id, 'docx'),
      queueExport(secondArtifact.id, 'pdf'),
    ]);
    expect(
      await Promise.all([
        processOneChatExport({ pool, leaseOwner: 'parallel-worker-one' }),
        processOneChatExport({ pool, leaseOwner: 'parallel-worker-two' }),
      ]),
    ).toEqual([true, true]);
    const service = new ChatExportService(pool);
    const statuses = await Promise.all(
      [first.id, second.id].map((exportId) =>
        service.get({ conversationId: chatId, principalId: ownerId, exportId }),
      ),
    );
    expect(statuses.map(({ state }) => state)).toEqual(['succeeded', 'succeeded']);
    expect(statuses.map(({ attempts }) => attempts)).toEqual([1, 1]);
  });

  it('requires upload grants and promotes exact Markdown/PDF snapshots with durable provenance', async () => {
    const artifact = await createArtifact(
      'promote.md',
      '# Promoted evidence\n\nRevenue reference for ingestion.\n',
    );
    const denied = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts/${artifact.id}/ingestions`,
      headers: headers('owner', `denied-promotion-${randomUUID()}`),
      payload: {
        siloId: deniedSiloId,
        revision: 1,
        sourceFormat: 'markdown',
        expectedSha256: artifact.sha256,
      },
    });
    expect(denied.json()).toMatchObject({ status: 404, code: 'silo_not_found' });
    const wrongHash = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts/${artifact.id}/ingestions`,
      headers: headers('owner', `wrong-hash-${randomUUID()}`),
      payload: {
        siloId,
        revision: 1,
        sourceFormat: 'markdown',
        expectedSha256: '0'.repeat(64),
      },
    });
    expect(wrongHash.json()).toMatchObject({ status: 409, code: 'chat_export_source_changed' });
    const markdownKey = `markdown-promotion-${randomUUID()}`;
    const markdown = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts/${artifact.id}/ingestions`,
      headers: headers('owner', markdownKey),
      payload: {
        siloId,
        revision: 1,
        sourceFormat: 'markdown',
        expectedSha256: artifact.sha256,
      },
    });
    expect(markdown.statusCode, markdown.body).toBe(202);
    const markdownReplay = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts/${artifact.id}/ingestions`,
      headers: headers('owner', markdownKey),
      payload: {
        siloId,
        revision: 1,
        sourceFormat: 'markdown',
        expectedSha256: artifact.sha256,
      },
    });
    expect(markdownReplay.statusCode).toBe(200);
    expect(markdownReplay.json()).toEqual(markdown.json());
    const document = await pool.query<{
      metadata: Record<string, unknown>;
      original_sha256: Buffer;
    }>('SELECT metadata,original_sha256 FROM noderag.document WHERE id=$1', [
      markdown.json().documentId,
    ]);
    expect(document.rows[0]?.original_sha256.toString('hex')).toBe(artifact.sha256);
    expect(document.rows[0]?.metadata).toMatchObject({
      chatArtifact: {
        conversationId: chatId,
        artifactId: artifact.id,
        revision: 1,
        sourceSha256: artifact.sha256,
        sourceFormat: 'markdown',
      },
    });
    const edited = await app.inject({
      method: 'PATCH',
      url: `/v1/chats/${chatId}/artifacts/${artifact.id}/content`,
      headers: headers('owner', `edit-after-promotion-${randomUUID()}`),
      payload: {
        expectedSha256: artifact.sha256,
        patches: [
          {
            startLine: 3,
            deleteCount: 1,
            expectedLines: ['Revenue reference for ingestion.'],
            replacementLines: ['A later artifact edit must remain independent.'],
          },
        ],
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const promotedMarkdown = await readFile(
      documentFiles.paths(Number(markdown.json().documentId), 'md').originalAbsolute,
      'utf8',
    );
    expect(promotedMarkdown).toContain('Revenue reference for ingestion.');
    expect(promotedMarkdown).not.toContain('later artifact edit');
    const pdf = await queueExport(artifact.id, 'pdf');
    expect(await processOneChatExport({ pool, leaseOwner: 'promotion-pdf-worker' })).toBe(true);
    const pdfStatus = await new ChatExportService(pool).get({
      conversationId: chatId,
      principalId: ownerId,
      exportId: pdf.id,
    });
    const promotedPdf = await app.inject({
      method: 'POST',
      url: `/v1/chats/${chatId}/artifacts/${artifact.id}/ingestions`,
      headers: headers('owner', `pdf-promotion-${randomUUID()}`),
      payload: {
        siloId,
        revision: 1,
        sourceFormat: 'pdf',
        exportId: pdf.id,
        expectedSha256: pdfStatus.outputSha256,
      },
    });
    expect(promotedPdf.statusCode, promotedPdf.body).toBe(202);
    const link = await pool.query<{
      source_format: string;
      source_sha256: Buffer;
      document_id: number;
      ingestion_job_id: number;
    }>(
      `SELECT source_format,source_sha256,document_id,ingestion_job_id
       FROM noderag.chat_artifact_ingestion WHERE document_id=$1`,
      [promotedPdf.json().documentId],
    );
    expect(link.rows[0]?.source_format).toBe('pdf');
    expect(Number(link.rows[0]?.document_id)).toBe(promotedPdf.json().documentId);
    expect(Number(link.rows[0]?.ingestion_job_id)).toBe(promotedPdf.json().jobId);
    expect(link.rows[0]?.source_sha256.toString('hex')).toBe(pdfStatus.outputSha256);
  });
});
