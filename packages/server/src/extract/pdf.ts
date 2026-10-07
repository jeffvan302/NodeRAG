import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import type * as PdfJs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  ExtractedBlock,
  ExtractedDocument,
  ExtractedImage,
  ExtractedPage,
  ExtractionOptions,
  InjectedVision,
  NormalizedBoundingBox,
  VisionRequest,
  VisionResult,
  VisionLayoutBlock,
} from './contract.js';
import { analyseVisionRequests } from './contract.js';
import {
  classifyPdfDocumentLayout,
  PDF_CONFIDENCE_POLICY_REVISION,
  PDF_EXTRACTION_VERSION,
  PDF_LAYOUT_POLICY_REVISION,
  PDF_PARSER_REVISION,
  type PdfLayoutPageInput,
  type PdfLayoutRun,
} from './pdf-layout.js';
import { extractedImageFromVision, markdownFromVision } from '../vision/result.js';
import { VISION_PROMPT_REVISION, VISION_SCHEMA_REVISION } from '../vision/contract.js';

interface PdfTextItem {
  readonly str: string;
  readonly transform: readonly unknown[];
  readonly width: number;
  readonly height: number;
  readonly hasEOL: boolean;
  readonly fontName?: string;
  readonly dir?: string;
}

interface PdfTextStyle {
  readonly fontFamily?: string;
  readonly ascent?: number;
  readonly descent?: number;
  readonly vertical?: boolean;
}

interface PdfCandidate {
  readonly page: ExtractedPage;
  readonly quality: number;
  readonly needsVision: boolean;
}

interface RenderedPdfVisionRequest {
  readonly candidateIndex: number;
  readonly candidate: PdfCandidate;
  readonly rendered: {
    readonly bytes: Uint8Array;
    readonly width: number;
    readonly height: number;
  };
  readonly request: VisionRequest;
}

export const PDF_CROP_POLICY_REVISION = 'pdf-crop.v1-margin-015';
const MINIMUM_ACCEPTED_VISION_CONFIDENCE = 0.6;

const loadPdfJs = async (): Promise<typeof PdfJs> => {
  const sourceRuntime = 'pdfjs-dist/legacy/build/pdf.mjs';
  const moduleSpecifier =
    typeof __filename === 'string' && __filename.endsWith('.cjs')
      ? pathToFileURL(join(__dirname, 'vendor', 'pdf.mjs')).href
      : sourceRuntime;
  return import(moduleSpecifier) as Promise<typeof PdfJs>;
};

const foldedLigatures = new Map([
  ['ﬁ', 'fi'],
  ['ﬂ', 'fl'],
  ['ﬀ', 'ff'],
  ['ﬃ', 'ffi'],
  ['ﬄ', 'ffl'],
]);

const foldLigatures = (value: string): string =>
  [...value].map((character) => foldedLigatures.get(character) ?? character).join('');

const renderModes = (
  operatorList: {
    readonly fnArray: readonly number[];
    readonly argsArray: readonly unknown[];
  },
  ops: typeof PdfJs.OPS,
): readonly number[] => {
  const modes: number[] = [];
  let current: number | null = null;
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    if (operation === ops.setTextRenderingMode) {
      const args = operatorList.argsArray[index];
      current = Array.isArray(args) && typeof args[0] === 'number' ? args[0] : null;
    } else if (
      operation === ops.showText ||
      operation === ops.showSpacedText ||
      operation === ops.nextLineShowText ||
      operation === ops.nextLineSetSpacingShowText
    ) {
      modes.push(current ?? 0);
    }
  }
  return modes;
};

const qualityScore = (text: string, items: readonly PdfLayoutRun[]): number => {
  if (text.trim().length === 0) return 0;
  const characters = [...text];
  const replacements = characters.filter((character) => character === '\uFFFD').length;
  const privateUse = characters.filter((character) => /\p{Co}/u.test(character)).length;
  const controls = characters.filter(
    (character) => /\p{Cc}/u.test(character) && character !== '\n' && character !== '\t',
  ).length;
  const oneCharacterItems = items.filter((item) => [...item.text].length === 1).length;
  const fragmented = items.length > 20 && oneCharacterItems / items.length > 0.85 ? 0.15 : 0;
  return Math.max(
    0,
    Math.min(
      1,
      1 -
        (replacements / characters.length) * 8 -
        (privateUse / characters.length) * 6 -
        (controls / characters.length) * 8 -
        fragmented,
    ),
  );
};

