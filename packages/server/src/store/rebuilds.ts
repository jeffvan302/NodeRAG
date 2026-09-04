import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { databaseInteger, withTransaction, type SqlClient } from './database.js';
import { withHnswBuildResource } from './resources.js';

const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/u;

const identifier = (value: string): string => {
  if (!identifierPattern.test(value)) throw new Error('invalid-rebuild-table');
  return value;
};

const positiveSmallId = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32_767) {
    throw new Error(`invalid-${label}`);
  }
  return value;
};

const sortedSiloIds = (values: readonly number[]): readonly number[] => {
  const result = [...new Set(values.map((value) => positiveSmallId(value, 'silo-id')))].sort(
    (left, right) => left - right,
  );
  if (result.length === 0) throw new Error('rebuild-silos-required');
  return result;
};

export interface RebuildEstimateInput {
  readonly sourceCharacters: bigint;
  readonly documentCount: bigint;
  readonly reusableCharacters: bigint;
  readonly reusableVisionArtifacts: bigint;
  readonly targetChars: number;
  readonly overlapChars: number;
  readonly dimensions: number;
  readonly embeddingCharactersPerSecond: number;
  readonly availableBytes: bigint;
  readonly freeSpaceReserveBytes: bigint;
}

export interface RebuildEstimate {
  readonly sourceCharacters: bigint;
  readonly expectedChunks: bigint;
  readonly estimatedEmbeddingSeconds: bigint;
  readonly estimatedVisionReuse: bigint;
  readonly temporaryBytes: bigint;
  readonly requiredFreeBytes: bigint;
  readonly availableBytes: bigint;
  readonly fits: boolean;
}

export const calculateRebuildEstimate = (input: RebuildEstimateInput): RebuildEstimate => {
  if (
    input.sourceCharacters < 0n ||
    input.documentCount < 0n ||
    input.reusableCharacters < 0n ||
    input.reusableCharacters > input.sourceCharacters ||
    input.reusableVisionArtifacts < 0n ||
    !Number.isSafeInteger(input.targetChars) ||
    input.targetChars < 200 ||
    !Number.isSafeInteger(input.overlapChars) ||
    input.overlapChars < 0 ||
    input.overlapChars > input.targetChars / 2 ||
    !Number.isSafeInteger(input.dimensions) ||
    input.dimensions < 1 ||
    !Number.isFinite(input.embeddingCharactersPerSecond) ||
    input.embeddingCharactersPerSecond <= 0 ||
    input.availableBytes < 0n ||
    input.freeSpaceReserveBytes < 0n
  ) {
    throw new Error('invalid-rebuild-estimate-input');
  }
  const stride = BigInt(input.targetChars - input.overlapChars);
  const expectedChunks =
    input.sourceCharacters === 0n ? 0n : (input.sourceCharacters + stride - 1n) / stride;
  const charactersToEmbed = input.sourceCharacters - input.reusableCharacters;
  const throughput = BigInt(Math.max(1, Math.floor(input.embeddingCharactersPerSecond)));
  const estimatedEmbeddingSeconds =
    charactersToEmbed === 0n ? 0n : (charactersToEmbed + throughput - 1n) / throughput;
  const vectorBytes = BigInt(input.dimensions * 2);
  const rowAndIndexBytes = vectorBytes + 1536n;
  const temporaryBytes =
    expectedChunks * rowAndIndexBytes + input.sourceCharacters * 2n + input.documentCount * 4096n;
  const requiredFreeBytes = temporaryBytes + input.freeSpaceReserveBytes;
  return {
    sourceCharacters: input.sourceCharacters,
    expectedChunks,
    estimatedEmbeddingSeconds,
    estimatedVisionReuse: input.reusableVisionArtifacts,
    temporaryBytes,
    requiredFreeBytes,
    availableBytes: input.availableBytes,
    fits: input.availableBytes >= requiredFreeBytes,
  };
};

export interface RebuildProposalInput {
  readonly modelManifestId: number;
  readonly targetChars: number;
  readonly overlapChars: number;
  readonly maxTokens: number;
  readonly snapWindow: number;
  readonly headingPrefix: boolean;
  readonly rulesVersion: number;
  readonly siloIds: readonly number[];
  readonly reason: string;
  readonly createdBy: number;
  readonly embeddingCharactersPerSecond: number;
  readonly availableBytes: bigint;
  readonly freeSpaceReserveBytes: bigint;
}

interface ProposalRecord {
  readonly id: unknown;
  readonly model_manifest_id: unknown;
  readonly target_chars: number;
  readonly overlap_chars: number;
  readonly max_tokens: number;
  readonly snap_window: string | number;
  readonly heading_prefix: boolean;
  readonly rules_version: number;
  readonly silo_ids: number[];
  readonly reason: string;
  readonly query_prefix: string;
  readonly manifest_digest: string;
  readonly dimensions: number;
  readonly state: string;
  readonly expires_at: Date;
}

const jsonSafeEstimate = (estimate: RebuildEstimate): Readonly<Record<string, unknown>> => ({
  sourceCharacters: estimate.sourceCharacters.toString(),
  expectedChunks: estimate.expectedChunks.toString(),
  estimatedEmbeddingSeconds: estimate.estimatedEmbeddingSeconds.toString(),
  estimatedVisionReuse: estimate.estimatedVisionReuse.toString(),
  temporaryBytes: estimate.temporaryBytes.toString(),
  requiredFreeBytes: estimate.requiredFreeBytes.toString(),
  availableBytes: estimate.availableBytes.toString(),
  fits: estimate.fits,
});

