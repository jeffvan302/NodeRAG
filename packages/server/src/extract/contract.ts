export type DocumentFormat = 'md' | 'txt' | 'pdf' | 'docx' | 'xlsx';
export type PageBasis = 'exact' | 'sheet' | 'rendered' | 'explicit' | 'none';
export type ExtractionMethod = 'text' | 'vision' | 'mixed';

export interface ExtractedImage {
  readonly id: string;
  readonly sequence: number;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly width?: number;
  readonly height?: number;
  readonly disposition: 'analysed' | 'pending_vision' | 'skipped';
  readonly skipReason?: string;
  readonly visionModel?: string;
  readonly visionProvider?: string;
  readonly visionKind?: VisionKind;
  readonly visionMarkdown?: string;
  readonly visionAlt?: string;
  readonly visionConfidence?: number;
  readonly visionRevisions?: VisionRevisions;
  readonly preprocessedSha256?: string;
  readonly visionCacheKey?: string;
  readonly lastErrorCode?: string;
}

export interface ExtractedPage {
  readonly ordinal: number;
  readonly pageNumber: number | null;
  readonly label: string | null;
  readonly body: string;
  readonly extraction: ExtractionMethod;
  readonly confidence: number;
  readonly warnings: readonly string[];
  readonly images: readonly ExtractedImage[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ExtractedDocument {
  readonly format: DocumentFormat;
  readonly pages: readonly ExtractedPage[];
  readonly pageBasis: PageBasis;
  readonly encoding: string | null;
  readonly encodingConfidence: number | null;
  readonly offsetsMatchOriginal: boolean;
  readonly warnings: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AssembledPage extends ExtractedPage {
  readonly characterStart: number;
  readonly characterEnd: number;
  readonly byteStart: number;
  readonly byteEnd: number;
}

export interface AssembledDocument extends Omit<ExtractedDocument, 'pages'> {
  readonly markdown: string;
  readonly pages: readonly AssembledPage[];
}

export interface VisionRequest {
  readonly kind: 'pdf-page' | 'document-image' | 'worksheet-image';
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly pageNumber: number | null;
  readonly imageId: string;
}

export const visionKinds = [
  'table',
  'chart',
  'diagram',
  'screenshot',
  'photo',
  'formula',
  'logo',
  'decorative',
] as const;

export type VisionKind = (typeof visionKinds)[number];

export interface VisionRevisions {
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  readonly schema: string;
  readonly preprocessing: string;
}

export interface AnalysedVisionResult {
  readonly disposition: 'analysed';
  readonly kind: VisionKind;
  readonly markdown: string;
  readonly alt: string;
  readonly confidence: number;
  readonly provider: string;
  readonly model: string;
  readonly revisions: VisionRevisions;
  readonly originalSha256: string;
  readonly preprocessedSha256: string;
  readonly width: number;
  readonly height: number;
  readonly elapsedMs: number;
  readonly cached: boolean;
  readonly cacheKey: string;
}

export interface PendingVisionResult {
  readonly disposition: 'pending_vision';
  readonly alt: string;
  readonly errorCode: string;
  readonly provider: string;
  readonly model: string;
  readonly revisions: VisionRevisions;
  readonly originalSha256: string;
  readonly preprocessedSha256?: string;
  readonly width?: number;
  readonly height?: number;
  readonly cacheKey: string;
}

export interface SkippedVisionResult {
  readonly disposition: 'skipped';
  readonly alt: string;
  readonly skipReason: 'too-small' | 'extreme-aspect-ratio' | 'low-entropy';
  readonly originalSha256: string;
  readonly width: number;
  readonly height: number;
}

export type VisionResult = AnalysedVisionResult | PendingVisionResult | SkippedVisionResult;

export interface InjectedVision {
  analyse(request: VisionRequest): Promise<VisionResult>;
}

export interface ExtractionOptions {
  readonly maximumPages?: number;
  readonly maximumZipEntries?: number;
  readonly maximumUncompressedBytes?: number;
  readonly maximumWorkbookCells?: number;
  readonly wideSheetColumns?: number;
}

export type PureExtractor = (
  bytes: Uint8Array,
  options?: ExtractionOptions,
  injectedVision?: InjectedVision,
) => Promise<ExtractedDocument>;