const renderPageImage = async (
  page: PdfJs.PDFPageProxy,
  bounds: NormalizedBoundingBox | null = null,
): Promise<{ readonly bytes: Uint8Array; readonly width: number; readonly height: number }> => {
  const viewport = page.getViewport({ scale: 2 });
  const margin = bounds === null ? 0 : 0.015;
  const leftRatio = bounds === null ? 0 : Math.max(0, bounds.x - margin);
  const topRatio = bounds === null ? 0 : Math.max(0, bounds.y - margin);
  const rightRatio = bounds === null ? 1 : Math.min(1, bounds.x + bounds.width + margin);
  const bottomRatio = bounds === null ? 1 : Math.min(1, bounds.y + bounds.height + margin);
  const left = Math.floor(leftRatio * viewport.width);
  const top = Math.floor(topRatio * viewport.height);
  const width = Math.max(1, Math.ceil((rightRatio - leftRatio) * viewport.width));
  const height = Math.max(1, Math.ceil((bottomRatio - topRatio) * viewport.height));
  const canvas = createCanvas(width, height);
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    viewport,
    ...(bounds === null ? {} : { transform: [1, 0, 0, 1, -left, -top] }),
    background: 'rgb(255,255,255)',
  }).promise;
  return { bytes: canvas.toBuffer('image/png'), width, height };
};

const blockKindFromVision = (vision: Extract<VisionResult, { disposition: 'analysed' }>) =>
  vision.kind === 'table'
    ? ('table' as const)
    : vision.kind === 'formula'
      ? ('code' as const)
      : ('unknown' as const);

const pageRelativeVisionBounds = (
  request: VisionRequest,
  block: VisionLayoutBlock | undefined,
): NormalizedBoundingBox => {
  const bounds = block?.bounds ?? { x: 0, y: 0, width: 1, height: 1 };
  if (request.region === undefined) return bounds;
  return {
    x: request.region.x + bounds.x * request.region.width,
    y: request.region.y + bounds.y * request.region.height,
    width: bounds.width * request.region.width,
    height: bounds.height * request.region.height,
  };
};

const acceptedVisionBlock = (
  native: ExtractedBlock | null,
  request: VisionRequest,
  vision: Extract<VisionResult, { disposition: 'analysed' }>,
  ordinal: number,
  layoutBlock?: VisionLayoutBlock,
): ExtractedBlock => ({
  ordinal,
  kind: layoutBlock?.kind ?? blockKindFromVision(vision),
  source: 'vision',
  text: layoutBlock?.text ?? vision.markdown,
  markdown: markdownFromVision(request, {
    ...vision,
    markdown: layoutBlock?.markdown ?? vision.markdown,
  }),
  bounds: pageRelativeVisionBounds(request, layoutBlock) ?? native?.bounds,
  readingOrder: native?.readingOrder ?? ordinal,
  confidence: {
    text: layoutBlock?.confidence ?? vision.confidence,
    readingOrder: layoutBlock?.confidence ?? vision.confidence,
    structure: layoutBlock?.confidence ?? vision.confidence,
    combined: layoutBlock?.confidence ?? vision.confidence,
    components: {
      providerConfidence: vision.confidence,
      blockConfidence: layoutBlock?.confidence ?? vision.confidence,
      reconciliationCoverage: 1,
    },
  },
  routing: {
    disposition: 'native-safe',
    reasons: [native === null ? 'full-page-vision-accepted' : 'regional-vision-accepted'],
  },
  warnings: [
    native === null ? 'vision-full-page-replaced-native' : 'vision-region-replaced-native',
  ],
  revisions: {
    parser: PDF_PARSER_REVISION,
    layout: PDF_LAYOUT_POLICY_REVISION,
    confidence: PDF_CONFIDENCE_POLICY_REVISION,
    visionPrompt: vision.revisions.prompt,
    visionSchema: vision.revisions.schema,
    preprocessing: vision.revisions.preprocessing,
    model: vision.revisions.model,
  },
});

const acceptedVisionBlocks = (
  native: ExtractedBlock | null,
  request: VisionRequest,
  vision: Extract<VisionResult, { disposition: 'analysed' }>,
  ordinal: number,
): readonly ExtractedBlock[] =>
  (vision.layoutBlocks ?? [undefined]).map((block, index) =>
    acceptedVisionBlock(native, request, vision, ordinal + index, block),
  );