export const createRebuildProposal = async (
  database: SqlClient,
  input: RebuildProposalInput,
): Promise<Readonly<Record<string, unknown>>> => {
  const siloIds = sortedSiloIds(input.siloIds);
  const modelManifestId = positiveSmallId(input.modelManifestId, 'model-manifest-id');
  const statistics = await database.query<{
    source_characters: string;
    document_count: string;
    reusable_characters: string;
    reusable_vision_artifacts: string;
    dimensions: number;
    manifest_digest: string;
  }>(
    `SELECT statistics.source_characters,statistics.document_count,
            reusable.reusable_characters,vision.reusable_vision_artifacts,
            model.dimensions,model.manifest_digest
     FROM noderag.model_manifest model
     CROSS JOIN LATERAL (
       SELECT COALESCE(sum(d.character_count),0)::text AS source_characters,
              count(*)::text AS document_count
       FROM noderag.document d
       WHERE d.silo_id=ANY($1::smallint[])
         AND d.state IN ('ready','source_missing','awaiting_vision')
     ) statistics
     CROSS JOIN LATERAL (
       SELECT COALESCE(sum(length(c.text)),0)::text AS reusable_characters
       FROM noderag.chunk c
       JOIN noderag.embedding_cache cache
         ON cache.chunk_sha256=c.chunk_sha256 AND cache.model_manifest_id=model.id
       WHERE c.silo_id=ANY($1::smallint[])
     ) reusable
     CROSS JOIN LATERAL (
       SELECT count(*) FILTER (WHERE image.cache_key IS NOT NULL)::text
                AS reusable_vision_artifacts
       FROM noderag.document_image image WHERE image.silo_id=ANY($1::smallint[])
     ) vision
     WHERE model.id=$2`,
    [siloIds, modelManifestId],
  );
  const row = statistics.rows[0];
  if (row === undefined) throw new Error('model-manifest-not-found');
  const sourceCharacters = BigInt(row.source_characters);
  const reusableCharacters = BigInt(row.reusable_characters);
  const estimate = calculateRebuildEstimate({
    sourceCharacters,
    documentCount: BigInt(row.document_count),
    reusableCharacters:
      reusableCharacters > sourceCharacters ? sourceCharacters : reusableCharacters,
    reusableVisionArtifacts: BigInt(row.reusable_vision_artifacts),
    targetChars: input.targetChars,
    overlapChars: input.overlapChars,
    dimensions: row.dimensions,
    embeddingCharactersPerSecond: input.embeddingCharactersPerSecond,
    availableBytes: input.availableBytes,
    freeSpaceReserveBytes: input.freeSpaceReserveBytes,
  });
  const created = await database.query<{ id: unknown; expires_at: Date }>(
    `INSERT INTO noderag.rebuild_proposal
       (model_manifest_id, target_chars, overlap_chars, max_tokens, snap_window,
        heading_prefix, rules_version, silo_ids, source_characters, expected_chunks,
        estimated_embedding_seconds, estimated_vision_reuse, temporary_bytes,
        required_free_bytes, available_bytes, estimate_inputs, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id, expires_at`,
    [
      modelManifestId,
      input.targetChars,
      input.overlapChars,
      input.maxTokens,
      input.snapWindow,
      input.headingPrefix,
      input.rulesVersion,
      siloIds,
      estimate.sourceCharacters.toString(),
      estimate.expectedChunks.toString(),
      estimate.estimatedEmbeddingSeconds.toString(),
      estimate.estimatedVisionReuse.toString(),
      estimate.temporaryBytes.toString(),
      estimate.requiredFreeBytes.toString(),
      estimate.availableBytes.toString(),
      {
        embeddingCharactersPerSecond: input.embeddingCharactersPerSecond,
        freeSpaceReserveBytes: input.freeSpaceReserveBytes.toString(),
        dimensions: row.dimensions,
        modelManifestDigest: row.manifest_digest,
      },
      input.reason,
      input.createdBy,
    ],
  );
  const inserted = created.rows[0];
  if (inserted === undefined) throw new Error('rebuild-proposal-not-created');
  return {
    id: databaseInteger(inserted.id, 'rebuild proposal id'),
    state: 'estimated',
    expiresAt: inserted.expires_at,
    ...jsonSafeEstimate(estimate),
  };
};

const stagingTable = (buildId: number, siloId: number): string =>
  identifier(`chunk_stage_b${String(buildId)}_s${String(siloId)}`);
const rollbackTable = (buildId: number, siloId: number): string =>
  identifier(`chunk_rollback_b${String(buildId)}_s${String(siloId)}`);
const activeTable = (siloId: number): string => identifier(`chunk_s${String(siloId)}`);
const dimensionParent = (buildId: number): string => identifier(`chunk_parent_b${String(buildId)}`);

