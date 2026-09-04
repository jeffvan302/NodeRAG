import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDeterministicRuntime,
  createOnnxRuntime,
  type EmbeddingRuntime,
} from '../../embedder/src/runtime.js';
import { buildApp } from '../src/app.js';
import { createRequestAuthenticator } from '../src/api/authentication.js';
import { drainDocumentJobs } from '../src/ingest/pipeline.js';
import { processOneEvaluationRun } from '../src/search/evaluation-runner.js';
import { bootstrapFirstAdministrator, issueSetupToken } from '../src/setup/bootstrap.js';
import { DocumentFileStore } from '../src/storage/document-files.js';
import { runMigrations } from '../src/store/migrations.js';
import { createDatabaseReadinessProbe } from '../src/store/readiness.js';
import { createSilo } from '../src/store/silos.js';
import { withTransaction } from '../src/store/database.js';
import {
  activateVerifiedBuild,
  confirmRebuildProposal,
  createRebuildProposal,
  rollbackBuildActivation,
  verifyStagedSilo,
} from '../src/store/rebuilds.js';
import { DatabaseVisionCache } from '../src/vision/database-cache.js';
import { DeterministicFakeVisionProvider } from '../src/vision/fake.js';
import { VisionProcessor } from '../src/vision/service.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';
const corpusRoot = join(process.cwd(), 'fixtures', 'evaluation', 'm12', 'corpus');
const configuredModelRoot = process.env['NODERAG_M12_MODEL_ROOT']?.trim();
const modelRoot = configuredModelRoot === '' ? undefined : configuredModelRoot;
const useRealModel = modelRoot !== undefined;
const modelVariant = process.env['NODERAG_M12_MODEL_VARIANT'] === 'q4' ? 'q4' : 'q8';

