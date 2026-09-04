import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as PdfJs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  ExtractedDocument,
  ExtractedPage,
  ExtractionOptions,
  InjectedVision,
} from './contract.js';

interface PositionedText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly hasEol: boolean;
  readonly renderMode: number | null;
}

interface PdfTextItem {
  readonly str: string;
  readonly transform: readonly unknown[];
  readonly width: number;
  readonly height: number;
  readonly hasEOL: boolean;
}

interface PdfCandidate {
  readonly page: ExtractedPage;
  readonly quality: number;
  readonly needsVision: boolean;
}

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

const groupLines = (items: readonly PositionedText[]): Array<readonly PositionedText[]> => {
  const ordered = [...items].sort((left, right) => right.y - left.y || left.x - right.x);
  const lines: PositionedText[][] = [];
  for (const item of ordered) {
    const tolerance = Math.max(1.5, item.height * 0.45);
    const line = lines.find(
      (candidate) => Math.abs((candidate[0]?.y ?? item.y) - item.y) <= tolerance,
    );
    if (line === undefined) lines.push([item]);
    else line.push(item);
  }
  for (const line of lines) line.sort((left, right) => left.x - right.x);
  return lines;
};

const lineText = (items: readonly PositionedText[]): string => {
  let output = '';
  let previousEnd: number | null = null;
  for (const item of items) {
    if (previousEnd !== null && output.length > 0 && !/\s$/u.test(output)) {
      const averageWidth = item.text.length > 0 ? item.width / item.text.length : item.height * 0.5;
      if (item.x - previousEnd > Math.max(1.5, averageWidth * 0.55)) output += ' ';
    }
    output += item.text;
    previousEnd = Math.max(previousEnd ?? item.x, item.x + item.width);
  }
  return output.trim();
};

const orderLines = (
  lines: Array<readonly PositionedText[]>,
  pageWidth: number,
): Array<readonly PositionedText[]> => {
  if (lines.length < 4) return lines.sort((left, right) => (right[0]?.y ?? 0) - (left[0]?.y ?? 0));
  const starts = lines.map((line) => line[0]?.x ?? 0).sort((left, right) => left - right);
  let bestGap = 0;
  let split = 0;
  for (let index = 1; index < starts.length; index += 1) {
    const gap = (starts[index] ?? 0) - (starts[index - 1] ?? 0);
    if (gap > bestGap) {
      bestGap = gap;
      split = ((starts[index] ?? 0) + (starts[index - 1] ?? 0)) / 2;
    }
  }
  if (bestGap < pageWidth * 0.16) {
    return lines.sort((left, right) => (right[0]?.y ?? 0) - (left[0]?.y ?? 0));
  }
  const left = lines.filter((line) => (line[0]?.x ?? 0) < split);
  const right = lines.filter((line) => (line[0]?.x ?? 0) >= split);
  if (left.length < 2 || right.length < 2) {
    return lines.sort((a, b) => (b[0]?.y ?? 0) - (a[0]?.y ?? 0));
  }
  const vertical = (a: readonly PositionedText[], b: readonly PositionedText[]) =>
    (b[0]?.y ?? 0) - (a[0]?.y ?? 0);
  return [...left.sort(vertical), ...right.sort(vertical)];
};

const joinHyphenation = (lines: readonly string[]): string => {
  const output: string[] = [];
  for (const line of lines) {
    const previous = output.at(-1);
    if (previous !== undefined && /[\p{L}]-$/u.test(previous) && /^\p{Ll}/u.test(line)) {
      output[output.length - 1] = `${previous.slice(0, -1)}${line}`;
    } else output.push(line);
  }
  return output.join('\n');
};