const adjustActiveEmbeddingReferences = async (
  database: SqlClient,
  relation: string,
  siloId: number,
  buildId: number,
  delta: -1 | 1,
): Promise<void> => {
  const table = identifier(relation);
  const missing = await database.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM noderag.${table} chunk
     JOIN noderag.build build ON build.id=chunk.build_id
     LEFT JOIN noderag.embedding_cache cache
       ON cache.chunk_sha256=chunk.chunk_sha256
      AND cache.model_manifest_id=build.model_manifest_id
     WHERE chunk.silo_id=$1 AND chunk.build_id=$2
       AND cache.chunk_sha256 IS NULL`,
    [siloId, buildId],
  );
  if (Number(missing.rows[0]?.count ?? 0) !== 0) {
    throw new Error('build-embedding-cache-reference-missing');
  }
  await database.query(
    `WITH refs AS (
       SELECT chunk.chunk_sha256,build.model_manifest_id,count(*)::integer AS used
       FROM noderag.${table} chunk
       JOIN noderag.build build ON build.id=chunk.build_id
       WHERE chunk.silo_id=$1 AND chunk.build_id=$2
       GROUP BY chunk.chunk_sha256,build.model_manifest_id
     )
     UPDATE noderag.embedding_cache cache
     SET refcount=cache.refcount + refs.used * $3::integer,last_used_at=now()
     FROM refs
     WHERE cache.chunk_sha256=refs.chunk_sha256
       AND cache.model_manifest_id=refs.model_manifest_id`,
    [siloId, buildId, delta],
  );
};

const profileDigest = (proposal: ProposalRecord): string =>
  createHash('sha256')
    .update(
      [
        proposal.target_chars,
        proposal.overlap_chars,
        proposal.max_tokens,
        proposal.snap_window,
        proposal.heading_prefix,
        proposal.rules_version,
        proposal.model_manifest_id,
        proposal.query_prefix,
      ].join('\n'),
      'utf8',
    )
    .digest('hex');

const createDetachedStagingTable = async (
  database: SqlClient,
  buildId: number,
  siloId: number,
  dimensions: number,
): Promise<string> => {
  const table = stagingTable(buildId, siloId);
  await database.query(
    `CREATE TABLE noderag.${table}
       (LIKE noderag.chunk INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS)
     WITH (autovacuum_enabled = true)`,
  );
  await database.query(
    `ALTER TABLE noderag.${table}
       ALTER COLUMN embedding TYPE halfvec(${String(dimensions)}),
       ADD CONSTRAINT ${table}_silo_check CHECK (silo_id = ${String(siloId)}),
       ADD CONSTRAINT ${table}_build_check CHECK (build_id = ${String(buildId)})`,
  );
  return table;
};

export interface ConfirmedBuild {
  readonly buildId: number;
  readonly activationKind: 'same_model' | 'model_revision' | 'dimension_change';
  readonly siloIds: readonly number[];
  readonly queuedDocuments: number;
}

export const confirmRebuildProposal = async (
  database: SqlClient,
  proposalId: number,
  principalId: number,
): Promise<ConfirmedBuild> => {
  const proposal = await database.query<ProposalRecord>(
    `SELECT proposal.*, model.query_prefix, model.manifest_digest, model.dimensions
     FROM noderag.rebuild_proposal proposal
     JOIN noderag.model_manifest model ON model.id = proposal.model_manifest_id
     WHERE proposal.id = $1 FOR UPDATE OF proposal`,
    [proposalId],
  );
  const row = proposal.rows[0];
  if (row === undefined) throw new Error('rebuild-proposal-not-found');
  if (row.state !== 'estimated') throw new Error('rebuild-proposal-not-confirmable');
  if (row.expires_at.getTime() <= Date.now()) throw new Error('rebuild-proposal-expired');
  const capacity = await database.query<{ fits: boolean }>(
    'SELECT available_bytes >= required_free_bytes AS fits FROM noderag.rebuild_proposal WHERE id=$1',
    [proposalId],
  );
  if (capacity.rows[0]?.fits !== true) throw new Error('rebuild-capacity-insufficient');
  const siloIds = sortedSiloIds(row.silo_ids);
  const active = await database.query<{ model_manifest_id: unknown; dimensions: number }>(
    `SELECT DISTINCT b.model_manifest_id, b.dimensions
     FROM noderag.silo_build_state state
     JOIN noderag.build b ON b.id = state.build_id
     WHERE state.silo_id = ANY($1::smallint[]) AND state.state = 'active'`,
    [siloIds],
  );
  if (active.rows.length !== 1) throw new Error('active-build-model-inconsistent');
  const current = active.rows[0];
  if (current === undefined) throw new Error('active-build-missing');
  const currentModelId = databaseInteger(current.model_manifest_id, 'active model manifest id');
  const modelManifestId = databaseInteger(row.model_manifest_id, 'proposal model manifest id');
  const activationKind: ConfirmedBuild['activationKind'] =
    current.dimensions !== row.dimensions
      ? 'dimension_change'
      : currentModelId === modelManifestId
        ? 'same_model'
        : 'model_revision';
  if (activationKind !== 'same_model') {
    const allActive = await database.query<{ id: number }>(
      "SELECT id FROM noderag.silo WHERE lifecycle_state='active' ORDER BY id",
    );
    const allActiveIds = allActive.rows.map((item) => item.id);
    if (
      allActiveIds.length !== siloIds.length ||
      allActiveIds.some((siloId, index) => siloId !== siloIds[index])
    ) {
      throw new Error('model-change-requires-all-silos');
    }
  }
  const build = await database.query<{ id: unknown }>(
    `INSERT INTO noderag.build
       (state,target_chars,overlap_chars,max_tokens,snap_window,heading_prefix,rules_version,
        model_manifest_id,query_prefix,reason,profile_digest,model_digest,dimensions,
        activation_kind,proposal_id,confirmed_at,confirmed_by)
     VALUES ('building',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15)
     RETURNING id`,
    [
      row.target_chars,
      row.overlap_chars,
      row.max_tokens,
      row.snap_window,
      row.heading_prefix,
      row.rules_version,
      modelManifestId,
      row.query_prefix,
      row.reason,
      profileDigest(row),
      row.manifest_digest,
      row.dimensions,
      activationKind,
      proposalId,
      principalId,
    ],
  );
  const buildId = databaseInteger(build.rows[0]?.id, 'build id');
  let queuedDocuments = 0;
  for (const siloId of siloIds) {
    const table = await createDetachedStagingTable(database, buildId, siloId, row.dimensions);
    const documents = await database.query<{ id: unknown }>(
      `SELECT id FROM noderag.document
       WHERE silo_id=$1 AND state IN ('ready','source_missing','awaiting_vision')
       ORDER BY id`,
      [siloId],
    );
    await database.query(
      `INSERT INTO noderag.silo_build_state
         (silo_id,build_id,state,staging_table,total_documents)
       VALUES ($1,$2,'building',$3,$4)`,
      [siloId, buildId, table, documents.rows.length],
    );
    for (const document of documents.rows) {
      await database.query(
        `INSERT INTO noderag.job
           (kind,document_id,silo_id,build_id,priority,payload,frozen_config)
         VALUES ('embed',$1,$2,$3,8,
                 jsonb_build_object('reason','rebuild','stagingTable',$4::text),
                 jsonb_build_object('schemaRevision','000009_zero_downtime_rebuilds',
                                    'buildId',$3::smallint,'stagingTable',$4::text))`,
        [databaseInteger(document.id, 'document id'), siloId, buildId, table],
      );
      queuedDocuments += 1;
    }
  }
  await database.query(
    `UPDATE noderag.rebuild_proposal
     SET state='confirmed',confirmed_at=now(),confirmed_by=$2 WHERE id=$1`,
    [proposalId, principalId],
  );
  await database.query(
    `INSERT INTO noderag.audit_log(principal_id,action,result,detail)
     VALUES($1,'build.confirm','ok',jsonb_build_object('proposalId',$2::bigint,
            'buildId',$3::int,'activationKind',$4::text,'queuedDocuments',$5::int))`,
    [principalId, proposalId, buildId, activationKind, queuedDocuments],
  );
  return { buildId, activationKind, siloIds, queuedDocuments };
};

export type MutableBuildAction = 'pause' | 'resume' | 'cancel';

export const changeBuildState = async (
  database: SqlClient,
  buildId: number,
  action: MutableBuildAction,
  principalId: number,
): Promise<void> => {
  const next = action === 'pause' ? 'paused' : action === 'resume' ? 'building' : 'cancelled';
  const allowed = action === 'resume' ? ['paused'] : ['building', 'paused'];
  const updated = await database.query(
    `UPDATE noderag.build SET state=$2
     WHERE id=$1 AND state=ANY($3::text[])`,
    [buildId, next, allowed],
  );
  if (updated.rowCount !== 1) throw new Error('build-not-mutable');
  await database.query(
    `UPDATE noderag.silo_build_state SET state=$2,updated_at=now()
     WHERE build_id=$1 AND state IN ('pending','building','paused')`,
    [buildId, next === 'building' ? 'building' : next],
  );
  if (action === 'pause') {
    await database.query(
      `UPDATE noderag.job SET state='paused',updated_at=now()
       WHERE build_id=$1 AND state IN ('pending','retry_wait')`,
      [buildId],
    );
  } else if (action === 'resume') {
    await database.query(
      `UPDATE noderag.job SET state='pending',run_after=now(),updated_at=now()
       WHERE build_id=$1 AND state='paused'`,
      [buildId],
    );
  } else {
    await database.query(
      `UPDATE noderag.job
       SET state=CASE WHEN state='leased' THEN state ELSE 'cancelled' END,
           cancel_requested_at=CASE WHEN state='leased' THEN now() ELSE cancel_requested_at END,
           finished_at=CASE WHEN state='leased' THEN finished_at ELSE now() END,
           updated_at=now()
       WHERE build_id=$1 AND state IN ('pending','retry_wait','paused','leased')`,
      [buildId],
    );
  }
  await database.query(
    `INSERT INTO noderag.audit_log(principal_id,action,result,detail)
     VALUES($1,'build.control','ok',jsonb_build_object('buildId',$2::int,'action',$3::text))`,
    [principalId, buildId, action],
  );
};

export const discardBuildCheckpoints = async (
  database: SqlClient,
  buildId: number,
  confirmation: string,
  principalId: number,
): Promise<number> => {
  if (confirmation !== `DISCARD BUILD ${String(buildId)} CHECKPOINTS`) {
    throw new Error('checkpoint-confirmation-mismatch');
  }
  const state = await database.query<{ state: string }>(
    'SELECT state FROM noderag.build WHERE id=$1',
    [buildId],
  );
  if (!['cancelled', 'failed'].includes(state.rows[0]?.state ?? '')) {
    throw new Error('checkpoint-discard-not-allowed');
  }
  const removed = await database.query(
    'DELETE FROM noderag.build_document_checkpoint WHERE build_id=$1',
    [buildId],
  );
  await database.query(
    `INSERT INTO noderag.audit_log(principal_id,action,result,detail)
     VALUES($1,'build.checkpoint_discard','ok',
            jsonb_build_object('buildId',$2::int,'removed',$3::int))`,
    [principalId, buildId, removed.rowCount ?? 0],
  );
  return removed.rowCount ?? 0;
};

export interface BuildVerificationResult {
  readonly verificationId: number;
  readonly state: 'passed' | 'failed';
  readonly rowCount: number;
  readonly documentCount: number;
  readonly expectedDocuments: number;
  readonly currentDocuments: number;
  readonly sourceMismatches: number;
  readonly locatorMismatches: number;
  readonly dimensionMismatches: number;
  readonly nullOrNonfiniteVectors: number;
  readonly exactAnnRecall: number;
}

const sampledExactAnnRecall = async (
  database: SqlClient,
  table: string,
  dimensions: number,
): Promise<number> => {
  const anchors = await database.query<{ id: unknown; embedding: string }>(
    `SELECT id,embedding::text AS embedding
     FROM noderag.${table}
     WHERE embedding IS NOT NULL
     ORDER BY id LIMIT 5`,
  );
  if (anchors.rows.length === 0) return 1;
  const recalls: number[] = [];
  for (const anchor of anchors.rows) {
    const anchorId = databaseInteger(anchor.id, 'verification anchor id');
    await database.query('SET LOCAL enable_indexscan = off');
    await database.query('SET LOCAL enable_bitmapscan = off');
    await database.query('SET LOCAL enable_seqscan = on');
    const exact = await database.query<{ id: unknown; distance: number }>(
      `SELECT id,(embedding <=> $1::halfvec(${String(dimensions)}))::double precision AS distance
       FROM noderag.${table}
       WHERE embedding IS NOT NULL AND id<>$2
       ORDER BY embedding <=> $1::halfvec(${String(dimensions)}) LIMIT 10`,
      [anchor.embedding, anchorId],
    );
    await database.query('SET LOCAL enable_indexscan = on');
    await database.query('SET LOCAL enable_bitmapscan = on');
    await database.query('SET LOCAL enable_seqscan = off');
    await database.query('SET LOCAL hnsw.ef_search = 100');
    const approximate = await database.query<{ id: unknown; distance: number }>(
      `SELECT id,(embedding <=> $1::halfvec(${String(dimensions)}))::double precision AS distance
       FROM noderag.${table}
       WHERE embedding IS NOT NULL AND id<>$2
       ORDER BY embedding <=> $1::halfvec(${String(dimensions)}) LIMIT 10`,
      [anchor.embedding, anchorId],
    );
    const expected = new Set(exact.rows.map((item) => databaseInteger(item.id, 'exact id')));
    if (expected.size === 0) {
      recalls.push(1);
      continue;
    }
    const exactCutoff = Math.max(...exact.rows.map((item) => Number(item.distance)));
    const matches = approximate.rows.reduce((total, item) => {
      const exactId = expected.has(databaseInteger(item.id, 'approximate id'));
      const equallyGoodTie = Number(item.distance) <= exactCutoff + 1e-12;
      return total + (exactId || equallyGoodTie ? 1 : 0);
    }, 0);
    recalls.push(matches / expected.size);
  }
  await database.query('SET LOCAL enable_seqscan = on');
  return recalls.reduce((total, value) => total + value, 0) / recalls.length;
};

export const verifyStagedSilo = async (
  pool: Pool,
  buildId: number,
  siloId: number,
  principalId: number,
): Promise<BuildVerificationResult> => {
  const state = await pool.query<{
    staging_table: string;
    dimensions: number;
    total_documents: string;
  }>(
    `SELECT state.staging_table,b.dimensions,state.total_documents::text
     FROM noderag.silo_build_state state JOIN noderag.build b ON b.id=state.build_id
     WHERE state.build_id=$1 AND state.silo_id=$2
       AND state.state IN ('building','indexing','verifying','ready')`,
    [buildId, siloId],
  );
  const row = state.rows[0];
  if (row === undefined) throw new Error('staged-silo-not-verifiable');
  const table = identifier(row.staging_table);
  await pool.query(
    `UPDATE noderag.silo_build_state SET state='indexing',updated_at=now()
     WHERE build_id=$1 AND silo_id=$2`,
    [buildId, siloId],
  );
  await withHnswBuildResource(pool, `build:${String(buildId)}:silo:${String(siloId)}`, async () => {
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${table}_embedding_hnsw_idx ON noderag.${table}
       USING hnsw (embedding halfvec_cosine_ops) WITH (m=16,ef_construction=64)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${table}_search_vector_gin_idx
       ON noderag.${table} USING gin(search_vector)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${table}_document_ordinal_idx
       ON noderag.${table}(document_id,ordinal)`,
    );
  });
  return withTransaction(pool, async (database) => {
    await database.query(
      `UPDATE noderag.silo_build_state SET state='verifying',updated_at=now()
       WHERE build_id=$1 AND silo_id=$2`,
      [buildId, siloId],
    );
    const checks = await database.query<{
      row_count: string;
      document_count: string;
      locator_mismatches: string;
      dimension_mismatches: string;
      null_or_nonfinite_vectors: string;
    }>(
      `SELECT count(*)::text AS row_count,
              count(DISTINCT document_id)::text AS document_count,
              count(*) FILTER (WHERE character_end <= character_start
                                OR byte_end <= byte_start
                                OR (page_end IS NOT NULL AND page_start IS NULL)
                                OR (page_end IS NOT NULL AND page_end < page_start))::text
                AS locator_mismatches,
              count(*) FILTER (WHERE vector_dims(embedding) <> $1)::text AS dimension_mismatches,
              count(*) FILTER (WHERE embedding IS NULL
                                OR embedding::text ~ '(NaN|Infinity)')::text
                AS null_or_nonfinite_vectors
       FROM noderag.${table}`,
      [row.dimensions],
    );
    const values = checks.rows[0];
    if (values === undefined) throw new Error('staged-verification-empty');
    const rowCount = Number(values.row_count);
    const documentCount = Number(values.document_count);
    const expectedDocuments = Number(row.total_documents);
    const sourceSnapshot = await database.query<{
      current_documents: string;
      source_mismatches: string;
    }>(
      `SELECT count(*)::text AS current_documents,
              count(*) FILTER (
                WHERE checkpoint.document_id IS NULL
                   OR checkpoint.state<>'complete'
                   OR checkpoint.markdown_sha256<>document.markdown_sha256
              )::text AS source_mismatches
       FROM noderag.document document
       LEFT JOIN noderag.build_document_checkpoint checkpoint
         ON checkpoint.build_id=$1 AND checkpoint.silo_id=document.silo_id
        AND checkpoint.document_id=document.id
       WHERE document.silo_id=$2
         AND document.state IN ('ready','source_missing','awaiting_vision')`,
      [buildId, siloId],
    );
    const currentDocuments = Number(sourceSnapshot.rows[0]?.current_documents ?? 0);
    const sourceMismatches = Number(sourceSnapshot.rows[0]?.source_mismatches ?? 0);
    const locatorMismatches = Number(values.locator_mismatches);
    const dimensionMismatches = Number(values.dimension_mismatches);
    const nullOrNonfiniteVectors = Number(values.null_or_nonfinite_vectors);
    const indexRows = await database.query<{
      indexname: string;
      indisvalid: boolean;
      indisready: boolean;
    }>(
      `SELECT index_class.relname AS indexname,index.indisvalid,index.indisready
       FROM pg_class table_class
       JOIN pg_namespace namespace ON namespace.oid=table_class.relnamespace
       JOIN pg_index index ON index.indrelid=table_class.oid
       JOIN pg_class index_class ON index_class.oid=index.indexrelid
       WHERE namespace.nspname='noderag' AND table_class.relname=$1`,
      [table],
    );
    const indexNames = new Set(
      indexRows.rows
        .filter((item) => item.indisvalid && item.indisready)
        .map((item) => item.indexname),
    );
    const indexesBuilt = [
      `${table}_embedding_hnsw_idx`,
      `${table}_search_vector_gin_idx`,
      `${table}_document_ordinal_idx`,
    ].every((name) => indexNames.has(name));
    const exactAnnRecall = await sampledExactAnnRecall(database, table, row.dimensions);
    const passed =
      documentCount === expectedDocuments &&
      currentDocuments === expectedDocuments &&
      sourceMismatches === 0 &&
      locatorMismatches === 0 &&
      dimensionMismatches === 0 &&
      nullOrNonfiniteVectors === 0 &&
      indexesBuilt &&
      exactAnnRecall >= 0.95;
    const inserted = await database.query<{ id: unknown }>(
      `INSERT INTO noderag.build_verification
         (build_id,silo_id,state,row_count,document_count,expected_documents,
          current_documents,source_mismatches,locator_mismatches,
          null_or_nonfinite_vectors,dimension_mismatches,exact_ann_recall,checks,verified_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        buildId,
        siloId,
        passed ? 'passed' : 'failed',
        rowCount,
        documentCount,
        expectedDocuments,
        currentDocuments,
        sourceMismatches,
        locatorMismatches,
        nullOrNonfiniteVectors,
        dimensionMismatches,
        exactAnnRecall,
        {
          partitionBound: true,
          indexesBuiltAfterPopulation: indexesBuilt,
          locatorVerifier: locatorMismatches === 0,
          documentCoverage: documentCount === expectedDocuments,
          currentDocumentCoverage: currentDocuments === expectedDocuments,
          sourceSnapshotCurrent: sourceMismatches === 0,
          vectorDimensions: dimensionMismatches === 0,
          finiteVectors: nullOrNonfiniteVectors === 0,
          sampledExactAnnRecall: exactAnnRecall,
        },
        principalId,
      ],
    );
    const verificationId = databaseInteger(inserted.rows[0]?.id, 'verification id');
    await database.query(
      `UPDATE noderag.silo_build_state
       SET state=$3,verification_id=$4,last_error=$5,updated_at=now()
       WHERE build_id=$1 AND silo_id=$2`,
      [
        buildId,
        siloId,
        passed ? 'ready' : 'failed',
        verificationId,
        passed ? null : 'staged-verification-failed',
      ],
    );
    return {
      verificationId,
      state: passed ? 'passed' : 'failed',
      rowCount,
      documentCount,
      expectedDocuments,
      currentDocuments,
      sourceMismatches,
      locatorMismatches,
      dimensionMismatches,
      nullOrNonfiniteVectors,
      exactAnnRecall,
    };
  });
};

interface ReadySilo {
  readonly silo_id: number;
  readonly staging_table: string;
  readonly old_build_id: unknown;
}

const prepareAttachedPartition = async (
  database: SqlClient,
  table: string,
  siloId: number,
): Promise<void> => {
  await database.query(`ALTER TABLE noderag.${table} ENABLE ROW LEVEL SECURITY`);
  await database.query(`ALTER TABLE noderag.${table} FORCE ROW LEVEL SECURITY`);
  await database.query(
    `CREATE POLICY ${table}_silo_scope ON noderag.${table}
     USING (silo_id = ANY(noderag.current_silo_ids()))
     WITH CHECK (silo_id = ANY(noderag.current_silo_ids()))`,
  );
  const parent = activeTable(siloId);
  await database.query(`ALTER TABLE noderag.${table} RENAME TO ${parent}`);
  await database.query(
    `ALTER TABLE noderag.chunk ATTACH PARTITION noderag.${parent}
     FOR VALUES IN (${String(siloId)})`,
  );
};

export const activateVerifiedBuild = async (
  pool: Pool,
  buildId: number,
  requestedSiloIds: readonly number[],
  principalId: number,
): Promise<number> =>
  withTransaction(pool, async (database) => {
    await database.query('SELECT pg_advisory_xact_lock($1::bigint)', [7_116_011_011]);
    const build = await database.query<{
      activation_kind: ConfirmedBuild['activationKind'];
      model_manifest_id: unknown;
      dimensions: number;
    }>(
      'SELECT activation_kind,model_manifest_id,dimensions FROM noderag.build WHERE id=$1 FOR UPDATE',
      [buildId],
    );
    const definition = build.rows[0];
    if (definition === undefined) throw new Error('build-not-found');
    const requested = sortedSiloIds(requestedSiloIds);
    const unresolved = await database.query(
      `SELECT 1 FROM noderag.build_activation_history
       WHERE state='rollback_available' AND activated_silos && $1::smallint[] LIMIT 1`,
      [requested],
    );
    if ((unresolved.rowCount ?? 0) > 0) throw new Error('prior-activation-requires-resolution');
    await database.query("SELECT set_config('app.silo_ids',$1,true)", [`{${requested.join(',')}}`]);
    const ready = await database.query<ReadySilo>(
      `SELECT next.silo_id,next.staging_table,active.build_id AS old_build_id
       FROM noderag.silo_build_state next
       JOIN noderag.silo_build_state active
         ON active.silo_id=next.silo_id AND active.state='active'
       JOIN noderag.build_verification verification ON verification.id=next.verification_id
       WHERE next.build_id=$1 AND next.silo_id=ANY($2::smallint[])
         AND next.state='ready' AND verification.state='passed'
       ORDER BY next.silo_id FOR UPDATE OF next,active`,
      [buildId, requested],
    );
    if (ready.rows.length !== requested.length) throw new Error('build-silos-not-ready');
    if (definition.activation_kind !== 'same_model') {
      const all = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM noderag.silo WHERE lifecycle_state='active'",
      );
      if (Number(all.rows[0]?.count ?? 0) !== requested.length) {
        throw new Error('model-change-requires-all-silos');
      }
    }
    const previousBuilds: Array<{ siloId: number; buildId: number; rollbackTable: string }> = [];
    if (definition.activation_kind === 'dimension_change') {
      const newParent = dimensionParent(buildId);
      await database.query(
        `CREATE TABLE noderag.${newParent}
           (LIKE noderag.chunk INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS)
         PARTITION BY LIST(silo_id)`,
      );
      await database.query(
        `ALTER TABLE noderag.${newParent}
         ALTER COLUMN embedding TYPE halfvec(${String(definition.dimensions)})`,
      );
      await database.query(`ALTER TABLE noderag.${newParent} ENABLE ROW LEVEL SECURITY`);
      await database.query(`ALTER TABLE noderag.${newParent} FORCE ROW LEVEL SECURITY`);
      await database.query(
        `CREATE POLICY ${newParent}_silo_scope ON noderag.${newParent}
         USING (silo_id=ANY(noderag.current_silo_ids()))
         WITH CHECK (silo_id=ANY(noderag.current_silo_ids()))`,
      );
      for (const item of ready.rows) {
        const table = identifier(item.staging_table);
        const oldBuildId = databaseInteger(item.old_build_id, 'old build id');
        const current = activeTable(item.silo_id);
        const rollback = rollbackTable(oldBuildId, item.silo_id);
        await adjustActiveEmbeddingReferences(database, 'chunk', item.silo_id, oldBuildId, -1);
        await adjustActiveEmbeddingReferences(database, table, item.silo_id, buildId, 1);
        await database.query(`ALTER TABLE noderag.${table} ENABLE ROW LEVEL SECURITY`);
        await database.query(`ALTER TABLE noderag.${table} FORCE ROW LEVEL SECURITY`);
        await database.query(
          `CREATE POLICY ${table}_silo_scope ON noderag.${table}
           USING (silo_id=ANY(noderag.current_silo_ids()))
           WITH CHECK (silo_id=ANY(noderag.current_silo_ids()))`,
        );
        await database.query(`ALTER TABLE noderag.${current} RENAME TO ${rollback}`);
        await database.query(
          `ALTER TABLE noderag.${newParent} ATTACH PARTITION noderag.${table}
           FOR VALUES IN (${String(item.silo_id)})`,
        );
        await database.query(`ALTER TABLE noderag.${table} RENAME TO ${current}`);
        previousBuilds.push({
          siloId: item.silo_id,
          buildId: oldBuildId,
          rollbackTable: rollback,
        });
        await database.query(
          `UPDATE noderag.silo_build_state
           SET state='rollback',rollback_table=$3,updated_at=now()
           WHERE silo_id=$1 AND build_id=$2`,
          [item.silo_id, oldBuildId, rollback],
        );
      }
      const retiredParent = identifier(`chunk_parent_retired_b${String(buildId)}`);
      await database.query(`ALTER TABLE noderag.chunk RENAME TO ${retiredParent}`);
      await database.query(`ALTER TABLE noderag.${newParent} RENAME TO chunk`);
    } else {
      for (const item of ready.rows) {
        const current = activeTable(item.silo_id);
        const oldBuildId = databaseInteger(item.old_build_id, 'old build id');
        const rollback = rollbackTable(oldBuildId, item.silo_id);
        await adjustActiveEmbeddingReferences(database, current, item.silo_id, oldBuildId, -1);
        await adjustActiveEmbeddingReferences(
          database,
          identifier(item.staging_table),
          item.silo_id,
          buildId,
          1,
        );
        await database.query(`ALTER TABLE noderag.chunk DETACH PARTITION noderag.${current}`);
        await database.query(`ALTER TABLE noderag.${current} RENAME TO ${rollback}`);
        await prepareAttachedPartition(database, identifier(item.staging_table), item.silo_id);
        previousBuilds.push({ siloId: item.silo_id, buildId: oldBuildId, rollbackTable: rollback });
        await database.query(
          `UPDATE noderag.silo_build_state
           SET state='rollback',rollback_table=$3,updated_at=now()
           WHERE silo_id=$1 AND build_id=$2`,
          [item.silo_id, oldBuildId, rollback],
        );
      }
    }
    await database.query(
      `UPDATE noderag.silo_build_state
       SET state='active',staging_table=NULL,activated_at=now(),updated_at=now()
       WHERE build_id=$1 AND silo_id=ANY($2::smallint[])`,
      [buildId, requested],
    );
    await database.query(
      `UPDATE noderag.build build
       SET state=CASE
             WHEN EXISTS(SELECT 1 FROM noderag.silo_build_state state
                         WHERE state.build_id=build.id
                           AND state.state IN ('pending','building','indexing','verifying','ready'))
               THEN 'building'
             WHEN EXISTS(SELECT 1 FROM noderag.silo_build_state state
                         WHERE state.build_id=build.id AND state.state='paused')
               THEN 'paused'
             ELSE 'active'
           END,
           activated_at=COALESCE(activated_at,now()),
           completed_at=CASE
             WHEN EXISTS(SELECT 1 FROM noderag.silo_build_state state
                         WHERE state.build_id=build.id
                           AND state.state IN ('pending','building','paused','indexing','verifying','ready'))
               THEN completed_at
             ELSE COALESCE(completed_at,now())
           END
       WHERE build.id=$1`,
      [buildId],
    );
    await database.query(
      `UPDATE noderag.build old SET state='superseded'
       WHERE old.id=ANY($1::smallint[])
         AND NOT EXISTS(SELECT 1 FROM noderag.silo_build_state state
                        WHERE state.build_id=old.id AND state.state='active')`,
      [[...new Set(previousBuilds.map((item) => item.buildId))]],
    );
    if (definition.activation_kind !== 'same_model') {
      await database.query('UPDATE noderag.model_manifest SET active=false WHERE active');
      await database.query('UPDATE noderag.model_manifest SET active=true WHERE id=$1', [
        databaseInteger(definition.model_manifest_id, 'model manifest id'),
      ]);
      await database.query(
        'UPDATE noderag.settings SET model_manifest_id=$1,updated_at=now() WHERE id=1',
        [databaseInteger(definition.model_manifest_id, 'model manifest id')],
      );
    }
    const history = await database.query<{ id: unknown }>(
      `INSERT INTO noderag.build_activation_history
         (build_id,activation_kind,previous_builds,activated_silos,parent_before,parent_after,
          activated_by)
       VALUES($1,$2,$3::jsonb,$4,$5,$6,$7) RETURNING id`,
      [
        buildId,
        definition.activation_kind,
        JSON.stringify(previousBuilds),
        requested,
        definition.activation_kind === 'dimension_change'
          ? `chunk_parent_retired_b${String(buildId)}`
          : 'chunk',
        'chunk',
        principalId,
      ],
    );
    const activationId = databaseInteger(history.rows[0]?.id, 'activation id');
    await database.query(
      `INSERT INTO noderag.audit_log(principal_id,action,result,detail)
       VALUES($1,'build.activate','ok',jsonb_build_object('buildId',$2::int,
              'activationId',$3::bigint,'kind',$4::text,'siloIds',to_jsonb($5::smallint[])))`,
      [principalId, buildId, activationId, definition.activation_kind, requested],
    );
    return activationId;
  });

interface PreviousBuild {
  readonly siloId: number;
  readonly buildId: number;
  readonly rollbackTable: string;
}

export const rollbackBuildActivation = async (
  pool: Pool,
  activationId: number,
  principalId: number,
): Promise<void> =>
  withTransaction(pool, async (database) => {
    await database.query('SELECT pg_advisory_xact_lock($1::bigint)', [7_116_011_011]);
    const activation = await database.query<{
      build_id: unknown;
      activation_kind: string;
      previous_builds: PreviousBuild[];
      activated_silos: number[];
      state: string;
    }>('SELECT * FROM noderag.build_activation_history WHERE id=$1 FOR UPDATE', [activationId]);
    const row = activation.rows[0];
    if (row === undefined || row.state !== 'rollback_available') {
      throw new Error('rollback-not-available');
    }
    const buildId = databaseInteger(row.build_id, 'build id');
    const current = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM noderag.silo_build_state
       WHERE build_id=$1 AND silo_id=ANY($2::smallint[]) AND state='active'`,
      [buildId, row.activated_silos],
    );
    if (Number(current.rows[0]?.count ?? 0) !== row.activated_silos.length) {
      throw new Error('rollback-build-no-longer-active');
    }
    await database.query("SELECT set_config('app.silo_ids',$1,true)", [
      `{${row.activated_silos.join(',')}}`,
    ]);
    await database.query(
      `UPDATE noderag.silo_build_state SET state='rollback',updated_at=now()
       WHERE build_id=$1 AND silo_id=ANY($2::smallint[])`,
      [buildId, row.activated_silos],
    );
    if (row.activation_kind === 'dimension_change') {
      const failedParent = identifier(`chunk_parent_failed_b${String(buildId)}`);
      const retiredParent = identifier(`chunk_parent_retired_b${String(buildId)}`);
      for (const previous of row.previous_builds) {
        await adjustActiveEmbeddingReferences(database, 'chunk', previous.siloId, buildId, -1);
        await adjustActiveEmbeddingReferences(
          database,
          retiredParent,
          previous.siloId,
          previous.buildId,
          1,
        );
        const active = activeTable(previous.siloId);
        const failed = stagingTable(buildId, previous.siloId);
        const rollback = identifier(previous.rollbackTable);
        await database.query(`ALTER TABLE noderag.${active} RENAME TO ${failed}`);
        await database.query(`ALTER TABLE noderag.${rollback} RENAME TO ${active}`);
      }
      await database.query(`ALTER TABLE noderag.chunk RENAME TO ${failedParent}`);
      await database.query(`ALTER TABLE noderag.${retiredParent} RENAME TO chunk`);
      for (const previous of row.previous_builds) {
        await database.query(
          `UPDATE noderag.silo_build_state
           SET state='active',rollback_table=NULL,activated_at=now(),updated_at=now()
           WHERE silo_id=$1 AND build_id=$2`,
          [previous.siloId, previous.buildId],
        );
      }
    } else {
      for (const previous of row.previous_builds) {
        const active = activeTable(previous.siloId);
        const failed = stagingTable(buildId, previous.siloId);
        const rollback = identifier(previous.rollbackTable);
        await adjustActiveEmbeddingReferences(database, active, previous.siloId, buildId, -1);
        await adjustActiveEmbeddingReferences(
          database,
          rollback,
          previous.siloId,
          previous.buildId,
          1,
        );
        await database.query(`ALTER TABLE noderag.chunk DETACH PARTITION noderag.${active}`);
        await database.query(`ALTER TABLE noderag.${active} RENAME TO ${failed}`);
        await database.query(`ALTER TABLE noderag.${rollback} RENAME TO ${active}`);
        await database.query(
          `ALTER TABLE noderag.chunk ATTACH PARTITION noderag.${active}
           FOR VALUES IN (${String(previous.siloId)})`,
        );
        await database.query(
          `UPDATE noderag.silo_build_state
           SET state='active',rollback_table=NULL,activated_at=now(),updated_at=now()
           WHERE silo_id=$1 AND build_id=$2`,
          [previous.siloId, previous.buildId],
        );
      }
    }
    await database.query(
      `UPDATE noderag.build build
       SET state=CASE
         WHEN EXISTS(SELECT 1 FROM noderag.silo_build_state state
                     WHERE state.build_id=build.id AND state.state='active') THEN 'active'
         WHEN EXISTS(SELECT 1 FROM noderag.silo_build_state state
                     WHERE state.build_id=build.id
                       AND state.state IN ('pending','building','indexing','verifying','ready'))
           THEN 'building'
         WHEN EXISTS(SELECT 1 FROM noderag.silo_build_state state
                     WHERE state.build_id=build.id AND state.state='paused') THEN 'paused'
         ELSE 'superseded'
       END
       WHERE build.id=$1`,
      [buildId],
    );
    await database.query(
      `UPDATE noderag.build SET state='active'
       WHERE id=ANY($1::smallint[])`,
      [[...new Set(row.previous_builds.map((item) => item.buildId))]],
    );
    if (row.activation_kind !== 'same_model') {
      const restored = await database.query<{ model_manifest_id: unknown }>(
        'SELECT model_manifest_id FROM noderag.build WHERE id=$1',
        [row.previous_builds[0]?.buildId ?? null],
      );
      const restoredModelId = databaseInteger(
        restored.rows[0]?.model_manifest_id,
        'restored model manifest id',
      );
      await database.query('UPDATE noderag.model_manifest SET active=false WHERE active');
      await database.query('UPDATE noderag.model_manifest SET active=true WHERE id=$1', [
        restoredModelId,
      ]);
      await database.query(
        'UPDATE noderag.settings SET model_manifest_id=$1,updated_at=now() WHERE id=1',
        [restoredModelId],
      );
    }
    await database.query(
      `UPDATE noderag.build_activation_history
       SET state='rolled_back',rolled_back_at=now() WHERE id=$1`,
      [activationId],
    );
    await database.query(
      `INSERT INTO noderag.audit_log(principal_id,action,result,detail)
       VALUES($1,'build.rollback','ok',jsonb_build_object('activationId',$2::bigint,
              'buildId',$3::int))`,
      [principalId, activationId, buildId],
    );
  });

