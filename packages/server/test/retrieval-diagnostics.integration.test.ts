import { performance } from 'node:perf_hooks';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFirstAdministrator, issueSetupToken } from '../src/setup/bootstrap.js';
import { runMigrations } from '../src/store/migrations.js';
import { createSilo } from '../src/store/silos.js';
import {
  annRecallAtK,
  decideChunkRls,
  recordAnnDiagnostic,
  recordRlsDiagnostic,
} from '../src/search/diagnostics.js';

const postgresImage =
  'pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';
const measurementQueryRepetitions = 10;

const percentile = (values: readonly number[], quantile: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
};

const queryVector = (siloId: number, ordinal: number): string =>
  `[${[
    Math.cos(ordinal / 37),
    Math.sin(ordinal / 37),
    Math.cos(ordinal / 113),
    Math.sin(ordinal / 113),
    siloId / 8,
    ...Array.from({ length: 1019 }, () => 0),
  ].join(',')}]`;

describe.sequential('M08 measured ANN and RLS gates', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let administratorId: number;
  let targetSilo: number;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(postgresImage)
      .withDatabase('noderag_m08_diagnostics')
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
      username: 'm08-benchmark-admin',
      password: 'M08-benchmark-password!',
    });
    administratorId = setup.principalId;
    const siloIds = [setup.defaultSilo.id];
    for (let index = 1; index < 8; index += 1) {
      siloIds.push(
        (
          await createSilo(pool, {
            slug: `bench-${String(index)}`,
            displayName: `Benchmark ${String(index)}`,
            creatingPrincipalId: administratorId,
          })
        ).id,
      );
    }
    targetSilo = siloIds[3] as number;
    for (const siloId of siloIds) {
      const chunkCount = siloId === targetSilo ? 5000 : 500;
      const document = await pool.query<{ id: string }>(
        `INSERT INTO noderag.document
           (silo_id,name,title,extension,mime_type,relative_path,byte_count,
            original_sha256,markdown_sha256,character_count,page_count,page_basis,
            offsets_match_original,state,indexed_at)
         VALUES($1,$2,$2,'md','text/markdown',$2,100000,
                decode(repeat('ab',32),'hex'),decode(repeat('cd',32),'hex'),
                100000,1,'none',true,'ready',now()) RETURNING id::text`,
        [siloId, `benchmark-${String(siloId)}.md`],
      );
      const documentId = document.rows[0]?.id;
      if (documentId === undefined) throw new Error('Synthetic document insertion failed.');
      await pool.query(
        `INSERT INTO noderag.chunk
           (silo_id,document_id,build_id,ordinal,text,character_start,character_end,
            byte_start,byte_end,embedding,token_count,chunk_sha256,part_of)
         SELECT $1::smallint,$2::bigint,b.id,g-1,'benchmark passage '||g,
                (g-1)*200,(g-1)*200+180,(g-1)*200,(g-1)*200+180,
                (ARRAY[
                  cos(g::double precision/37)::real,
                  sin(g::double precision/37)::real,
                  cos(g::double precision/113)::real,
                  sin(g::double precision/113)::real,
                  ($1::smallint)::real/8
                ] || array_fill(0::real,ARRAY[1019]))::halfvec,
                40,decode(md5(($1::smallint)::text||':'||g::text)||md5(g::text||':'||($1::smallint)::text),'hex'),
                'document'
         FROM generate_series(1,$3::integer) g
         CROSS JOIN LATERAL (SELECT id FROM noderag.build WHERE state='active') b`,
        [siloId, documentId, chunkCount],
      );
    }
    await pool.query('ANALYZE noderag.chunk');
    await pool.query('CREATE ROLE noderag_benchmark NOLOGIN');
    await pool.query('GRANT USAGE ON SCHEMA noderag TO noderag_benchmark');
    await pool.query('GRANT SELECT ON noderag.chunk TO noderag_benchmark');
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  const scopedQuery = async (
    client: PoolClient,
    role: boolean,
    explain = false,
    measure = false,
  ): Promise<{
    readonly elapsedMs: number;
    readonly rows: readonly { id: string }[];
    readonly plan?: unknown;
  }> => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.silo_ids',$1,true)`, [`{${String(targetSilo)}}`]);
      if (role) await client.query('SET LOCAL ROLE noderag_benchmark');
      await client.query('SET LOCAL enable_seqscan=off');
      await client.query('SET LOCAL enable_bitmapscan=off');
      await client.query(`SELECT set_config('hnsw.ef_search','100',true)`);
      const prefix = explain
        ? 'EXPLAIN (FORMAT JSON) '
        : measure
          ? 'EXPLAIN (ANALYZE, TIMING OFF, SUMMARY ON, FORMAT JSON) '
          : '';
      const started = performance.now();
      const query = `${prefix}SELECT id::text FROM noderag.chunk
         WHERE silo_id=$2 ORDER BY embedding <=> $1::halfvec LIMIT 10`;
      const parameters = [queryVector(targetSilo, 375), targetSilo];
      let result = await client.query(query, parameters);
      const executionTimes: number[] = [];
      if (measure) {
        for (let repeat = 0; repeat < measurementQueryRepetitions; repeat += 1) {
          if (repeat > 0) result = await client.query(query, parameters);
          const plan = result.rows[0]?.['QUERY PLAN'] as
            readonly [{ readonly 'Execution Time'?: number }] | undefined;
          executionTimes.push(plan?.[0]?.['Execution Time'] ?? Number.NaN);
        }
      }
      const elapsedMs = measure
        ? executionTimes.reduce((sum, value) => sum + value, 0) / executionTimes.length
        : performance.now() - started;
      if (!Number.isFinite(elapsedMs)) throw new Error('PostgreSQL did not report execution time.');
      await client.query('ROLLBACK');
      return explain
        ? { elapsedMs, rows: [], plan: result.rows[0]?.['QUERY PLAN'] }
        : { elapsedMs, rows: measure ? [] : (result.rows as { id: string }[]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  };

  it('records ANN recall against exact search and the measured chunk-RLS decision', async () => {
    const client = await pool.connect();
    try {
      for (let warm = 0; warm < 10; warm += 1) {
        await scopedQuery(client, warm % 2 === 0, false, true);
      }
      const rlsOn: number[] = [];
      const rlsOff: number[] = [];
      for (let sample = 0; sample < 80; sample += 1) {
        const firstRole = sample % 2 === 0;
        const first = await scopedQuery(client, firstRole, false, true);
        const second = await scopedQuery(client, !firstRole, false, true);
        (firstRole ? rlsOn : rlsOff).push(first.elapsedMs);
        (firstRole ? rlsOff : rlsOn).push(second.elapsedMs);
      }
      const explained = await scopedQuery(client, true, true);
      const measurement = {
        rlsOnP95Ms: percentile(rlsOn, 0.95),
        rlsOffP95Ms: percentile(rlsOff, 0.95),
        plan: explained.plan,
      };
      const decision = decideChunkRls(measurement);
      expect(decision.partitionRetained, JSON.stringify(explained.plan)).toBe(true);
      expect(decision.indexRetained, JSON.stringify(explained.plan)).toBe(true);
      expect(decision.keepChunkRls, JSON.stringify({ measurement, decision })).toBe(true);

      const ann = await scopedQuery(client, true);
      await client.query('BEGIN');
      let exact;
      try {
        await client.query(`SELECT set_config('app.silo_ids',$1,true)`, [
          `{${String(targetSilo)}}`,
        ]);
        await client.query('SET LOCAL ROLE noderag_benchmark');
        await client.query('SET LOCAL enable_indexscan=off');
        await client.query('SET LOCAL enable_bitmapscan=off');
        exact = await client.query<{ id: string }>(
          `SELECT id::text FROM noderag.chunk WHERE silo_id=$2
           ORDER BY embedding <=> $1::halfvec LIMIT 10`,
          [queryVector(targetSilo, 375), targetSilo],
        );
        await client.query('ROLLBACK');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      const recall = annRecallAtK(
        ann.rows.map(({ id }) => id),
        exact.rows.map(({ id }) => id),
        10,
      );
      expect(recall).toBeGreaterThanOrEqual(0.9);
      await withDiagnosticTransaction(pool, async (database) => {
        await recordRlsDiagnostic(database, administratorId, measurement);
        await recordAnnDiagnostic(
          database,
          administratorId,
          ann.rows.map(({ id }) => id),
          exact.rows.map(({ id }) => id),
          10,
        );
      });
      const recorded = await pool.query<{ kind: string; decision: string }>(
        `SELECT kind,decision FROM noderag.retrieval_diagnostic ORDER BY id`,
      );
      expect(recorded.rows.map(({ kind }) => kind)).toEqual(['rls_benchmark', 'ann_recall']);
      console.info(
        JSON.stringify({
          fixture: {
            silos: 8,
            targetSiloChunks: 5000,
            otherSiloChunks: 500,
            totalChunks: 8500,
            resultSize: 10,
            samples: 160,
            measurementQueryRepetitions,
          },
          measurement: { rlsOnP95Ms: measurement.rlsOnP95Ms, rlsOffP95Ms: measurement.rlsOffP95Ms },
          decision,
          annRecallAt10: recall,
        }),
      );
    } finally {
      client.release();
    }
  }, 120_000);
});

const withDiagnosticTransaction = async (
  pool: Pool,
  work: (database: PoolClient) => Promise<void>,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
