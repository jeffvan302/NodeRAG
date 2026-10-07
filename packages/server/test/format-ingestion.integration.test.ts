import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sliceUtf8, type Embedder, type EmbeddingBatch } from '@noderag/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeterministicRuntime } from '../../embedder/src/runtime.js';
import { buildApp } from '../src/app.js';
import { createRequestAuthenticator } from '../src/api/authentication.js';
import { drainMarkdownJobs, processOneDocumentJob } from '../src/ingest/pipeline.js';
import { bootstrapFirstAdministrator, issueSetupToken } from '../src/setup/bootstrap.js';
import { DocumentFileStore } from '../src/storage/document-files.js';
import { runMigrations } from '../src/store/migrations.js';
import { createDatabaseReadinessProbe } from '../src/store/readiness.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

const fixture = (...parts: string[]): string =>
  join(process.cwd(), 'fixtures', 'formats', ...parts);

const multipart = (filename: string, mimeType: string, body: Buffer) => {
  const boundary = `noderag-${crypto.randomUUID()}`;
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

class DeterministicEmbedder implements Embedder {
  private readonly runtime = createDeterministicRuntime();

  countTokens(texts: readonly string[]) {
    return this.runtime.countTokens(texts);
  }

  embed(texts: readonly string[], maximumTokens: number): Promise<EmbeddingBatch> {
    return this.runtime.embed(texts, maximumTokens);
  }
}

describe.sequential('M06 all-format ingestion', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let root: string;
  let files: DocumentFileStore;
  let siloId: number;
  let administratorId: number;
  let app: ReturnType<typeof buildApp>;
  let cookie: string | string[] | undefined;
  let csrf: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(postgresImage)
      .withDatabase('noderag_formats')
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
      username: 'm06-admin',
      password: 'M06-admin-password!',
    });
    siloId = setup.defaultSilo.id;
    administratorId = setup.principalId;
    root = await mkdtemp(join(tmpdir(), 'noderag-m06-'));
    files = new DocumentFileStore(root);
    await files.initialize();
    const authenticate = createRequestAuthenticator(pool, 'http://noderag.test');
    app = buildApp({
      readiness: createDatabaseReadinessProbe(database),
      uiRoot: join(root, 'missing-ui'),
      logger: false,
      identity: {
        pool,
        expectedOrigin: 'http://noderag.test',
        secureCookie: false,
        authenticate,
      },
      content: {
        pool,
        authenticate,
        files,
        embedder: new DeterministicEmbedder(),
        maximumUploadBytes: 4 * 1024 * 1024,
        minimumFreeBytes: 0,
        sourceRoots: [root],
      },
    });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'm06-admin', password: 'M06-admin-password!' },
    });
    expect(login.statusCode).toBe(200);
    cookie = login.headers['set-cookie'];
    csrf = login.json<{ csrfToken: string }>().csrfToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
    await rm(root, { recursive: true, force: true });
  });

  const upload = async (
    filename: string,
    mimeType: string,
    bytes: Buffer,
    key: string,
  ): Promise<number> => {
    const body = multipart(filename, mimeType, bytes);
    const response = await app.inject({
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
    expect(response.statusCode, response.body).toBe(202);
    return response.json<{ documentId: number }>().documentId;
  };

  it('rejects an extension/MIME-valid upload whose signature is wrong', async () => {
    const body = multipart('fake.pdf', 'application/pdf', Buffer.from('not a PDF'));
    const response = await app.inject({
      method: 'POST',
      url: `/v1/documents?siloId=${String(siloId)}`,
      headers: {
        cookie,
        origin: 'http://noderag.test',
        'x-csrf-token': csrf,
        'idempotency-key': 'm06-bad-signature',
        'content-type': body.contentType,
      },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ code: 'document-signature-mismatch' });
  });

  it('uploads, extracts, locates, embeds, and retrieves every supported format', async () => {
    const inputs = [
      {
        name: 'sample.md',
        mime: 'text/markdown',
        bytes: await readFile(fixture('md', 'sample.md')),
        basis: 'none',
      },
      {
        name: 'sample.txt',
        mime: 'text/plain',
        bytes: await readFile(fixture('txt', 'sample.txt')),
        basis: 'none',
      },
      {
        name: 'two-column.pdf',
        mime: 'application/pdf',
        bytes: await readFile(fixture('pdf', 'two-column.pdf')),
        basis: 'exact',
      },
      {
        name: 'word-saved.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: await readFile(fixture('docx', 'word-saved.docx')),
        basis: 'rendered',
      },
      {
        name: 'messy-workbook.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: await readFile(fixture('xlsx', 'messy-workbook.xlsx')),
        basis: 'sheet',
      },
    ] as const;
    const ids: number[] = [];
    for (const [index, input] of inputs.entries()) {
      ids.push(await upload(input.name, input.mime, input.bytes, `m06-format-${String(index)}`));
    }
    const processedJobs = await drainMarkdownJobs({
      pool,
      files,
      embedder: new DeterministicEmbedder(),
      leaseOwner: 'm06-format-worker',
    });
    const jobDiagnostics = await pool.query<{
      kind: string;
      state: string;
      last_error_code: string | null;
      last_error_detail: string | null;
    }>(
      `SELECT kind,state,last_error_code,last_error_detail
       FROM noderag.job WHERE document_id=ANY($1::bigint[])
       ORDER BY document_id,kind`,
      [ids],
    );
    expect(processedJobs, JSON.stringify(jobDiagnostics.rows)).toBe(inputs.length * 2);

    const documents = await pool.query<{
      id: string;
      extension: string;
      state: string;
      page_basis: string;
      page_count: number;
      metadata: {
        extractionWarnings?: readonly string[];
        extractionMetadata?: Record<string, unknown>;
      };
    }>(
      `SELECT id::text, extension, state, page_basis, page_count, metadata
       FROM noderag.document WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [ids],
    );
    expect(documents.rows.map(({ state }) => state)).toEqual(inputs.map(() => 'ready'));
    expect(documents.rows.map(({ page_basis }) => page_basis)).toEqual(
      inputs.map(({ basis }) => basis),
    );
    expect(documents.rows[2]?.metadata.extractionMetadata).toMatchObject({
      pdfExtractionVersion: 'pdf-layout.v3-hybrid',
      parserRevision: 'pdfjs-dist@6.3.289',
      layoutPolicyRevision: 'native-layout.v1',
      confidencePolicyRevision: 'pdf-confidence.v1',
    });
    const pdfProgress = await pool.query<{ detail: Record<string, unknown> }>(
      `SELECT event.detail
       FROM noderag.job job
       JOIN noderag.job_event event ON event.job_id=job.id
       WHERE job.document_id=$1 AND job.kind='extract' AND event.event_type='progress'
       ORDER BY event.sequence`,
      [ids[2]],
    );
    expect(pdfProgress.rows.some(({ detail }) => detail['stage'] === 'extracting-pages')).toBe(
      true,
    );
    expect(pdfProgress.rows.some(({ detail }) => detail['stage'] === 'classifying-layout')).toBe(
      true,
    );
    expect(pdfProgress.rows.some(({ detail }) => detail['stage'] === 'analysing-pages')).toBe(true);
    const documentList = await app.inject({
      method: 'GET',
      url: '/v1/documents?limit=100',
      headers: { cookie },
    });
    expect(documentList.statusCode, documentList.body).toBe(200);
    const listedPdf = documentList
      .json<{
        items: Array<{
          id: number;
          ingestionJobs: Array<{ kind: string; progress: Record<string, unknown> }>;
        }>;
      }>()
      .items.find(({ id }) => id === ids[2]);
    expect(listedPdf?.ingestionJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'extract',
          progress: expect.objectContaining({ stage: 'complete', percent: 100 }),
        }),
      ]),
    );

    for (const [index, id] of ids.entries()) {
      const canonical = await readFile(files.paths(id).markdownAbsolute, 'utf8');
      expect(canonical.length).toBeGreaterThan(0);
      const pages = await pool.query<{
        character_start: number;
        character_end: number;
        byte_start: number;
        byte_end: number;
      }>(
        `SELECT character_start, character_end, byte_start, byte_end
         FROM noderag.document_page WHERE document_id=$1 ORDER BY ordinal`,
        [id],
      );
      expect(pages.rows).toHaveLength(documents.rows[index]?.page_count ?? 0);
      for (const page of pages.rows) {
        const characterSlice = canonical.slice(page.character_start, page.character_end);
        expect(sliceUtf8(canonical, page.byte_start, page.byte_end)).toBe(characterSlice);
      }
      const blocks = await pool.query<{
        page_ordinal: number;
        ordinal: number;
        kind: string;
        native_text: string;
        markdown: string;
        bound_x: number | null;
        bound_y: number | null;
        bound_width: number | null;
        bound_height: number | null;
        character_start: number;
        character_end: number;
        byte_start: number;
        byte_end: number;
        confidence_components: {
          routing?: { disposition?: string; reasons?: string[] };
          components?: Record<string, number>;
        };
      }>(
        `SELECT page_ordinal, ordinal, kind, native_text, markdown,
                bound_x, bound_y, bound_width, bound_height,
                character_start, character_end, byte_start, byte_end, confidence_components
         FROM noderag.document_block
         WHERE document_id=$1 ORDER BY page_ordinal, reading_order, ordinal`,
        [id],
      );
      expect(blocks.rows.length).toBeGreaterThan(0);
      for (const block of blocks.rows) {
        expect(canonical.slice(block.character_start, block.character_end)).toBe(block.markdown);
        expect(sliceUtf8(canonical, block.byte_start, block.byte_end)).toBe(block.markdown);
        if (inputs[index]?.name.endsWith('.pdf') === true) {
          expect(block.native_text.length).toBeGreaterThan(0);
          expect(['title', 'heading', 'paragraph', 'list-item', 'table', 'unknown']).toContain(
            block.kind,
          );
          expect([block.bound_x, block.bound_y, block.bound_width, block.bound_height]).toEqual(
            expect.arrayContaining([expect.any(Number)]),
          );
          for (const value of [
            block.bound_x,
            block.bound_y,
            block.bound_width,
            block.bound_height,
          ]) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
          }
          expect(block.confidence_components.routing?.disposition).toMatch(
            /^(?:native-safe|regional-vision|full-page-vision)$/u,
          );
          expect(block.confidence_components.components).toMatchObject({
            textIntegrity: expect.any(Number),
            readingOrder: expect.any(Number),
          });
        } else {
          expect(block.native_text).toBe(block.markdown);
          expect(block.kind).toBe('unknown');
        }
      }
    }

    const diagnostics = await app.inject({
      method: 'GET',
      url: `/v1/documents/${String(ids[2])}/extraction-diagnostics`,
      headers: { cookie },
    });
    expect(diagnostics.statusCode, diagnostics.body).toBe(200);
    expect(diagnostics.json()).toMatchObject({
      documentId: ids[2],
      revisions: {
        pdfExtractionVersion: 'pdf-layout.v3-hybrid',
        confidencePolicyRevision: 'pdf-confidence.v1',
      },
      thresholds: { nativeSafe: 0.82, regionalVision: 0.55 },
      blockCounts: { lowConfidence: expect.any(Number) },
      enhancedReindexAvailable: false,
    });
    const estimate = await app.inject({
      method: 'GET',
      url: `/v1/documents/${String(ids[2])}/enhanced-reindex-estimate`,
      headers: { cookie },
    });
    expect(estimate.statusCode, estimate.body).toBe(200);
    expect(estimate.json()).toMatchObject({
      documentId: ids[2],
      imagesPerCall: 3,
      targetRevisions: { confidencePolicyRevision: 'pdf-confidence.v1' },
      estimateIsProvisional: true,
    });

    const pagedChunks = await pool.query<{ extension: string; page_start: number | null }>(
      `SELECT d.extension, c.page_start
       FROM noderag.chunk c JOIN noderag.document d ON d.id=c.document_id AND d.silo_id=c.silo_id
       WHERE c.document_id = ANY($1::bigint[])`,
      [ids],
    );
    expect(
      pagedChunks.rows
        .filter(
          ({ extension }) => extension === 'pdf' || extension === 'docx' || extension === 'xlsx',
        )
        .every(({ page_start }) => page_start !== null),
    ).toBe(true);

    const search = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { cookie },
      payload: { query: 'maintenance operations', siloIds: [siloId], limit: 10 },
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json<{ items: readonly unknown[] }>().items.length).toBeGreaterThan(0);
  });

  it('keeps PDF diagnostics and re-index estimates visible through row-level security', async () => {
    const found = await pool.query<{ id: string }>(
      "SELECT id::text FROM noderag.document WHERE extension='pdf' ORDER BY id LIMIT 1",
    );
    const documentId = Number(found.rows[0]?.id);
    expect(documentId).toBeGreaterThan(0);

    await pool.query('CREATE ROLE noderag_vision_route_reader NOLOGIN');
    await pool.query('GRANT USAGE ON SCHEMA noderag TO noderag_vision_route_reader');
    await pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA noderag TO noderag_vision_route_reader');
    const restrictedPool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
      options: '-c role=noderag_vision_route_reader',
    });
    const authenticate = async () => ({
      principalId: administratorId,
      serverAdmin: true,
      searchOnly: false,
      sessionToken: null,
      csrfAllowed: () => true,
    });
    const restrictedApp = buildApp({
      readiness: async () => ({
        service: 'noderag',
        status: 'ok',
        state: 'operational',
        migrationHead: null,
        expectedMigrationHead: 'test',
        reasons: [],
      }),
      uiRoot: join(root, 'missing-ui'),
      logger: false,
      identity: {
        pool: restrictedPool,
        expectedOrigin: 'http://noderag.test',
        secureCookie: false,
        authenticate,
      },
      content: {
        pool: restrictedPool,
        authenticate,
        files,
        embedder: new DeterministicEmbedder(),
        maximumUploadBytes: 4 * 1024 * 1024,
        minimumFreeBytes: 0,
        sourceRoots: [root],
      },
    });
    try {
      await restrictedApp.ready();
      for (const endpoint of [
        'vision-estimate',
        'extraction-diagnostics',
        'enhanced-reindex-estimate',
      ]) {
        const response = await restrictedApp.inject({
          method: 'GET',
          url: `/v1/documents/${String(documentId)}/${endpoint}`,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ documentId });
      }
    } finally {
      await restrictedApp.close();
      await restrictedPool.end();
    }
  });

  it('keeps a scanned PDF honest and waiting for the next milestone vision path', async () => {
    const id = await upload(
      'scanned.pdf',
      'application/pdf',
      await readFile(fixture('pdf', 'scanned.pdf')),
      'm06-scanned-pdf',
    );
    expect(
      await drainMarkdownJobs({
        pool,
        files,
        embedder: new DeterministicEmbedder(),
        leaseOwner: 'm06-scanned-worker',
      }),
    ).toBe(1);
    const result = await pool.query<{
      state: string;
      page_basis: string;
      metadata: { extractionWarnings: readonly string[] };
    }>('SELECT state, page_basis, metadata FROM noderag.document WHERE id=$1', [id]);
    expect(result.rows[0]).toMatchObject({ state: 'awaiting_vision', page_basis: 'exact' });
    expect(result.rows[0]?.metadata.extractionWarnings).toContain('pdf-page-vision-required');
    const chunks = await pool.query('SELECT 1 FROM noderag.chunk WHERE document_id=$1', [id]);
    expect(chunks.rowCount).toBe(0);
  });

  it('keeps the prior searchable chunks active until an enhanced PDF re-index swaps atomically', async () => {
    const id = await upload(
      'reindex-layout.pdf',
      'application/pdf',
      await readFile(fixture('pdf', 'two-column.pdf')),
      'm06-enhanced-reindex-source',
    );
    const worker = {
      pool,
      files,
      embedder: new DeterministicEmbedder(),
      leaseOwner: 'm06-enhanced-reindex-worker',
    };
    expect(await drainMarkdownJobs(worker)).toBe(2);
    const before = await pool.query<{ id: string; text: string }>(
      `SELECT id::text, text FROM noderag.chunk
       WHERE document_id = $1 ORDER BY ordinal`,
      [id],
    );
    expect(before.rows.length).toBeGreaterThan(0);

    const queued = await app.inject({
      method: 'POST',
      url: `/v1/documents/${String(id)}/reindex`,
      headers: {
        cookie,
        origin: 'http://noderag.test',
        'x-csrf-token': csrf,
        'idempotency-key': 'm06-enhanced-reindex-request',
      },
      payload: { siloId, enhanced: true },
    });
    expect(queued.statusCode, queued.body).toBe(202);
    expect(queued.json()).toMatchObject({
      enhanced: true,
      targetExtractionVersion: 'pdf-layout.v3-hybrid',
    });
    await expect(
      pool.query('SELECT state FROM noderag.document WHERE id = $1', [id]),
    ).resolves.toMatchObject({ rows: [{ state: 'ready' }] });

    expect(await processOneDocumentJob(worker)).toBe(true);
    const during = await pool.query<{ id: string; text: string }>(
      `SELECT id::text, text FROM noderag.chunk
       WHERE document_id = $1 ORDER BY ordinal`,
      [id],
    );
    expect(during.rows).toEqual(before.rows);
    await expect(
      pool.query('SELECT state FROM noderag.document WHERE id = $1', [id]),
    ).resolves.toMatchObject({ rows: [{ state: 'ready' }] });

    expect(await processOneDocumentJob(worker)).toBe(true);
    const after = await pool.query<{ id: string; text: string }>(
      `SELECT id::text, text FROM noderag.chunk
       WHERE document_id = $1 ORDER BY ordinal`,
      [id],
    );
    expect(after.rows.map(({ text }) => text)).toEqual(before.rows.map(({ text }) => text));
    expect(after.rows.map(({ id: chunkId }) => chunkId)).not.toEqual(
      before.rows.map(({ id: chunkId }) => chunkId),
    );
    const completed = await pool.query<{
      state: string;
      metadata: { enhancedReindex?: { state?: string; pdfExtractionVersion?: string } };
    }>('SELECT state, metadata FROM noderag.document WHERE id = $1', [id]);
    expect(completed.rows[0]).toMatchObject({
      state: 'ready',
      metadata: {
        enhancedReindex: {
          state: 'active',
          pdfExtractionVersion: 'pdf-layout.v3-hybrid',
        },
      },
    });
  });

  it('discovers and ingests all five formats from an allowlisted watched source', async () => {
    const watched = join(root, 'watched-formats');
    await mkdir(watched, { recursive: true });
    await writeFile(join(watched, 'watched.md'), '# Watched Markdown\n\nManaged source body.\n');
    await copyFile(fixture('txt', 'utf8.txt'), join(watched, 'watched.txt'));
    await copyFile(fixture('pdf', 'two-column.pdf'), join(watched, 'watched.pdf'));
    await copyFile(fixture('docx', 'word-saved.docx'), join(watched, 'watched.docx'));
    await copyFile(fixture('xlsx', 'dates-currency.xlsx'), join(watched, 'watched.xlsx'));
    const commonHeaders = {
      cookie,
      origin: 'http://noderag.test',
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/sources',
      headers: { ...commonHeaders, 'idempotency-key': 'm06-source-create' },
      payload: { siloId, uri: watched, includeGlobs: ['**/*'] },
    });
    expect(created.statusCode, created.body).toBe(201);
    const sourceId = created.json<{ id: number }>().id;
    const crawl = await app.inject({
      method: 'POST',
      url: `/v1/sources/${String(sourceId)}/crawl`,
      headers: { ...commonHeaders, 'idempotency-key': 'm06-source-crawl' },
      payload: { siloId },
    });
    expect(crawl.statusCode, crawl.body).toBe(202);
    expect(
      await drainMarkdownJobs({
        pool,
        files,
        embedder: new DeterministicEmbedder(),
        leaseOwner: 'm06-source-worker',
        sourceRoots: [root],
      }),
    ).toBe(11);
    const found = await pool.query<{ extension: string; state: string }>(
      `SELECT extension, state FROM noderag.document WHERE source_id=$1 ORDER BY extension`,
      [sourceId],
    );
    expect(found.rows).toEqual([
      { extension: 'docx', state: 'ready' },
      { extension: 'md', state: 'ready' },
      { extension: 'pdf', state: 'ready' },
      { extension: 'txt', state: 'ready' },
      { extension: 'xlsx', state: 'ready' },
    ]);
  });
});