export const authorizeBuildCleanup = async (
  database: SqlClient,
  activationId: number,
  confirmation: string,
  principalId: number,
): Promise<number> => {
  const activation = await database.query<{ build_id: unknown; state: string }>(
    'SELECT build_id,state FROM noderag.build_activation_history WHERE id=$1 FOR UPDATE',
    [activationId],
  );
  const row = activation.rows[0];
  if (row === undefined || !['rollback_available', 'rolled_back'].includes(row.state)) {
    throw new Error('cleanup-blocked-by-rollback-state');
  }
  const buildId = databaseInteger(row.build_id, 'build id');
  if (confirmation !== `CLEANUP BUILD ${String(buildId)}`) {
    throw new Error('cleanup-confirmation-mismatch');
  }
  const created = await database.query<{ id: unknown }>(
    `INSERT INTO noderag.build_cleanup
       (activation_id,destructive_confirmation,checkpoint,requested_by)
     VALUES($1,$2,jsonb_build_object('disposition',$3::text),$4) RETURNING id`,
    [
      activationId,
      confirmation,
      row.state === 'rolled_back' ? 'rolled_back' : 'activated',
      principalId,
    ],
  );
  await database.query(
    `UPDATE noderag.build_activation_history
     SET state='cleanup_authorized',cleanup_authorized_at=now() WHERE id=$1`,
    [activationId],
  );
  const cleanupId = databaseInteger(created.rows[0]?.id, 'cleanup id');
  await database.query(
    `INSERT INTO noderag.audit_log(principal_id,action,result,detail)
     VALUES($1,'build.cleanup_authorize','ok',
             jsonb_build_object('activationId',$2::bigint,'buildId',$3::int,
                                'cleanupId',$4::bigint,'disposition',$5::text))`,
    [
      principalId,
      activationId,
      buildId,
      cleanupId,
      row.state === 'rolled_back' ? 'rolled_back' : 'activated',
    ],
  );
  return cleanupId;
};