const visionImage = (
  request: VisionRequest,
  sequence: number,
  vision: VisionResult,
  accepted: boolean,
): ExtractedImage => {
  const image = extractedImageFromVision(request, sequence, vision);
  if (vision.disposition !== 'analysed' || accepted) return image;
  return {
    ...image,
    disposition: 'pending_vision',
    lastErrorCode: 'vision-low-confidence',
  };
};

const pdfPageFromVision = (item: RenderedPdfVisionRequest, vision: VisionResult): ExtractedPage => {
  const warning = 'pdf-page-vision-required';
  const accepted =
    vision.disposition === 'analysed' &&
    vision.confidence >= MINIMUM_ACCEPTED_VISION_CONFIDENCE &&
    vision.markdown.trim().length > 0;
  const image = visionImage(item.request, 0, vision, accepted);
  const blocks = accepted
    ? acceptedVisionBlocks(null, item.request, vision, 0)
    : (item.candidate.page.blocks ?? []);
  const body = accepted
    ? blocks.map(({ markdown }) => markdown).join('\n\n')
    : item.candidate.page.body;
  return {
    ...item.candidate.page,
    body,
    blocks,
    extraction: accepted ? 'vision' : item.candidate.page.body.length > 0 ? 'text' : 'vision',
    confidence: accepted ? vision.confidence : item.candidate.quality,
    warnings: [
      warning,
      ...(vision.disposition === 'pending_vision' ? ['pdf-page-vision-pending'] : []),
      ...(vision.disposition === 'skipped' ? [`pdf-page-image-skipped:${vision.skipReason}`] : []),
      ...(vision.disposition === 'analysed' && vision.confidence < 0.5
        ? ['pdf-page-low-vision-confidence', 'pdf-page-vision-retry-required']
        : []),
      ...(vision.disposition === 'analysed' && !accepted ? ['pdf-page-vision-not-accepted'] : []),
    ],
    images: [image],
    metadata: {
      ...item.candidate.page.metadata,
      renderWidth: item.rendered.width,
      renderHeight: item.rendered.height,
      ...(vision.disposition === 'analysed'
        ? {
            visionKind: vision.kind,
            visionModel: vision.model,
            visionAccepted: accepted,
            visionCached: vision.cached,
          }
        : {}),
    },
  };
};

const reconcilePdfRegion = (
  page: ExtractedPage,
  request: VisionRequest,
  rendered: RenderedPdfVisionRequest['rendered'],
  vision: VisionResult,
): ExtractedPage => {
  const targetOrdinal = request.targetBlockOrdinal;
  if (targetOrdinal === undefined) throw new Error('pdf-region-target-missing');
  const blocks = [...(page.blocks ?? [])];
  const targetIndex = blocks.findIndex(({ ordinal }) => ordinal === targetOrdinal);
  const target = blocks[targetIndex];
  if (target === undefined) throw new Error('pdf-region-target-not-found');
  const accepted =
    vision.disposition === 'analysed' &&
    vision.confidence >= MINIMUM_ACCEPTED_VISION_CONFIDENCE &&
    vision.markdown.trim().length > 0;
  if (accepted) {
    const replacements = acceptedVisionBlocks(target, request, vision, target.ordinal).map(
      (block, index) => ({ ...block, readingOrder: target.readingOrder + index / 1000 }),
    );
    blocks.splice(targetIndex, 1, ...replacements);
  } else {
    blocks[targetIndex] = {
      ...target,
      warnings: [
        ...target.warnings,
        ...(vision.disposition === 'pending_vision' ? ['pdf-region-vision-pending'] : []),
        ...(vision.disposition === 'skipped'
          ? [`pdf-region-image-skipped:${vision.skipReason}`]
          : []),
        ...(vision.disposition === 'analysed' ? ['pdf-region-vision-not-accepted'] : []),
      ],
    };
  }
  const orderedBlocks = blocks
    .sort((left, right) => left.readingOrder - right.readingOrder || left.ordinal - right.ordinal)
    .map((block, ordinal) => ({ ...block, ordinal, readingOrder: ordinal }));
  const body = orderedBlocks
    .map(({ markdown }) => markdown)
    .filter((markdown) => markdown.length > 0)
    .join('\n\n');
  const image = visionImage(request, page.images.length, vision, accepted);
  return {
    ...page,
    body,
    blocks: orderedBlocks,
    extraction: accepted ? 'mixed' : page.extraction,
    confidence:
      accepted && vision.disposition === 'analysed'
        ? Math.min(page.confidence, vision.confidence)
        : page.confidence,
    warnings: [
      ...page.warnings,
      ...(accepted ? ['pdf-region-vision-applied'] : ['pdf-region-vision-unresolved']),
    ],
    images: [...page.images, image],
    metadata: {
      ...page.metadata,
      visionRegionalAccepted:
        Number(page.metadata['visionRegionalAccepted'] ?? 0) + (accepted ? 1 : 0),
      visionRegionalUnresolved:
        Number(page.metadata['visionRegionalUnresolved'] ?? 0) + (accepted ? 0 : 1),
      visionCacheHits:
        Number(page.metadata['visionCacheHits'] ?? 0) +
        (vision.disposition === 'analysed' && vision.cached ? 1 : 0),
      cropPolicyRevision: PDF_CROP_POLICY_REVISION,
      lastRegionRenderWidth: rendered.width,
      lastRegionRenderHeight: rendered.height,
    },
  };
};

