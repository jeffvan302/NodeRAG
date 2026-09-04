import type { Pool } from 'pg';
import type { DocumentFileStore } from '../storage/document-files.js';
import { databaseInteger, withTransaction, type SqlClient } from './database.js';

interface PurgeOperationRow {
  readonly id: unknown;
  readonly target_kind: 'document' | 'silo';
  readonly silo_id: number;
  readonly document_id: unknown;
  readonly target_label: string;
  readonly extension: string | null;
  readonly requested_by: unknown;
  readonly stage: string;
}

interface PurgeFaultHooks {
  readonly afterRowsRemoved?: () => Promise<void> | void;
  readonly afterFilesRemoved?: () => Promise<void> | void;
}

const setScope = async (database: SqlClient, siloId: number): Promise<void> => {
  await database.query(`SELECT set_config('app.silo_ids', $1, true)`, [`{${String(siloId)}}`]);
};

const decrementCaches = async (
  database: SqlClient,
  siloId: number,
  documentId: number,
): Promise<{ readonly chunks: number; readonly images: number }> => {
  const counts = await database.query<{ chunks: string; images: string }>(
    `SELECT
       (SELECT count(*) FROM noderag.chunk
        WHERE silo_id = $1 AND document_id = $2)::text AS chunks,
       (SELECT count(*) FROM noderag.document_image
        WHERE silo_id = $1 AND document_id = $2)::text AS images`,
    [siloId, documentId],
  );
  await database.query(
    `WITH refs AS (
       SELECT c.chunk_sha256, b.model_manifest_id, count(*)::integer AS used
       FROM noderag.chunk c JOIN noderag.build b ON b.id = c.build_id
       WHERE c.silo_id = $1 AND c.document_id = $2
       GROUP BY c.chunk_sha256, b.model_manifest_id
     )
     UPDATE noderag.embedding_cache cache
     SET refcount = GREATEST(0, cache.refcount - refs.used), last_used_at = now()
     FROM refs
     WHERE cache.chunk_sha256 = refs.chunk_sha256
       AND cache.model_manifest_id = refs.model_manifest_id`,
    [siloId, documentId],
  );
  await database.query(
    `WITH refs AS (
       SELECT cache_key, count(*)::integer AS used
       FROM noderag.document_image
       WHERE silo_id = $1 AND document_id = $2 AND cache_key IS NOT NULL
       GROUP BY cache_key
     )
     UPDATE noderag.vision_cache cache
     SET refcount = GREATEST(0, cache.refcount - refs.used), last_used_at = now()
     FROM refs
     WHERE cache.cache_key = refs.cache_key`,
    [siloId, documentId],
  );
  await database.query('DELETE FROM noderag.embedding_cache WHERE refcount = 0');
  await database.query('DELETE FROM noderag.vision_cache WHERE refcount = 0');
  return {
    chunks: Number(counts.rows[0]?.chunks ?? 0),
    images: Number(counts.rows[0]?.images ?? 0),
  };
};

export const startDocumentPurge = async (
  database: SqlClient,
  documentId: number,
  siloId: number,
  principalId: number,
): Promise<number | null> => {
  const existing = await database.query<{ id: unknown }>(
    `SELECT id FROM noderag.purge_operation
     WHERE document_id = $1 AND silo_id = $2 AND stage <> 'completed' FOR UPDATE`,
    [documentId, siloId],
  );
  if (existing.rows[0] !== undefined) {
    return databaseInteger(existing.rows[0].id, 'purge operation id');
  }
  const found = await database.query<{ name: string; extension: string }>(
    `SELECT name, extension FROM noderag.document
     WHERE id = $1 AND silo_id = $2 FOR UPDATE`,
    [documentId, siloId],
  );
  const document = found.rows[0];
  if (document === undefined) return null;
  const inserted = await database.query<{ id: unknown }>(
    `INSERT INTO noderag.purge_operation
       (target_kind, silo_id, document_id, target_label, extension, requested_by, stage)
     VALUES ('document', $1, $2, $3, $4, $5, 'marked')
     RETURNING id`,
    [siloId, documentId, document.name, document.extension, principalId],
  );
  await database.query(
    `UPDATE noderag.document SET state = 'purging' WHERE id = $1 AND silo_id = $2`,
    [documentId, siloId],
  );
  await database.query(
    `UPDATE noderag.job
     SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
         state = CASE WHEN state IN ('pending', 'retry_wait', 'paused')
           THEN 'cancelled' ELSE state END,
         finished_at = CASE WHEN state IN ('pending', 'retry_wait', 'paused')
           THEN now() ELSE finished_at END,
         updated_at = now()
     WHERE document_id = $1 AND state NOT IN ('succeeded', 'failed', 'cancelled')`,
    [documentId],
  );
  return databaseInteger(inserted.rows[0]?.id, 'purge operation id');
};

