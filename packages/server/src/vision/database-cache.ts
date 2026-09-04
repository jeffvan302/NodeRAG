import type { Pool } from 'pg';
import type { AnalysedVisionResult } from '../extract/contract.js';
import { withTransaction } from '../store/database.js';
import type { VisionCacheKey, VisionCachePort, VisionDispatch } from './service.js';

interface CachedVisionRow {
  readonly kind: AnalysedVisionResult['kind'];
  readonly markdown: string;
  readonly alt_text: string;
  readonly confidence: number;
  readonly elapsed_ms: number | null;
}

const bytes = (hex: string): Buffer => Buffer.from(hex, 'hex');

export class DatabaseVisionCache implements VisionCachePort {
  constructor(private readonly pool: Pool) {}

  async get(key: VisionCacheKey): Promise<AnalysedVisionResult | null> {
    const result = await this.pool.query<CachedVisionRow>(
      `UPDATE noderag.vision_cache
       SET last_used_at = now()
       WHERE cache_key = $1
       RETURNING kind, markdown, alt_text, confidence, elapsed_ms`,
      [bytes(key.fingerprint)],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      disposition: 'analysed',
      kind: row.kind,
      markdown: row.markdown,
      alt: row.alt_text,
      confidence: row.confidence,
      provider: key.provider,
      model: key.model,
      revisions: {
        provider: key.providerRevision,
        model: key.modelRevision,
        prompt: key.promptRevision,
        schema: key.schemaRevision,
        preprocessing: key.preprocessingRevision,
      },
      originalSha256: key.originalSha256,
      preprocessedSha256: key.preprocessedSha256,
      width: 0,
      height: 0,
      elapsedMs: row.elapsed_ms ?? 0,
      cached: true,
      cacheKey: key.fingerprint,
    };
  }

  async markDispatched(dispatch: VisionDispatch): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO noderag.vision_dispatch
         (cache_key, image_sha256, request_kind, page_number, image_id, attempt, dispatched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id::text AS id`,
      [
        bytes(dispatch.key.fingerprint),
        bytes(dispatch.key.originalSha256),
        dispatch.request.kind,
        dispatch.request.pageNumber,
        dispatch.request.imageId,
        dispatch.attempt,
        dispatch.dispatchedAt,
      ],
    );
    return result.rows[0]?.id ?? null;
  }

  async put(
    key: VisionCacheKey,
    dispatchId: string | null,
    result: AnalysedVisionResult,
  ): Promise<void> {
    await withTransaction(this.pool, async (database) => {
      await database.query(
        `INSERT INTO noderag.vision_cache
           (cache_key, image_sha256, preprocessed_sha256, provider, model,
            provider_revision, model_revision, prompt_revision, schema_revision,
            preprocessing_revision, kind, markdown, alt_text, confidence, elapsed_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (cache_key) DO UPDATE
         SET kind = EXCLUDED.kind, markdown = EXCLUDED.markdown,
             alt_text = EXCLUDED.alt_text, confidence = EXCLUDED.confidence,
             elapsed_ms = EXCLUDED.elapsed_ms, last_used_at = now()`,
        [
          bytes(key.fingerprint),
          bytes(key.originalSha256),
          bytes(key.preprocessedSha256),
          key.provider,
          key.model,
          key.providerRevision,
          key.modelRevision,
          key.promptRevision,
          key.schemaRevision,
          key.preprocessingRevision,
          result.kind,
          result.markdown,
          result.alt,
          result.confidence,
          result.elapsedMs,
        ],
      );
      if (dispatchId !== null) {
        await database.query(
          `UPDATE noderag.vision_dispatch
           SET state = 'validated', settled_at = now(), error_code = NULL
           WHERE id = $1 AND state = 'dispatched'`,
          [dispatchId],
        );
      }
    });
  }

  async markFailed(
    _key: VisionCacheKey,
    dispatchId: string | null,
    errorCode: string,
    _attempt: number,
  ): Promise<void> {
    if (dispatchId === null) return;
    await this.pool.query(
      `UPDATE noderag.vision_dispatch
       SET state = 'failed', settled_at = now(), error_code = $2
       WHERE id = $1 AND state = 'dispatched'`,
      [dispatchId, errorCode],
    );
  }
}