export const runAuthorizedBuildCleanup = async (
  pool: Pool,
  cleanupId: number,
  principalId: number,
): Promise<void> =>
  withTransaction(pool, async (database) => {
    const cleanup = await database.query<{
      activation_id: unknown;
      previous_builds: PreviousBuild[];
      activation_kind: string;
      build_id: unknown;
      activated_silos: number[];
      checkpoint: { disposition?: string };
    }>(
      `UPDATE noderag.build_cleanup cleanup
       SET state='running'
       FROM noderag.build_activation_history activation
       WHERE cleanup.id=$1 AND cleanup.state IN ('authorized','paused','failed')
         AND activation.id=cleanup.activation_id AND activation.state='cleanup_authorized'
       RETURNING cleanup.activation_id,activation.previous_builds,
                 activation.activation_kind,activation.build_id,
                 activation.activated_silos,cleanup.checkpoint`,
      [cleanupId],
    );
    const row = cleanup.rows[0];
    if (row === undefined) throw new Error('cleanup-not-authorized');
    const buildId = databaseInteger(row.build_id, 'build id');
    if (row.checkpoint.disposition === 'rolled_back') {
      if (row.activation_kind === 'dimension_change') {
        await database.query(`DROP TABLE noderag.chunk_parent_failed_b${String(buildId)}`);
      } else {
        for (const siloId of row.activated_silos) {
          await database.query(`DROP TABLE noderag.${stagingTable(buildId, siloId)}`);
          await database.query(`UPDATE noderag.build_cleanup SET checkpoint=$2 WHERE id=$1`, [
            cleanupId,
            { disposition: 'rolled_back', lastSiloId: siloId },
          ]);
        }
      }
      await database.query(
        `UPDATE noderag.silo_build_state
         SET state='failed',last_error='rolled-back-build-cleaned',updated_at=now()
         WHERE build_id=$1 AND silo_id=ANY($2::smallint[]) AND state='rollback'`,
        [buildId, row.activated_silos],
      );
    } else if (row.activation_kind === 'dimension_change') {
      await database.query(`DROP TABLE noderag.chunk_parent_retired_b${String(buildId)}`);
    } else {
      for (const previous of row.previous_builds) {
        await database.query(`DROP TABLE noderag.${identifier(previous.rollbackTable)}`);
        await database.query(`UPDATE noderag.build_cleanup SET checkpoint=$2 WHERE id=$1`, [
          cleanupId,
          { lastSiloId: previous.siloId },
        ]);
      }
    }
    await database.query(
      `UPDATE noderag.build_cleanup SET state='completed',completed_at=now() WHERE id=$1`,
      [cleanupId],
    );
    await database.query(
      `UPDATE noderag.build_activation_history SET state='cleaned',cleaned_at=now()
       WHERE id=$1`,
      [databaseInteger(row.activation_id, 'activation id')],
    );
    await database.query(
      `INSERT INTO noderag.audit_log(principal_id,action,result,detail)
       VALUES($1,'build.cleanup','ok',
              jsonb_build_object('cleanupId',$2::bigint,'buildId',$3::int,
                                 'disposition',$4::text))`,
      [principalId, cleanupId, buildId, row.checkpoint.disposition ?? 'activated'],
    );
  });