export const continueDocumentPurge = async (
  pool: Pool,
  files: DocumentFileStore,
  operationId: number,
  faultHooks: PurgeFaultHooks = {},
): Promise<{ readonly operationId: number; readonly stage: 'completed' }> => {
  let operation = await withTransaction(pool, async (database) => {
    const found = await database.query<PurgeOperationRow>(
      `SELECT id, target_kind, silo_id, document_id, target_label, extension,
              requested_by, stage
       FROM noderag.purge_operation WHERE id = $1 FOR UPDATE`,
      [operationId],
    );
    const row = found.rows[0];
    if (row === undefined || row.target_kind !== 'document' || row.document_id === null) {
      throw new Error('document-purge-operation-not-found');
    }
    const documentId = databaseInteger(row.document_id, 'purge document id');
    if (row.stage === 'completed') return { ...row, documentId };
    if (row.stage !== 'rows_removed' && row.stage !== 'files_removed') {
      await setScope(database, row.silo_id);
      const running = await database.query(
        `SELECT 1 FROM noderag.job
         WHERE document_id = $1 AND state = 'leased' AND leased_until > now() LIMIT 1`,
        [documentId],
      );
      if ((running.rowCount ?? 0) > 0) throw new Error('document-purge-jobs-draining');
      const destroyed = await decrementCaches(database, row.silo_id, documentId);
      await database.query(`DELETE FROM noderag.chunk WHERE silo_id = $1 AND document_id = $2`, [
        row.silo_id,
        documentId,
      ]);
      await database.query(
        `UPDATE noderag.build
         SET chunk_count = GREATEST(0, COALESCE(chunk_count, 0) - $1)
         WHERE state = 'active'`,
        [destroyed.chunks],
      );
      await database.query('DELETE FROM noderag.document WHERE id = $1 AND silo_id = $2', [
        documentId,
        row.silo_id,
      ]);
      await database.query(
        `UPDATE noderag.purge_operation
         SET stage = 'rows_removed', destroyed_counts = $2, updated_at = now(), last_error = NULL
         WHERE id = $1`,
        [operationId, { documents: 1, chunks: destroyed.chunks, images: destroyed.images }],
      );
    }
    return {
      ...row,
      stage: row.stage === 'files_removed' ? 'files_removed' : 'rows_removed',
      documentId,
    };
  });

  if (operation.stage === 'completed') return { operationId, stage: 'completed' };
  if (operation.stage === 'rows_removed') {
    await faultHooks.afterRowsRemoved?.();
    try {
      await files.removeDocument(operation.documentId);
    } catch (error) {
      await pool.query(
        `UPDATE noderag.purge_operation
         SET last_error = jsonb_build_object('stage', 'files_removed',
                                              'message', $2::text),
             updated_at = now()
         WHERE id = $1`,
        [operationId, error instanceof Error ? error.message.slice(0, 1000) : 'file-remove-failed'],
      );
      throw error;
    }
    await pool.query(
      `UPDATE noderag.purge_operation
       SET stage = 'files_removed', last_error = NULL, updated_at = now()
       WHERE id = $1 AND stage = 'rows_removed'`,
      [operationId],
    );
    operation = { ...operation, stage: 'files_removed' };
  }
  await faultHooks.afterFilesRemoved?.();

  await withTransaction(pool, async (database) => {
    const current = await database.query<{ stage: string }>(
      'SELECT stage FROM noderag.purge_operation WHERE id = $1 FOR UPDATE',
      [operationId],
    );
    if (current.rows[0]?.stage === 'completed') return;
    await database.query(
      `UPDATE noderag.purge_operation
       SET stage = 'completed', updated_at = now(), completed_at = now(), last_error = NULL
       WHERE id = $1`,
      [operationId],
    );
    await database.query(
      `INSERT INTO noderag.audit_log
         (principal_id, silo_id, action, result, row_count, detail)
       VALUES ($1, $2, 'document.purge', 'ok', 1,
               jsonb_build_object('operationId', $3::bigint,
                                  'documentId', $4::bigint,
                                  'label', $5::text))`,
      [
        operation.requested_by === null
          ? null
          : databaseInteger(operation.requested_by, 'purge requester'),
        operation.silo_id,
        operationId,
        operation.documentId,
        operation.target_label,
      ],
    );
  });
  return { operationId, stage: 'completed' };
};