export const extractPdf = async (
  bytes: Uint8Array,
  options: ExtractionOptions = {},
  injectedVision?: InjectedVision,
): Promise<ExtractedDocument> => {
  const extractionStartedAt = performance.now();
  const { getDocument, OPS } = await loadPdfJs();
  const task = getDocument({
    data: Uint8Array.from(bytes),
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    const maximumPages = options.maximumPages ?? 1000;
    if (pdf.numPages > maximumPages) throw new Error('pdf-page-limit-exceeded');
    await options.onProgress?.({ stage: 'extracting-pages', completed: 0, total: pdf.numPages });
    const layoutInputs: PdfLayoutPageInput[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const [content, operations] = await Promise.all([
        page.getTextContent({ includeMarkedContent: true, disableNormalization: true }),
        page.getOperatorList(),
      ]);
      const modes = renderModes(operations, OPS);
      let itemIndex = 0;
      const positioned: PdfLayoutRun[] = [];
      const seen = new Set<string>();
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const textItem = item as PdfTextItem;
        const text = foldLigatures(textItem.str).normalize('NFC');
        const x = Number(textItem.transform[4] ?? 0);
        const y = Number(textItem.transform[5] ?? 0);
        const key = `${Math.round(x * 10)}:${Math.round(y * 10)}:${text}`;
        const mode = modes[itemIndex] ?? null;
        itemIndex += 1;
        if (text.length === 0 || seen.has(key)) continue;
        seen.add(key);
        const transform = textItem.transform.map((value) => Number(value));
        const fontSize = Math.max(
          1,
          Math.hypot(Number(transform[2] ?? 0), Number(transform[3] ?? textItem.height)),
          Math.abs(textItem.height),
        );
        const fontName = textItem.fontName ?? null;
        const style =
          fontName === null
            ? undefined
            : ((content.styles as Readonly<Record<string, PdfTextStyle>>)[fontName] ?? undefined);
        const fontDescriptor = `${fontName ?? ''} ${style?.fontFamily ?? ''}`;
        positioned.push({
          text,
          x,
          y,
          width: Math.abs(textItem.width),
          height: Math.max(1, Math.abs(textItem.height)),
          fontSize,
          fontName,
          fontFamily: style?.fontFamily ?? null,
          bold: /bold|black|heavy|semibold|demi/iu.test(fontDescriptor),
          italic: /italic|oblique/iu.test(fontDescriptor),
          direction: textItem.dir ?? (style?.vertical === true ? 'ttb' : null),
          transform,
          hasEol: textItem.hasEOL,
          renderMode: mode,
        });
      }
      const viewport = page.getViewport({ scale: 1 });
      layoutInputs.push({
        ordinal: pageNumber - 1,
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        runs: positioned,
      });
      page.cleanup();
      await options.onProgress?.({
        stage: 'extracting-pages',
        completed: pageNumber,
        total: pdf.numPages,
      });
    }
    await options.onProgress?.({ stage: 'classifying-layout', completed: 0, total: pdf.numPages });
    const classifiedPages = classifyPdfDocumentLayout(layoutInputs);
    const candidates: PdfCandidate[] = layoutInputs.map((layout, index) => {
      const classified = classifiedPages[index];
      if (classified === undefined) throw new Error('pdf-layout-page-result-missing');
      const quality = qualityScore(classified.body, layout.runs);
      const characters = [...classified.body];
      const replacementRatio =
        characters.length === 0
          ? 1
          : characters.filter((character) => character === '\uFFFD').length / characters.length;
      const privateRatio =
        characters.length === 0
          ? 1
          : characters.filter((character) => /\p{Co}/u.test(character)).length / characters.length;
      return {
        quality,
        needsVision:
          classified.body.trim().length === 0 ||
          quality < 0.45 ||
          replacementRatio > 0.03 ||
          privateRatio > 0.02,
        page: {
          ordinal: layout.ordinal,
          pageNumber: layout.pageNumber,
          label: String(layout.pageNumber),
          body: classified.body,
          blocks: classified.blocks,
          extraction: 'text',
          confidence: quality,
          warnings: classified.warnings,
          images: [],
          metadata: {
            width: layout.width,
            height: layout.height,
            glyphRuns: layout.runs.length,
            renderModes: [...new Set(layout.runs.map(({ renderMode }) => renderMode))],
            ...classified.metadata,
          },
        },
      };
    });
    await options.onProgress?.({
      stage: 'classifying-layout',
      completed: pdf.numPages,
      total: pdf.numPages,
      routing: {
        nativeSafeBlocks: classifiedPages.reduce(
          (total, page) => total + Number(page.metadata['nativeSafeBlocks'] ?? 0),
          0,
        ),
        regionalVisionBlocks: classifiedPages.reduce(
          (total, page) => total + Number(page.metadata['regionalVisionBlocks'] ?? 0),
          0,
        ),
        fullPageVisionPages: classifiedPages.filter(
          (page) => page.metadata['pageRouting'] === 'full-page-vision',
        ).length,
      },
    });
    const usable = candidates.map(({ quality }) => quality).filter((quality) => quality > 0);
    const median = usable.sort((left, right) => left - right)[Math.floor(usable.length / 2)] ?? 0;
    const pages: Array<ExtractedPage | undefined> = Array.from({ length: candidates.length });
    const visionCandidates: Array<{
      readonly candidateIndex: number;
      readonly candidate: PdfCandidate;
    }> = [];
    await options.onProgress?.({
      stage: 'analysing-pages',
      completed: 0,
      total: candidates.length,
    });
    let analysedCompleted = 0;
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const needsVision =
        candidate.needsVision || (median >= 0.7 && candidate.quality < median * 0.5);
      if (!needsVision) {
        pages[candidateIndex] = candidate.page;
        analysedCompleted += 1;
        continue;
      }
      const warning = 'pdf-page-vision-required';
      if (injectedVision === undefined) {
        pages[candidateIndex] = {
          ...candidate.page,
          body: '',
          blocks: [],
          extraction: 'vision',
          confidence: 0,
          warnings: [warning],
        };
        analysedCompleted += 1;
        continue;
      }
      visionCandidates.push({ candidateIndex, candidate });
    }
    await options.onProgress?.({
      stage: 'analysing-pages',
      completed: analysedCompleted,
      total: candidates.length,
    });
    if (injectedVision !== undefined) {
      const batchSize = Math.max(1, injectedVision.maximumImagesPerCall ?? 1);
      const windowSize = batchSize * Math.max(1, injectedVision.maximumParallelCalls ?? 1);
      for (let start = 0; start < visionCandidates.length; start += windowSize) {
        const group = visionCandidates.slice(start, start + windowSize);
        const renderedGroup = await Promise.all(
          group.map(async ({ candidateIndex, candidate }): Promise<RenderedPdfVisionRequest> => {
            const sourcePage = await pdf.getPage(
              candidate.page.pageNumber ?? candidate.page.ordinal + 1,
            );
            const rendered = await renderPageImage(sourcePage);
            sourcePage.cleanup();
            const imageId = createHash('sha256').update(rendered.bytes).digest('hex');
            return {
              candidateIndex,
              candidate,
              rendered,
              request: {
                kind: 'pdf-page',
                bytes: rendered.bytes,
                mediaType: 'image/png',
                pageNumber: candidate.page.pageNumber,
                imageId,
                sourcePolicyRevision: PDF_CROP_POLICY_REVISION,
              },
            };
          }),
        );
        const analysed = await analyseVisionRequests(
          injectedVision,
          renderedGroup.map(({ request }) => request),
        );
        for (const [groupIndex, item] of renderedGroup.entries()) {
          const vision = analysed[groupIndex];
          if (vision === undefined) throw new Error('vision-result-missing');
          pages[item.candidateIndex] = pdfPageFromVision(item, vision);
          analysedCompleted += 1;
          await options.onProgress?.({
            stage: 'analysing-pages',
            completed: analysedCompleted,
            total: candidates.length,
          });
        }
      }
    }
    if (pages.some((page) => page === undefined)) throw new Error('pdf-page-result-missing');
    const completedPages = pages as ExtractedPage[];
    const regionalCandidates = completedPages.flatMap((page, candidateIndex) =>
      (page.blocks ?? [])
        .filter(
          ({ routing, bounds }) => routing?.disposition === 'regional-vision' && bounds !== null,
        )
        .map((block) => ({ candidateIndex, block })),
    );
    await options.onProgress?.({
      stage: 'reconciling-vision',
      completed: injectedVision === undefined ? regionalCandidates.length : 0,
      total: regionalCandidates.length,
    });
    if (injectedVision !== undefined && regionalCandidates.length > 0) {
      const batchSize = Math.max(1, injectedVision.maximumImagesPerCall ?? 1);
      const windowSize = batchSize * Math.max(1, injectedVision.maximumParallelCalls ?? 1);
      let reconciled = 0;
      for (let start = 0; start < regionalCandidates.length; start += windowSize) {
        const group = regionalCandidates.slice(start, start + windowSize);
        const renderedGroup = await Promise.all(
          group.map(async ({ candidateIndex, block }): Promise<RenderedPdfVisionRequest> => {
            if (block.bounds === null) throw new Error('pdf-region-bounds-missing');
            const candidate = candidates[candidateIndex];
            if (candidate === undefined) throw new Error('pdf-region-page-missing');
            const sourcePage = await pdf.getPage(
              candidate.page.pageNumber ?? candidate.page.ordinal + 1,
            );
            const rendered = await renderPageImage(sourcePage, block.bounds);
            sourcePage.cleanup();
            const imageId = createHash('sha256').update(rendered.bytes).digest('hex');
            return {
              candidateIndex,
              candidate,
              rendered,
              request: {
                kind: 'pdf-region',
                bytes: rendered.bytes,
                mediaType: 'image/png',
                pageNumber: candidate.page.pageNumber,
                imageId,
                region: block.bounds,
                targetBlockOrdinal: block.ordinal,
                sourcePolicyRevision: PDF_CROP_POLICY_REVISION,
              },
            };
          }),
        );
        const analysed = await analyseVisionRequests(
          injectedVision,
          renderedGroup.map(({ request }) => request),
        );
        for (const [groupIndex, item] of renderedGroup.entries()) {
          const vision = analysed[groupIndex];
          if (vision === undefined) throw new Error('vision-result-missing');
          const currentPage = completedPages[item.candidateIndex];
          if (currentPage === undefined) throw new Error('pdf-region-page-missing');
          completedPages[item.candidateIndex] = reconcilePdfRegion(
            currentPage,
            item.request,
            item.rendered,
            vision,
          );
          reconciled += 1;
          await options.onProgress?.({
            stage: 'reconciling-vision',
            completed: reconciled,
            total: regionalCandidates.length,
          });
        }
      }
    }
    return {
      format: 'pdf',
      pages: completedPages,
      pageBasis: 'exact',
      encoding: null,
      encodingConfidence: null,
      offsetsMatchOriginal: false,
      warnings: completedPages.flatMap(({ warnings }) => warnings),
      metadata: {
        pdfPages: completedPages.length,
        medianTextQuality: median,
        pdfExtractionVersion: PDF_EXTRACTION_VERSION,
        parserRevision: PDF_PARSER_REVISION,
        layoutPolicyRevision: PDF_LAYOUT_POLICY_REVISION,
        confidencePolicyRevision: PDF_CONFIDENCE_POLICY_REVISION,
        visionPromptRevision: VISION_PROMPT_REVISION,
        visionSchemaRevision: VISION_SCHEMA_REVISION,
        cropPolicyRevision: PDF_CROP_POLICY_REVISION,
        regionalVisionCandidates: regionalCandidates.length,
        visionProviderCalls: completedPages.reduce(
          (total, page) =>
            total +
            page.images.filter(
              (image) =>
                image.disposition !== 'skipped' &&
                image.visionCacheKey !== undefined &&
                image.visionCached !== true,
            ).length,
          0,
        ),
        visionCacheHits: completedPages.reduce(
          (total, page) =>
            total +
            page.images.filter(
              (image) => image.disposition !== 'skipped' && image.visionCached === true,
            ).length,
          0,
        ),
        extractionElapsedMs: Math.max(0, Math.round(performance.now() - extractionStartedAt)),
      },
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (/password|encrypted/iu.test(error.message) || error.name === 'PasswordException')
    ) {
      throw new Error('pdf-encrypted-unsupported', { cause: error });
    }
    throw error;
  } finally {
    await task.destroy();
  }
};
