import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AnalysedVisionResult,
  InjectedVision,
  VisionRequest,
  VisionResult,
} from '../extract/contract.js';
import {
  ollamaVisionJsonSchema,
  visionRevisions,
  VISION_TRANSCRIPTION_PROMPT,
  VisionProviderError,
  type VisionProvider,
} from './contract.js';
import { preprocessVisionImage } from './preprocess.js';
import { Semaphore } from './semaphore.js';

export interface VisionCacheKey {
  readonly fingerprint: string;
  readonly originalSha256: string;
  readonly preprocessedSha256: string;
  readonly provider: string;
  readonly model: string;
  readonly providerRevision: string;
  readonly modelRevision: string;
  readonly promptRevision: string;
  readonly schemaRevision: string;
  readonly preprocessingRevision: string;
}

export interface VisionDispatch {
  readonly key: VisionCacheKey;
  readonly request: VisionRequest;
  readonly attempt: number;
  readonly dispatchedAt: Date;
}

export interface VisionCachePort {
  get(key: VisionCacheKey): Promise<AnalysedVisionResult | null>;
  markDispatched(dispatch: VisionDispatch): Promise<string | null>;
  put(key: VisionCacheKey, dispatchId: string | null, result: AnalysedVisionResult): Promise<void>;
  markFailed(
    key: VisionCacheKey,
    dispatchId: string | null,
    errorCode: string,
    attempt: number,
  ): Promise<void>;
}

export interface VisionProcessorOptions {
  readonly provider: VisionProvider;
  readonly cache?: VisionCachePort;
  readonly maximumDimension?: number;
  readonly maximumConcurrency?: number;
  readonly timeoutMs?: number;
  readonly maximumAttempts?: number;
  readonly initialBackoffMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly concurrency?: VisionConcurrency;
}

export interface VisionConcurrency {
  use<T>(operation: () => Promise<T>): Promise<T>;
}

const cacheKey = (
  provider: VisionProvider,
  originalSha256: string,
  preprocessedSha256: string,
): VisionCacheKey => {
  const revisions = visionRevisions(provider);
  const parts = [
    originalSha256,
    preprocessedSha256,
    provider.provider,
    provider.model,
    revisions.provider,
    revisions.model,
    revisions.prompt,
    revisions.schema,
    revisions.preprocessing,
  ];
  return {
    fingerprint: createHash('sha256').update(parts.join('\0')).digest('hex'),
    originalSha256,
    preprocessedSha256,
    provider: provider.provider,
    model: provider.model,
    providerRevision: revisions.provider,
    modelRevision: revisions.model,
    promptRevision: revisions.prompt,
    schemaRevision: revisions.schema,
    preprocessingRevision: revisions.preprocessing,
  };
};

const errorDetails = (error: unknown): { readonly code: string; readonly retry: boolean } => {
  if (error instanceof VisionProviderError) {
    return { code: error.code, retry: error.classification === 'transient' };
  }
  return { code: 'vision-provider-failed', retry: true };
};

export class VisionProcessor implements InjectedVision {
  private readonly provider: VisionProvider;
  private readonly cache: VisionCachePort | undefined;
  private readonly maximumDimension: number;
  private readonly timeoutMs: number;
  private readonly maximumAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly concurrency: VisionConcurrency;

  constructor(options: VisionProcessorOptions) {
    this.provider = options.provider;
    this.cache = options.cache;
    this.maximumDimension = options.maximumDimension ?? 2048;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maximumAttempts = options.maximumAttempts ?? 3;
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.wait = options.wait ?? ((milliseconds) => delay(milliseconds));
    this.concurrency = options.concurrency ?? new Semaphore(options.maximumConcurrency ?? 2);
    if (!Number.isInteger(this.maximumAttempts) || this.maximumAttempts < 1) {
      throw new Error('Vision maximum attempts must be a positive integer.');
    }
  }

  async analyse(request: VisionRequest): Promise<VisionResult> {
    const prepared = await preprocessVisionImage(request.bytes, {
      maximumDimension: this.maximumDimension,
    });
    if (prepared.disposition === 'skipped') {
      return {
        disposition: 'skipped',
        alt: `Image skipped: ${prepared.reason}`,
        skipReason: prepared.reason,
        originalSha256: prepared.originalSha256,
        width: prepared.width,
        height: prepared.height,
      };
    }
    const key = cacheKey(this.provider, prepared.originalSha256, prepared.preprocessedSha256);
    const cached = await this.cache?.get(key);
    if (cached !== undefined && cached !== null) {
      return {
        ...cached,
        width: prepared.width,
        height: prepared.height,
        cached: true,
        cacheKey: key.fingerprint,
      };
    }
    let finalError = 'vision-provider-failed';
    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      const dispatchId =
        (await this.cache?.markDispatched({
          key,
          request,
          attempt,
          dispatchedAt: new Date(),
        })) ?? null;
      const started = performance.now();
      try {
        const response = await this.concurrency.use(async () => {
          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(new Error('vision-provider-timeout')),
            this.timeoutMs,
          );
          try {
            return await this.provider.analyse({
              bytes: prepared.bytes,
              mediaType: prepared.mediaType,
              sourceKind: request.kind,
              pageNumber: request.pageNumber,
              imageId: request.imageId,
              prompt: VISION_TRANSCRIPTION_PROMPT,
              schema: ollamaVisionJsonSchema,
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeout);
          }
        });
        const revisions = visionRevisions(this.provider);
        const result: AnalysedVisionResult = {
          disposition: 'analysed',
          ...response,
          provider: this.provider.provider,
          model: this.provider.model,
          revisions,
          originalSha256: prepared.originalSha256,
          preprocessedSha256: prepared.preprocessedSha256,
          width: prepared.width,
          height: prepared.height,
          elapsedMs: Math.max(0, Math.round(performance.now() - started)),
          cached: false,
          cacheKey: key.fingerprint,
        };
        await this.cache?.put(key, dispatchId, result);
        return result;
      } catch (error) {
        const details = errorDetails(error);
        finalError = details.code;
        await this.cache?.markFailed(key, dispatchId, details.code, attempt);
        if (!details.retry || attempt === this.maximumAttempts) break;
        await this.wait(this.initialBackoffMs * 2 ** (attempt - 1));
      }
    }
    return {
      disposition: 'pending_vision',
      alt: `Image pending analysis (${finalError})`,
      errorCode: finalError,
      provider: this.provider.provider,
      model: this.provider.model,
      revisions: visionRevisions(this.provider),
      originalSha256: prepared.originalSha256,
      preprocessedSha256: prepared.preprocessedSha256,
      width: prepared.width,
      height: prepared.height,
      cacheKey: key.fingerprint,
    };
  }
}