const qualityScore = (text: string, items: readonly PositionedText[]): number => {
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

export const extractPdf = async (
  bytes: Uint8Array,
  options: ExtractionOptions = {},
  injectedVision?: InjectedVision,
): Promise<ExtractedDocument> => {
  const { getDocument, OPS } = await loadPdfJs();
  const task = getDocument({
    data: Uint8Array.from(bytes),
    useWorkerFetch: false,
  });
  try {
    const pdf = await task.promise;
    const maximumPages = options.maximumPages ?? 1000;
    if (pdf.numPages > maximumPages) throw new Error('pdf-page-limit-exceeded');
    const candidates: PdfCandidate[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const [content, operations] = await Promise.all([
        page.getTextContent({ includeMarkedContent: true, disableNormalization: true }),
        page.getOperatorList(),
      ]);
      const modes = renderModes(operations, OPS);
      let itemIndex = 0;
      const positioned: PositionedText[] = [];
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
        positioned.push({
          text,
          x,
          y,
          width: Math.abs(textItem.width),
          height: Math.max(1, Math.abs(textItem.height)),
          hasEol: textItem.hasEOL,
          renderMode: mode,
        });
      }
      const viewport = page.getViewport({ scale: 1 });
      const lines = orderLines(groupLines(positioned), viewport.width)
        .map(lineText)
        .filter((line) => line.length > 0);
      const body = joinHyphenation(lines);
      const quality = qualityScore(body, positioned);
      const characters = [...body];
      const replacementRatio =
        characters.length === 0
          ? 1
          : characters.filter((character) => character === '\uFFFD').length / characters.length;
      const privateRatio =
        characters.length === 0
          ? 1
          : characters.filter((character) => /\p{Co}/u.test(character)).length / characters.length;
      candidates.push({
        quality,
        needsVision:
          body.trim().length === 0 ||
          quality < 0.45 ||
          replacementRatio > 0.03 ||
          privateRatio > 0.02,
        page: {
          ordinal: pageNumber - 1,
          pageNumber,
          label: String(pageNumber),
          body,
          extraction: 'text',
          confidence: quality,
          warnings: [],
          images: [],
          metadata: {
            width: viewport.width,
            height: viewport.height,
            glyphRuns: positioned.length,
            renderModes: [...new Set(positioned.map(({ renderMode }) => renderMode))],
          },
        },
      });
      page.cleanup();
    }
    const usable = candidates.map(({ quality }) => quality).filter((quality) => quality > 0);
    const median = usable.sort((left, right) => left - right)[Math.floor(usable.length / 2)] ?? 0;
    const pages: ExtractedPage[] = [];
    for (const candidate of candidates) {
      const needsVision =
        candidate.needsVision || (median >= 0.7 && candidate.quality < median * 0.5);
      if (!needsVision) {
        pages.push(candidate.page);
        continue;
      }
      const warning = 'pdf-page-vision-required';
      if (injectedVision === undefined) {
        pages.push({
          ...candidate.page,
          body: '',
          extraction: 'vision',
          confidence: 0,
          warnings: [warning],
        });
        continue;
      }
      const imageId = createHash('sha256')
        .update(bytes)
        .update(`:${String(candidate.page.pageNumber)}`)
        .digest('hex');
      const vision = await injectedVision.analyse({
        kind: 'pdf-page',
        bytes,
        mediaType: 'application/pdf',
        pageNumber: candidate.page.pageNumber,
        imageId,
      });
      pages.push({
        ...candidate.page,
        body: vision.markdown,
        extraction: candidate.page.body.length > 0 ? 'mixed' : 'vision',
        confidence: vision.confidence,
        warnings: [warning],
        metadata: {
          ...candidate.page.metadata,
          visionKind: vision.kind,
          visionModel: vision.model,
        },
      });
    }
    return {
      format: 'pdf',
      pages,
      pageBasis: 'exact',
      encoding: null,
      encodingConfidence: null,
      offsetsMatchOriginal: false,
      warnings: pages.flatMap(({ warnings }) => warnings),
      metadata: { pdfPages: pages.length, medianTextQuality: median },
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
