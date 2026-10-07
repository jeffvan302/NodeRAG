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
  layoutVisionJsonSchema,
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
  readonly sourcePolicyRevision: string;
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
  readonly maximumImagesPerCall?: number;
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
  sourcePolicyRevision: string,
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
    sourcePolicyRevision,
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
    sourcePolicyRevision,
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
  readonly maximumImagesPerCall: number;
  readonly maximumParallelCalls: number;
  private readonly timeoutMs: number;
  private readonly maximumAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly concurrency: VisionConcurrency;

  constructor(options: VisionProcessorOptions) {
    this.provider = options.provider;
    this.cache = options.cache;
    this.maximumDimension = options.maximumDimension ?? 2048;
    this.maximumImagesPerCall = options.maximumImagesPerCall ?? 3;
    this.maximumParallelCalls = options.maximumConcurrency ?? 2;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maximumAttempts = options.maximumAttempts ?? 3;
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.wait = options.wait ?? ((milliseconds) => delay(milliseconds));
    this.concurrency = options.concurrency ?? new Semaphore(this.maximumParallelCalls);
    if (!Number.isInteger(this.maximumAttempts) || this.maximumAttempts < 1) {
      throw new Error('Vision maximum attempts must be a positive integer.');
    }
    if (
      !Number.isInteger(this.maximumImagesPerCall) ||
      this.maximumImagesPerCall < 1 ||
      this.maximumImagesPerCall > 16
    ) {
      throw new Error('Vision images per call must be an integer from 1 to 16.');
    }
  }

  async analyse(request: VisionRequest): Promise<VisionResult> {
    const result = (await this.analyseMany([request]))[0];
    if (result === undefined) throw new Error('vision-result-missing');
    return result;
  }

  async analyseMany(requests: readonly VisionRequest[]): Promise<readonly VisionResult[]> {
    if (requests.length === 0) return [];
    const batches: VisionRequest[][] = [];
    for (let index = 0; index < requests.length; index += this.maximumImagesPerCall) {
      batches.push(requests.slice(index, index + this.maximumImagesPerCall));
    }
    return (await Promise.all(batches.map((batch) => this.analyseBatch(batch)))).flat();
  }

  private async analyseBatch(requests: readonly VisionRequest[]): Promise<readonly VisionResult[]> {
    const results: Array<VisionResult | undefined> = Array.from({ length: requests.length });
    const ready: Array<{
      readonly index: number;
      readonly request: VisionRequest;
      readonly prepared: Extract<
        Awaited<ReturnType<typeof preprocessVisionImage>>,
        { disposition: 'ready' }
      >;
      readonly key: VisionCacheKey;
    }> = [];
    await Promise.all(
      requests.map(async (request, index) => {
        const prepared = await preprocessVisionImage(request.bytes, {
          maximumDimension: this.maximumDimension,
        });
        if (prepared.disposition === 'skipped') {
          results[index] = {
            disposition: 'skipped',
            alt: `Image skipped: ${prepared.reason}`,
            skipReason: prepared.reason,
            originalSha256: prepared.originalSha256,
            width: prepared.width,
            height: prepared.height,
          };
          return;
        }
        const key = cacheKey(
          this.provider,
          prepared.originalSha256,
          prepared.preprocessedSha256,
          request.sourcePolicyRevision ?? 'source-policy.none',
        );
        const cached = await this.cache?.get(key);
        if (cached !== undefined && cached !== null) {
          results[index] = {
            ...cached,
            width: prepared.width,
            height: prepared.height,
            cached: true,
            cacheKey: key.fingerprint,
          };
          return;
        }
        ready.push({ index, request, prepared, key });
      }),
    );
    ready.sort((left, right) => left.index - right.index);
    if (ready.length === 0) return this.requireResults(results);

    let finalError = 'vision-provider-failed';
    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      const dispatchIds = await Promise.all(
        ready.map(
          async ({ key, request }) =>
            (await this.cache?.markDispatched({
              key,
              request,
              attempt,
              dispatchedAt: new Date(),
            })) ?? null,
        ),
      );
      const started = performance.now();
      try {
        const responses = await this.concurrency.use(async () => {
          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(new Error('vision-provider-timeout')),
            this.timeoutMs,
          );
          try {
            return await this.provider.analyseMany(
              ready.map(({ prepared, request }) => ({
                bytes: prepared.bytes,
                mediaType: prepared.mediaType,
                sourceKind: request.kind,
                pageNumber: request.pageNumber,
                imageId: request.imageId,
                prompt:
                  request.kind === 'pdf-region'
                    ? `${VISION_TRANSCRIPTION_PROMPT} This image is a bounded PDF region. Reconstruct only the visible target region and do not repeat surrounding page content.`
                    : VISION_TRANSCRIPTION_PROMPT,
                schema:
                  request.kind === 'pdf-page' || request.kind === 'pdf-region'
                    ? layoutVisionJsonSchema
                    : ollamaVisionJsonSchema,
                signal: controller.signal,
              })),
            );
          } finally {
            clearTimeout(timeout);
          }
        });
        if (responses.length !== ready.length) {
          throw new VisionProviderError('vision-content-schema-invalid', 'transient', {
            cause: new Error('vision-batch-result-count-invalid'),
          });
        }
        const elapsedMs = Math.max(0, Math.round(performance.now() - started));
        const revisions = visionRevisions(this.provider);
        await Promise.all(
          ready.map(async ({ index, prepared, key }, readyIndex) => {
            const response = responses[readyIndex];
            if (response === undefined) throw new Error('vision-result-missing');
            const result: AnalysedVisionResult = {
              disposition: 'analysed',
              kind: response.kind,
              markdown: response.markdown,
              alt: response.alt,
              confidence: response.confidence,
              ...(response.layoutBlocks === undefined
                ? {}
                : { layoutBlocks: response.layoutBlocks }),
              provider: this.provider.provider,
              model: this.provider.model,
              revisions,
              originalSha256: prepared.originalSha256,
              preprocessedSha256: prepared.preprocessedSha256,
              width: prepared.width,
              height: prepared.height,
              elapsedMs,
              cached: false,
              cacheKey: key.fingerprint,
            };
            results[index] = result;
            await this.cache?.put(key, dispatchIds[readyIndex] ?? null, result);
          }),
        );
        return this.requireResults(results);
      } catch (error) {
        const details = errorDetails(error);
        finalError = details.code;
        await Promise.all(
          ready.map(({ key }, index) =>
            this.cache?.markFailed(key, dispatchIds[index] ?? null, details.code, attempt),
          ),
        );
        if (!details.retry || attempt === this.maximumAttempts) break;
        await this.wait(this.initialBackoffMs * 2 ** (attempt - 1));
      }
    }
    for (const { index, prepared, key } of ready) {
      results[index] = {
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
    return this.requireResults(results);
  }

  private requireResults(results: readonly (VisionResult | undefined)[]): readonly VisionResult[] {
    if (results.some((result) => result === undefined)) throw new Error('vision-result-missing');
    return results as readonly VisionResult[];
  }
}