export const purgeDocument = async (
  pool: Pool,
  files: DocumentFileStore,
  input: { readonly documentId: number; readonly siloId: number; readonly principalId: number },
): Promise<{ readonly operationId: number; readonly stage: 'completed' } | null> => {
  const operationId = await withTransaction(pool, async (database) => {
    await setScope(database, input.siloId);
    return startDocumentPurge(database, input.documentId, input.siloId, input.principalId);
  });
  if (operationId === null) return null;
  return continueDocumentPurge(pool, files, operationId);
};

const partitionName = (siloId: number): string => {
  if (!Number.isSafeInteger(siloId) || siloId < 1 || siloId > 32_767) {
    throw new Error('Invalid silo partition id.');
  }
  return `chunk_s${siloId}`;
};

export const purgeSiloCompletely = async (
  pool: Pool,
  files: DocumentFileStore,
  input: {
    readonly siloId: number;
    readonly expectedSlug: string;
    readonly principalId: number;
  },
): Promise<{ readonly operationId: number; readonly stage: 'completed' }> => {
  const operationId = await withTransaction(pool, async (database) => {
    const administrator = await database.query(
      `SELECT 1 FROM noderag.app_user u JOIN noderag.principal p ON p.id = u.principal_id
       WHERE p.id = $1 AND u.server_admin AND NOT p.disabled AND p.deleted_at IS NULL`,
      [input.principalId],
    );
    if (administrator.rowCount !== 1) throw new Error('server-admin-required');
    const silo = await database.query<{ slug: string }>(
      `SELECT slug FROM noderag.silo WHERE id = $1 FOR UPDATE`,
      [input.siloId],
    );
    if (silo.rows[0]?.slug !== input.expectedSlug) throw new Error('silo-confirmation-mismatch');
    await database.query(`UPDATE noderag.silo SET lifecycle_state = 'purging' WHERE id = $1`, [
      input.siloId,
    ]);
    await database.query(
      `UPDATE noderag.job
       SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
           state = CASE WHEN state IN ('pending', 'retry_wait', 'paused')
             THEN 'cancelled' ELSE state END,
           finished_at = CASE WHEN state IN ('pending', 'retry_wait', 'paused')
             THEN now() ELSE finished_at END,
           updated_at = now()
       WHERE silo_id = $1 AND state NOT IN ('succeeded', 'failed', 'cancelled')`,
      [input.siloId],
    );
    const existing = await database.query<{ id: unknown }>(
      `SELECT id FROM noderag.purge_operation
       WHERE target_kind = 'silo' AND silo_id = $1 AND stage <> 'completed' FOR UPDATE`,
      [input.siloId],
    );
    if (existing.rows[0] !== undefined) {
      return databaseInteger(existing.rows[0].id, 'silo purge operation id');
    }
    const inserted = await database.query<{ id: unknown }>(
      `INSERT INTO noderag.purge_operation
         (target_kind, silo_id, target_label, requested_by, stage)
       VALUES ('silo', $1, $2, $3, 'marked') RETURNING id`,
      [input.siloId, input.expectedSlug, input.principalId],
    );
    return databaseInteger(inserted.rows[0]?.id, 'silo purge operation id');
  });

  const running = await pool.query(
    `SELECT 1 FROM noderag.job
     WHERE silo_id = $1 AND state = 'leased' AND leased_until > now() LIMIT 1`,
    [input.siloId],
  );
  if ((running.rowCount ?? 0) > 0) throw new Error('silo-purge-jobs-draining');

  const documents = await withTransaction(pool, async (database) => {
    await setScope(database, input.siloId);
    return database.query<{ id: unknown }>(
      `SELECT id FROM noderag.document WHERE silo_id = $1 ORDER BY id`,
      [input.siloId],
    );
  });
  for (const row of documents.rows) {
    await purgeDocument(pool, files, {
      documentId: databaseInteger(row.id, 'silo document id'),
      siloId: input.siloId,
      principalId: input.principalId,
    });
  }

  await withTransaction(pool, async (database) => {
    const table = partitionName(input.siloId);
    await database.query(`DROP TABLE IF EXISTS noderag.${table}`);
    await database.query('DELETE FROM noderag.silo WHERE id = $1', [input.siloId]);
    await database.query(
      `UPDATE noderag.purge_operation
       SET stage = 'completed', destroyed_counts = jsonb_build_object(
             'documents', $2::int, 'partitionDropped', true),
           updated_at = now(), completed_at = now()
       WHERE id = $1`,
      [operationId, documents.rows.length],
    );
    await database.query(
      `INSERT INTO noderag.audit_log (principal_id, action, result, row_count, detail)
       VALUES ($1, 'silo.purge', 'ok', $2,
               jsonb_build_object('operationId', $3::bigint,
                                  'siloId', $4::int, 'slug', $5::text))`,
      [input.principalId, documents.rows.length, operationId, input.siloId, input.expectedSlug],
    );
  });
  return { operationId, stage: 'completed' };
};