const multipart = (filename: string, mimeType: string, body: Buffer) => {
  const boundary = `noderag-m12-${crypto.randomUUID()}`;
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

class CorpusVisionProvider extends DeterministicFakeVisionProvider {
  override async analyse(request: Parameters<DeterministicFakeVisionProvider['analyse']>[0]) {
    const result = await super.analyse(request);
    return {
      ...result,
      markdown:
        '| Vision rule | Requirement |\n| --- | --- |\n| VR-204 | preserve page number, original image hash, provider/model revisions, retry state, and final Markdown locator |',
      alt: 'VR-204 vision provenance and recovery rule',
    };
  }
}

describe.sequential('M12 measured evaluation corpus', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let dataRoot: string;
  let files: DocumentFileStore;
  let app: ReturnType<typeof buildApp>;
  let embedder: EmbeddingRuntime;
  let administratorId: number;
  let cookie: string | string[] | undefined;
  let csrf: string;

  beforeAll(
    async () => {
      embedder =
        modelRoot === undefined
          ? createDeterministicRuntime()
          : await createOnnxRuntime({
              modelRoot,
              modelPath: join(
                modelRoot,
                'onnx',
                modelVariant === 'q4' ? 'model_q4f16.onnx' : 'model_quint8_avx2.onnx',
              ),
              dimensions: 1024,
              threads: Number(process.env['NODERAG_M12_MODEL_THREADS'] ?? '4'),
            });
      container = await new PostgreSqlContainer(postgresImage)
        .withDatabase('noderag_m12')
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
      pool.on('error', () => undefined);
      const setup = await bootstrapFirstAdministrator(pool, {
        setupToken: await issueSetupToken(pool),
        username: 'm12-admin',
        password: 'M12-admin-password!',
      });
      administratorId = setup.principalId;
      await pool.query(
        `UPDATE noderag.silo SET slug='platform',display_name='Platform' WHERE id=$1`,
        [setup.defaultSilo.id],
      );
      if (modelVariant === 'q4') {
        const queryPrefix =
          'Instruct: Given a user search query, retrieve relevant passages that answer the query\nQuery: ';
        const modelFields = [
          'Qwen3-Embedding-0.6B',
          'c25a394dd583836952667c12f008335071b3f43d',
          '7f9ebb9a77c428f2b4c2d8ed8a2ee64f292a0b1ce7a3f027ccaaef150ef7bdd1',
          'bd58e9fd4b0467770da53678d8da25481c0f959b',
          'q4f16',
          '1024',
          '1024',
          'last_token',
          'l2',
          queryPrefix,
          '',
          'Apache-2.0',
        ];
        const modelDigest = createHash('sha256').update(modelFields.join('\n')).digest('hex');
        await pool.query(`UPDATE noderag.model_manifest SET active=false WHERE active`);
        const model = await pool.query<{ id: number }>(
          `INSERT INTO noderag.model_manifest
           (name,source_revision,artifact_sha256,tokenizer_revision,quantization,
            dimensions,maximum_tokens,pooling,normalization,query_prefix,document_prefix,
            license,active,manifest_digest)
         VALUES($1,$2,$3,$4,$5,1024,1024,'last_token','l2',$6,'','Apache-2.0',true,$7)
         RETURNING id`,
          [
            modelFields[0],
            modelFields[1],
            modelFields[2],
            modelFields[3],
            modelFields[4],
            queryPrefix,
            modelDigest,
          ],
        );
        const modelId = model.rows[0]?.id;
        if (modelId === undefined) throw new Error('q4_model_insert_failed');
        const profileDigest = createHash('sha256')
          .update(
            ['2000', '300', '1024', '0.150', 'true', '1', String(modelId), queryPrefix].join('\n'),
          )
          .digest('hex');
        await pool.query(`UPDATE noderag.build SET state='superseded' WHERE state='active'`);
        await pool.query(`DELETE FROM noderag.silo_build_state WHERE silo_id=$1`, [
          setup.defaultSilo.id,
        ]);
        const build = await pool.query<{ id: number }>(
          `INSERT INTO noderag.build
           (state,target_chars,overlap_chars,max_tokens,snap_window,heading_prefix,
            rules_version,model_manifest_id,query_prefix,reason,completed_at,activated_at,
            profile_digest,model_digest,dimensions,activation_kind)
         VALUES('active',2000,300,1024,0.150,true,1,$1,$2,'M12 q4 measurement',
                now(),now(),$3,$4,1024,'model_revision')
         RETURNING id`,
          [modelId, queryPrefix, profileDigest, modelDigest],
        );
        await pool.query(`UPDATE noderag.settings SET model_manifest_id=$1 WHERE id=1`, [modelId]);
        await pool.query(
          `INSERT INTO noderag.silo_build_state(silo_id,build_id,state,activated_at)
         VALUES($1,$2,'active',now())`,
          [setup.defaultSilo.id, build.rows[0]?.id],
        );
      }
      await createSilo(pool, {
        slug: 'operations',
        displayName: 'Operations',
        creatingPrincipalId: administratorId,
      });
      await createSilo(pool, {
        slug: 'evaluation',
        displayName: 'Evaluation',
        creatingPrincipalId: administratorId,
      });
      dataRoot = await mkdtemp(join(tmpdir(), 'noderag-m12-'));
      files = new DocumentFileStore(dataRoot);
      await files.initialize();
      const authenticate = createRequestAuthenticator(pool, 'http://noderag.test');
      app = buildApp({
        readiness: createDatabaseReadinessProbe(database),
        uiRoot: join(dataRoot, 'missing-ui'),
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
          embedder,
          maximumUploadBytes: 4 * 1024 * 1024,
          minimumFreeBytes: 0,
        },
      });
      await app.ready();
      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username: 'm12-admin', password: 'M12-admin-password!' },
      });
      expect(login.statusCode, login.body).toBe(200);
      cookie = login.headers['set-cookie'];
      csrf = login.json<{ csrfToken: string }>().csrfToken;
    },
    useRealModel ? 300_000 : 60_000,
  );

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
    await embedder.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it(
    'ingests every release format and records pinned vector, keyword, and hybrid runs',
    async () => {
      const golden = JSON.parse(
        await readFile(
          join(process.cwd(), 'fixtures', 'evaluation', 'm12', 'golden-set.json'),
          'utf8',
        ),
      ) as {
        cases: {
          id: string;
          silo: string;
          query: string;
          queryClass: string;
          expectedFormat: string;
          answerable: boolean;
          relevant: unknown;
        }[];
      };
      const manifest = JSON.parse(
        await readFile(
          join(process.cwd(), 'fixtures', 'evaluation', 'm12', 'corpus-manifest.json'),
          'utf8',
        ),
      ) as {
        documents: { path: string; silo: string; format: string }[];
      };
      const silos = await pool.query<{ id: number; slug: string }>(
        `SELECT id,slug FROM noderag.silo ORDER BY id`,
      );
      const siloIds = new Map(silos.rows.map(({ id, slug }) => [slug, id]));
      const mime = new Map([
        ['md', 'text/markdown'],
        ['txt', 'text/plain'],
        ['pdf', 'application/pdf'],
        ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ]);
      for (const [index, document] of manifest.documents.entries()) {
        const name = document.path.split('/').at(-1);
        const siloId = siloIds.get(document.silo);
        if (name === undefined || siloId === undefined) throw new Error('invalid_m12_manifest');
        const body = multipart(
          name,
          mime.get(document.format) ?? 'application/octet-stream',
          await readFile(join(corpusRoot, name)),
        );
        const uploaded = await app.inject({
          method: 'POST',
          url: `/v1/documents?siloId=${String(siloId)}`,
          headers: {
            cookie,
            origin: 'http://noderag.test',
            'x-csrf-token': csrf,
            'idempotency-key': `m12-corpus-${String(index)}`,
            'content-type': body.contentType,
          },
          payload: body.payload,
        });
        expect(uploaded.statusCode, uploaded.body).toBe(202);
      }
      const vision = new VisionProcessor({
        provider: new CorpusVisionProvider(),
        cache: new DatabaseVisionCache(pool),
        maximumAttempts: 1,
      });
      const jobs = await drainDocumentJobs({
        pool,
        files,
        embedder,
        vision,
        leaseOwner: 'm12-corpus-ingest',
      });
      expect(jobs).toBeGreaterThanOrEqual(manifest.documents.length * 2);
      const documents = await pool.query<{ state: string; extension: string }>(
        `SELECT state,extension FROM noderag.document ORDER BY extension`,
      );
      expect(documents.rows).toHaveLength(5);
      expect(new Set(documents.rows.map(({ extension }) => extension))).toEqual(
        new Set(['md', 'txt', 'pdf', 'docx', 'xlsx']),
      );
      expect(documents.rows.every(({ state }) => state === 'ready')).toBe(true);

      for (const testCase of golden.cases) {
        const siloId = siloIds.get(testCase.silo);
        if (siloId === undefined) throw new Error('invalid_m12_case_silo');
        await pool.query(
          `INSERT INTO noderag.evaluation_case
             (external_id,silo_id,query,query_class,expected_format,answerable,relevant,
              curation_state,reviewed_at,reviewed_by,created_by,updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,'approved',now(),$8,$8,$8)`,
          [
            testCase.id,
            siloId,
            testCase.query.normalize('NFC'),
            testCase.queryClass,
            testCase.expectedFormat,
            testCase.answerable,
            JSON.stringify(testCase.relevant),
            administratorId,
          ],
        );
      }
      const queued = await app.inject({
        method: 'POST',
        url: '/v1/admin/evaluation',
        headers: {
          cookie,
          origin: 'http://noderag.test',
          'x-csrf-token': csrf,
          'idempotency-key': 'm12-corpus-evaluation',
        },
        payload: {
          action: 'queue_run',
          modes: ['vector', 'keyword', 'hybrid'],
          workload: 'idle',
          environment: {
            suite: 'm12-measured-corpus',
            embedder: useRealModel ? `qwen3-${modelVariant}` : 'deterministic-ci',
          },
        },
      });
      expect(queued.statusCode, queued.body).toBe(202);
      for (const mode of ['vector', 'keyword', 'hybrid']) {
        expect(
          await processOneEvaluationRun({
            pool,
            embedder,
            files,
            leaseOwner: `m12-${mode}`,
          }),
        ).toBe(true);
      }
      if (modelVariant !== 'q4') {
        const allSiloIds = [...siloIds.values()].sort((left, right) => left - right);
        const activeModel = await pool.query<{ id: number }>(
          `SELECT id FROM noderag.model_manifest WHERE active`,
        );
        const modelManifestId = activeModel.rows[0]?.id;
        if (modelManifestId === undefined) throw new Error('m12_active_model_missing');
        const queueCandidate = async (candidate: string) => {
          const response = await app.inject({
            method: 'POST',
            url: '/v1/admin/evaluation',
            headers: {
              cookie,
              origin: 'http://noderag.test',
              'x-csrf-token': csrf,
              'idempotency-key': `m12-candidate-${candidate}`,
            },
            payload: {
              action: 'queue_run',
              modes: ['vector'],
              workload: 'idle',
              environment: { suite: 'm12-candidate-matrix', candidate },
            },
          });
          expect(response.statusCode, response.body).toBe(202);
          expect(
            await processOneEvaluationRun({
              pool,
              embedder,
              files,
              leaseOwner: `m12-candidate-${candidate}`,
            }),
          ).toBe(true);
        };
        const profiles = [
          { id: 'profile-1200-200', targetChars: 1200, overlapChars: 200, headingPrefix: true },
          { id: 'profile-3000-400', targetChars: 3000, overlapChars: 400, headingPrefix: true },
          { id: 'heading-prefix-off', targetChars: 2000, overlapChars: 300, headingPrefix: false },
        ];
        for (const [index, profile] of profiles.entries()) {
          const proposal = await withTransaction(pool, (database) =>
            createRebuildProposal(database, {
              modelManifestId,
              targetChars: profile.targetChars,
              overlapChars: profile.overlapChars,
              maxTokens: 1024,
              snapWindow: 0.15,
              headingPrefix: profile.headingPrefix,
              rulesVersion: index + 2,
              siloIds: allSiloIds,
              reason: `M12 candidate ${profile.id}`,
              createdBy: administratorId,
              embeddingCharactersPerSecond: 10_000,
              availableBytes: 100n * 1024n ** 3n,
              freeSpaceReserveBytes: 10n * 1024n ** 3n,
            }),
          );
          const confirmed = await withTransaction(pool, (database) =>
            confirmRebuildProposal(database, Number(proposal['id']), administratorId),
          );
          expect(
            await drainDocumentJobs({
              pool,
              files,
              embedder,
              leaseOwner: `m12-build-${profile.id}`,
            }),
          ).toBe(5);
          for (const siloId of allSiloIds) {
            const verification = await verifyStagedSilo(
              pool,
              confirmed.buildId,
              siloId,
              administratorId,
            );
            expect(verification.state).toBe('passed');
          }
          const activationId = await activateVerifiedBuild(
            pool,
            confirmed.buildId,
            allSiloIds,
            administratorId,
          );
          await queueCandidate(profile.id);
          await rollbackBuildActivation(pool, activationId, administratorId);
        }
        for (const efSearch of [50, 200]) {
          await pool.query(`UPDATE noderag.settings SET ef_search=$1,updated_at=now() WHERE id=1`, [
            efSearch,
          ]);
          await queueCandidate(`ef-search-${String(efSearch)}`);
        }
        await pool.query(`UPDATE noderag.settings SET ef_search=100,updated_at=now() WHERE id=1`);
        const backgroundQueued = await app.inject({
          method: 'POST',
          url: '/v1/admin/evaluation',
          headers: {
            cookie,
            origin: 'http://noderag.test',
            'x-csrf-token': csrf,
            'idempotency-key': 'm12-background-evaluation',
          },
          payload: {
            action: 'queue_run',
            modes: ['vector'],
            workload: 'ingest',
            environment: {
              suite: 'm12-background-load',
              embedder: useRealModel ? `qwen3-${modelVariant}` : 'deterministic-ci',
            },
          },
        });
        expect(backgroundQueued.statusCode, backgroundQueued.body).toBe(202);
        const platformId = siloIds.get('platform');
        if (platformId === undefined) throw new Error('m12_platform_silo_missing');
        const loadBody = await readFile(join(corpusRoot, 'platform-policy.md'));
        for (let index = 0; index < 5; index += 1) {
          const body = multipart(`load-${String(index)}.md`, 'text/markdown', loadBody);
          const uploaded = await app.inject({
            method: 'POST',
            url: `/v1/documents?siloId=${String(platformId)}`,
            headers: {
              cookie,
              origin: 'http://noderag.test',
              'x-csrf-token': csrf,
              'idempotency-key': `m12-load-${String(index)}`,
              'content-type': body.contentType,
            },
            payload: body.payload,
          });
          expect(uploaded.statusCode, uploaded.body).toBe(202);
        }
        const [backgroundJobs, backgroundRun] = await Promise.all([
          drainDocumentJobs({
            pool,
            files,
            embedder,
            leaseOwner: 'm12-background-ingest',
          }),
          processOneEvaluationRun({
            pool,
            embedder,
            files,
            leaseOwner: 'm12-background-evaluation',
          }),
        ]);
        expect(backgroundJobs).toBe(10);
        expect(backgroundRun).toBe(true);
      }
      const runs = await pool.query<{
        id: string;
        mode: string;
        state: string;
        case_count: number;
        metrics: Record<string, unknown>;
        failure_code: string | null;
      }>(
        `SELECT id::text,mode,state,case_count,metrics,failure_code
           FROM noderag.evaluation_run ORDER BY id`,
      );
      expect(runs.rows).toHaveLength(modelVariant === 'q4' ? 3 : 9);
      expect(
        runs.rows.every(({ state, case_count }) => state === 'succeeded' && case_count === 60),
      ).toBe(true);
      const observations = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM noderag.evaluation_observation`,
      );
      expect(Number(observations.rows[0]?.count)).toBe(modelVariant === 'q4' ? 180 : 540);
      for (const run of runs.rows) {
        expect(Object.keys(run.metrics['byFormat'] as object).sort()).toEqual([
          'docx',
          'md',
          'pdf',
          'txt',
          'xlsx',
        ]);
      }
      const diagnostics = await pool.query(
        `SELECT run.mode,evaluation.external_id AS "caseId",evaluation.relevant,
                observation.hits,observation.gains,
                observation.locator_mismatch_count AS "locatorMismatchCount"
           FROM noderag.evaluation_observation observation
           JOIN noderag.evaluation_run run ON run.id=observation.run_id
           JOIN noderag.evaluation_case evaluation ON evaluation.id=observation.case_id
          WHERE evaluation.expected_format='xlsx'
          ORDER BY run.id,evaluation.id LIMIT 3`,
      );

      const report = {
        version: 1,
        environment: useRealModel
          ? `docker-testbed-qwen3-${modelVariant}`
          : 'docker-testbed-deterministic',
        corpus: 'm12-project-golden-v1',
        cases: golden.cases.length,
        runs: runs.rows.map((run, index) => ({
          candidate:
            [
              'vector-default',
              'keyword',
              'hybrid',
              'profile-1200-200',
              'profile-3000-400',
              'heading-prefix-off',
              'ef-search-50',
              'ef-search-200',
              'vector-under-ingest',
            ][index] ?? `run-${String(index + 1)}`,
          ...run,
        })),
        diagnostics: diagnostics.rows,
      };
      const reportPath = process.env['NODERAG_M12_REPORT']?.trim();
      if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      if (process.env['NODERAG_M12_REQUIRE_GATE'] === '1') {
        expect(
          runs.rows.every(
            ({ metrics }) => (metrics['gate'] as { passed?: boolean } | undefined)?.passed === true,
          ),
          JSON.stringify(report, null, 2),
        ).toBe(true);
      }
    },
    useRealModel ? 1_800_000 : 120_000,
  );
});
