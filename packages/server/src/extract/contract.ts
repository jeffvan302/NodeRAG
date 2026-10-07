export type DocumentFormat = 'md' | 'txt' | 'pdf' | 'docx' | 'xlsx';
export type PageBasis = 'exact' | 'sheet' | 'rendered' | 'explicit' | 'none';
export type ExtractionMethod = 'text' | 'vision' | 'mixed';

export const extractedBlockKinds = [
  'title',
  'heading',
  'paragraph',
  'list-item',
  'table',
  'caption',
  'footnote',
  'header',
  'footer',
  'code',
  'unknown',
] as const;
export type ExtractedBlockKind = (typeof extractedBlockKinds)[number];

export interface NormalizedBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BlockConfidence {
  readonly text: number;
  readonly readingOrder: number;
  readonly structure: number;
  readonly combined: number;
  readonly components?: Readonly<Record<string, number>>;
}

export type ExtractionRoutingDisposition = 'native-safe' | 'regional-vision' | 'full-page-vision';

export interface ExtractionRoutingDecision {
  readonly disposition: ExtractionRoutingDisposition;
  readonly reasons: readonly string[];
}

export interface ExtractionRevisions {
  readonly parser: string;
  readonly layout: string;
  readonly confidence: string;
  readonly visionPrompt?: string;
  readonly visionSchema?: string;
  readonly preprocessing?: string;
  readonly model?: string;
}

export interface ExtractedBlock {
  readonly ordinal: number;
  readonly kind: ExtractedBlockKind;
  readonly source: ExtractionMethod;
  readonly text: string;
  readonly markdown: string;
  readonly bounds: NormalizedBoundingBox | null;
  readonly readingOrder: number;
  readonly confidence: BlockConfidence;
  readonly routing?: ExtractionRoutingDecision;
  readonly warnings: readonly string[];
  readonly revisions: ExtractionRevisions;
}

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
  /** True when the accepted provider result was served from the revisioned vision cache. */
  readonly visionCached?: boolean;
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
  /**
   * Ordered extraction provenance. Legacy adapters may omit blocks; assembly then creates one
   * page-sized compatibility block without changing canonical Markdown.
   */
  readonly blocks?: readonly ExtractedBlock[];
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

export interface AssembledBlock extends ExtractedBlock {
  readonly characterStart: number;
  readonly characterEnd: number;
  readonly byteStart: number;
  readonly byteEnd: number;
}

export interface AssembledPage extends Omit<ExtractedPage, 'blocks'> {
  readonly characterStart: number;
  readonly characterEnd: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly blocks: readonly AssembledBlock[];
}

export interface AssembledDocument extends Omit<ExtractedDocument, 'pages'> {
  readonly markdown: string;
  readonly pages: readonly AssembledPage[];
}

export interface VisionRequest {
  readonly kind: 'pdf-page' | 'pdf-region' | 'document-image' | 'worksheet-image';
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly pageNumber: number | null;
  readonly imageId: string;
  readonly region?: NormalizedBoundingBox;
  readonly targetBlockOrdinal?: number;
  /** Adapter-specific rendering/crop policy included in the cache identity. */
  readonly sourcePolicyRevision?: string;
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

export interface VisionLayoutBlock {
  readonly kind: ExtractedBlockKind;
  readonly markdown: string;
  readonly text: string;
  readonly confidence: number;
  /** One-based image position in the provider request. */
  readonly sourceImageIndex: number;
  /** Coordinates relative to the supplied page or crop. */
  readonly bounds: NormalizedBoundingBox;
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
  readonly layoutBlocks?: readonly VisionLayoutBlock[];
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
  readonly maximumImagesPerCall?: number;
  readonly maximumParallelCalls?: number;
  analyse(request: VisionRequest): Promise<VisionResult>;
  analyseMany?(requests: readonly VisionRequest[]): Promise<readonly VisionResult[]>;
}

export const analyseVisionRequests = async (
  vision: InjectedVision,
  requests: readonly VisionRequest[],
): Promise<readonly VisionResult[]> =>
  vision.analyseMany === undefined
    ? Promise.all(requests.map((request) => vision.analyse(request)))
    : vision.analyseMany(requests);

export interface ExtractionProgress {
  readonly stage:
    'extracting-pages' | 'classifying-layout' | 'analysing-pages' | 'reconciling-vision';
  readonly completed: number;
  readonly total: number;
  readonly routing?: {
    readonly nativeSafeBlocks: number;
    readonly regionalVisionBlocks: number;
    readonly fullPageVisionPages: number;
  };
}

export interface ExtractionOptions {
  readonly maximumPages?: number;
  readonly maximumZipEntries?: number;
  readonly maximumUncompressedBytes?: number;
  readonly maximumWorkbookCells?: number;
  readonly wideSheetColumns?: number;
  readonly onProgress?: (progress: ExtractionProgress) => void | Promise<void>;
}

export type PureExtractor = (
  bytes: Uint8Array,
  options?: ExtractionOptions,
  injectedVision?: InjectedVision,
) => Promise<ExtractedDocument>;
