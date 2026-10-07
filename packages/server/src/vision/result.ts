import type { ExtractedImage, VisionRequest, VisionResult } from '../extract/contract.js';
import { visionProvenance } from './contract.js';

export const extractedImageFromVision = (
  request: VisionRequest,
  sequence: number,
  result: VisionResult,
): ExtractedImage => {
  if (result.disposition === 'skipped') {
    return {
      id: request.imageId,
      sequence,
      mediaType: request.mediaType,
      bytes: request.bytes,
      width: result.width,
      height: result.height,
      disposition: 'skipped',
      skipReason: result.skipReason,
    };
  }
  const common = {
    id: request.imageId,
    sequence,
    mediaType: request.mediaType,
    bytes: request.bytes,
    ...(result.width === undefined ? {} : { width: result.width }),
    ...(result.height === undefined ? {} : { height: result.height }),
    disposition: result.disposition,
    visionModel: result.model,
    visionProvider: result.provider,
    visionAlt: result.alt,
    visionRevisions: result.revisions,
    visionCacheKey: result.cacheKey,
    ...(result.disposition === 'analysed' ? { visionCached: result.cached } : {}),
    ...(result.preprocessedSha256 === undefined
      ? {}
      : { preprocessedSha256: result.preprocessedSha256 }),
  } as const;
  return result.disposition === 'pending_vision'
    ? { ...common, lastErrorCode: result.errorCode }
    : {
        ...common,
        visionKind: result.kind,
        visionMarkdown: result.markdown,
        visionConfidence: result.confidence,
      };
};

export const markdownFromVision = (request: VisionRequest, result: VisionResult): string => {
  if (result.disposition === 'skipped') return '';
  if (result.disposition === 'pending_vision') {
    return `<!-- noderag:vision-pending image-sha256="${result.originalSha256}" error="${result.errorCode}" -->\n[${result.alt}]\n<!-- /noderag:vision-pending -->`;
  }
  return visionProvenance({
    imageSha256: result.originalSha256,
    pageNumber: request.pageNumber,
    kind: result.kind,
    provider: result.provider,
    model: result.model,
    revisions: result.revisions,
    markdown: result.markdown,
  });
};
