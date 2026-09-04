import { z } from 'zod';
import { visionKinds, type VisionKind, type VisionRevisions } from '../extract/contract.js';

export const VISION_PROVIDER_CONTRACT_VERSION = 'vision-provider.v1';
export const VISION_PROMPT_REVISION = 'vision-transcription.v1';
export const VISION_SCHEMA_REVISION = 'vision-result.v1';
export const VISION_PREPROCESSING_REVISION = 'vision-preprocess.v1';

export const visionResponseSchema = z
  .object({
    kind: z.enum(visionKinds),
    markdown: z.string().max(200_000),
    alt: z.string().min(1).max(2_000),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type ValidatedVisionResponse = z.infer<typeof visionResponseSchema>;

export interface VisionProviderRequest {
  readonly bytes: Uint8Array;
  readonly mediaType: 'image/png';
  readonly sourceKind: 'pdf-page' | 'document-image' | 'worksheet-image';
  readonly pageNumber: number | null;
  readonly imageId: string;
  readonly prompt: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface VisionProvider {
  readonly provider: string;
  readonly model: string;
  readonly modelRevision: string;
  readonly contractVersion: typeof VISION_PROVIDER_CONTRACT_VERSION;
  analyse(request: VisionProviderRequest): Promise<ValidatedVisionResponse>;
}

export type VisionErrorClass = 'transient' | 'permanent';

export class VisionProviderError extends Error {
  readonly code: string;
  readonly classification: VisionErrorClass;

  constructor(code: string, classification: VisionErrorClass, options?: ErrorOptions) {
    super(code, options);
    this.name = 'VisionProviderError';
    this.code = code;
    this.classification = classification;
  }
}

export const visionRevisions = (provider: VisionProvider): VisionRevisions => ({
  provider: provider.contractVersion,
  model: provider.modelRevision,
  prompt: VISION_PROMPT_REVISION,
  schema: VISION_SCHEMA_REVISION,
  preprocessing: VISION_PREPROCESSING_REVISION,
});

export const VISION_TRANSCRIPTION_PROMPT = [
  'Transcribe the supplied image into searchable Markdown.',
  'Preserve visible facts, labels, table cells, chart legends, axes, relationships, and formulas.',
  'Do not infer facts that are not visible. Do not wrap the Markdown in a code fence.',
  'Return only an object that exactly matches the supplied JSON schema.',
].join(' ');

export const ollamaVisionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'markdown', 'alt', 'confidence'],
  properties: {
    kind: { type: 'string', enum: [...visionKinds] },
    markdown: { type: 'string' },
    alt: { type: 'string', minLength: 1, maxLength: 2000 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

export const visionProvenance = (input: {
  readonly imageSha256: string;
  readonly pageNumber: number | null;
  readonly kind: VisionKind;
  readonly provider: string;
  readonly model: string;
  readonly revisions: VisionRevisions;
  readonly markdown: string;
}): string => {
  const attributes = [
    `image-sha256="${input.imageSha256}"`,
    input.pageNumber === null ? null : `page="${String(input.pageNumber)}"`,
    `kind="${input.kind}"`,
    `provider="${input.provider}"`,
    `model="${input.model}"`,
    `provider-revision="${input.revisions.provider}"`,
    `model-revision="${input.revisions.model}"`,
    `prompt-revision="${input.revisions.prompt}"`,
    `schema-revision="${input.revisions.schema}"`,
    `preprocessing-revision="${input.revisions.preprocessing}"`,
  ].filter((value): value is string => value !== null);
  return `<!-- noderag:vision ${attributes.join(' ')} -->\n${input.markdown}\n<!-- /noderag:vision -->`;
};
