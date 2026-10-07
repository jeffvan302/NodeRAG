import type {
  BlockConfidence,
  ExtractedBlock,
  ExtractedBlockKind,
  ExtractionRoutingDecision,
  NormalizedBoundingBox,
} from './contract.js';

export const PDF_EXTRACTION_VERSION = 'pdf-layout.v3-hybrid';
export const PDF_PARSER_REVISION = 'pdfjs-dist@6.3.289';
export const PDF_LAYOUT_POLICY_REVISION = 'native-layout.v1';
export const PDF_CONFIDENCE_POLICY_REVISION = 'pdf-confidence.v1';
export const PDF_CONFIDENCE_THRESHOLDS = {
  nativeSafe: 0.82,
  regionalVision: 0.55,
} as const;

export interface PdfLayoutRun {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
  readonly fontName: string | null;
  readonly fontFamily: string | null;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly direction: string | null;
  readonly transform: readonly number[];
  readonly hasEol: boolean;
  readonly renderMode: number | null;
}

export interface PdfLayoutPageInput {
  readonly ordinal: number;
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly runs: readonly PdfLayoutRun[];
}

export interface ClassifiedPdfPage {
  readonly body: string;
  readonly blocks: readonly ExtractedBlock[];
  readonly warnings: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface LayoutLine {
  readonly id: number;
  readonly text: string;
  readonly runs: readonly PdfLayoutRun[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
  readonly bold: boolean;
  readonly italic: boolean;
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : (ordered[middle] ?? 0);
};

const lineText = (runs: readonly PdfLayoutRun[]): string => {
  let output = '';
  let previousEnd: number | null = null;
  for (const run of [...runs].sort((left, right) => left.x - right.x)) {
    if (previousEnd !== null && output.length > 0 && !/\s$/u.test(output)) {
      const characters = Math.max(1, [...run.text].length);
      const averageWidth = run.width / characters;
      if (run.x - previousEnd > Math.max(1.25, averageWidth * 0.48)) output += ' ';
    }
    output += run.text;
    previousEnd = Math.max(previousEnd ?? run.x, run.x + run.width);
  }
  return output.trim().replace(/[\t ]+/gu, ' ');
};

const buildLines = (page: PdfLayoutPageInput): readonly LayoutLine[] => {
  const baselines: PdfLayoutRun[][] = [];
  for (const run of [...page.runs].sort((left, right) => right.y - left.y || left.x - right.x)) {
    const tolerance = Math.max(1.25, run.fontSize * 0.22, run.height * 0.22);
    const baseline = baselines.find((candidate) => {
      const reference = median(candidate.map(({ y }) => y));
      const referenceSize = median(candidate.map(({ fontSize }) => fontSize));
      return Math.abs(reference - run.y) <= Math.max(tolerance, referenceSize * 0.22);
    });
    if (baseline === undefined) baselines.push([run]);
    else baseline.push(run);
  }

  const lines: LayoutLine[] = [];
  for (const baseline of baselines) {
    const ordered = [...baseline].sort((left, right) => left.x - right.x);
    const segments: PdfLayoutRun[][] = [];
    let current: PdfLayoutRun[] = [];
    for (const run of ordered) {
      const splitThreshold = Math.max(page.width * 0.035, run.fontSize * 3.2);
      if (run.text.trim().length === 0 && run.width > splitThreshold) {
        if (current.length > 0) segments.push(current);
        current = [];
        continue;
      }
      const previous = current.at(-1);
      const gap = previous === undefined ? 0 : run.x - (previous.x + previous.width);
      if (previous !== undefined && gap > splitThreshold) {
        segments.push(current);
        current = [];
      }
      current.push(run);
    }
    if (current.length > 0) segments.push(current);
    for (const segment of segments) {
      const text = lineText(segment);
      if (text.length === 0) continue;
      const x = Math.min(...segment.map((run) => run.x));
      const right = Math.max(...segment.map((run) => run.x + run.width));
      lines.push({
        id: lines.length,
        text,
        runs: segment,
        x,
        y: median(segment.map((run) => run.y)),
        width: Math.max(0, right - x),
        height: Math.max(...segment.map((run) => run.height)),
        fontSize: median(segment.map((run) => run.fontSize)),
        bold: segment.some((run) => run.bold),
        italic: segment.some((run) => run.italic),
      });
    }
  }
  return lines.sort((left, right) => right.y - left.y || left.x - right.x);
};

const furnitureKey = (line: LayoutLine, page: PdfLayoutPageInput): string | null => {
  const relativeY = line.y / page.height;
  if (relativeY < 0.08 || relativeY > 0.92) {
    return `${relativeY > 0.92 ? 'header' : 'footer'}:${line.text
      .toLocaleLowerCase('en')
      .replace(/\p{N}+/gu, '#')
      .replace(/\s+/gu, ' ')
      .trim()}`;
  }
  return null;
};

const repeatedFurniture = (
  pages: readonly PdfLayoutPageInput[],
  lines: readonly (readonly LayoutLine[])[],
): ReadonlySet<string> => {
  const pagesByKey = new Map<string, Set<number>>();
  for (const [pageIndex, pageLines] of lines.entries()) {
    const page = pages[pageIndex];
    if (page === undefined) continue;
    for (const line of pageLines) {
      const key = furnitureKey(line, page);
      if (key === null) continue;
      const seenPages = pagesByKey.get(key) ?? new Set<number>();
      seenPages.add(page.ordinal);
      pagesByKey.set(key, seenPages);
    }
  }
  return new Set(
    [...pagesByKey.entries()].filter(([, seenPages]) => seenPages.size >= 2).map(([key]) => key),
  );
};

const dominantFontSize = (lines: readonly LayoutLine[]): number => {
  const weights = new Map<number, { count: number; characters: number }>();
  for (const line of lines) {
    const key = Math.round(line.fontSize * 2) / 2;
    const current = weights.get(key) ?? { count: 0, characters: 0 };
    weights.set(key, {
      count: current.count + 1,
      characters: current.characters + Math.max(1, [...line.text].length),
    });
  }
  return (
    [...weights.entries()].sort(
      ([leftSize, leftWeight], [rightSize, rightWeight]) =>
        rightWeight.count - leftWeight.count ||
        rightWeight.characters - leftWeight.characters ||
        leftSize - rightSize,
    )[0]?.[0] ?? 12
  );
};

const boundsForLines = (
  lines: readonly LayoutLine[],
  page: PdfLayoutPageInput,
): NormalizedBoundingBox | null => {
  if (lines.length === 0 || page.width <= 0 || page.height <= 0) return null;
  const left = Math.min(...lines.map((line) => line.x));
  const right = Math.max(...lines.map((line) => line.x + line.width));
  const bottom = Math.min(...lines.map((line) => line.y));
  const top = Math.max(...lines.map((line) => line.y + line.height));
  const normalizedLeft = clamp01(left / page.width);
  const normalizedRight = clamp01(right / page.width);
  const normalizedTop = clamp01(1 - top / page.height);
  const normalizedBottom = clamp01(1 - bottom / page.height);
  return {
    x: Math.min(normalizedLeft, normalizedRight),
    y: Math.min(normalizedTop, normalizedBottom),
    width: Math.abs(normalizedRight - normalizedLeft),
    height: Math.abs(normalizedBottom - normalizedTop),
  };
};

const confidenceFor = (
  kind: ExtractedBlockKind,
  lines: readonly LayoutLine[],
  warnings: readonly string[] = [],
): BlockConfidence => {
  const characters = [...lines.map(({ text }) => text).join('\n')];
  const characterCount = Math.max(1, characters.length);
  const replacementRatio =
    characters.filter((character) => character === '\uFFFD').length / characterCount;
  const privateUseRatio =
    characters.filter((character) => /\p{Co}/u.test(character)).length / characterCount;
  const controlRatio =
    characters.filter(
      (character) => /\p{Cc}/u.test(character) && character !== '\n' && character !== '\t',
    ).length / characterCount;
  const oneCharacterRuns = lines
    .flatMap(({ runs }) => runs)
    .filter(({ text }) => [...text].length === 1);
  const runCount = Math.max(1, lines.flatMap(({ runs }) => runs).length);
  const fragmentationRatio = oneCharacterRuns.length / runCount;
  const text = clamp01(
    0.99 -
      replacementRatio * 8 -
      privateUseRatio * 6 -
      controlRatio * 8 -
      (runCount > 20 && fragmentationRatio > 0.85 ? 0.18 : 0),
  );
  const readingOrder = warnings.includes('layout-reading-order-ambiguous') ? 0.62 : 0.94;
  const classifierMargin =
    kind === 'unknown' ? 0.38 : kind === 'table' ? 0.9 : kind === 'paragraph' ? 0.94 : 0.88;
  const fontSizes = lines.map(({ fontSize }) => fontSize);
  const fontMedian = median(fontSizes);
  const fontDeviation =
    fontMedian === 0
      ? 0
      : median(fontSizes.map((fontSize) => Math.abs(fontSize - fontMedian) / fontMedian));
  const documentConsistency = clamp01(1 - fontDeviation);
  const tableAlignment = kind === 'table' ? 0.95 : kind === 'unknown' ? 0.35 : 1;
  const structure = clamp01(classifierMargin * 0.7 + tableAlignment * 0.3);
  const combined = clamp01(
    text * 0.4 + readingOrder * 0.22 + structure * 0.28 + documentConsistency * 0.1,
  );
  return {
    text: Math.round(text * 1000) / 1000,
    readingOrder: Math.round(readingOrder * 1000) / 1000,
    structure: Math.round(structure * 1000) / 1000,
    combined: Math.round(combined * 1000) / 1000,
    components: {
      textIntegrity: Math.round(text * 1000) / 1000,
      replacementIntegrity: Math.round(clamp01(1 - replacementRatio * 8) * 1000) / 1000,
      privateUseIntegrity: Math.round(clamp01(1 - privateUseRatio * 6) * 1000) / 1000,
      controlCharacterIntegrity: Math.round(clamp01(1 - controlRatio * 8) * 1000) / 1000,
      glyphContinuity:
        Math.round(clamp01(1 - (fragmentationRatio > 0.85 ? fragmentationRatio * 0.2 : 0)) * 1000) /
        1000,
      readingOrder,
      classifierMargin,
      tableAlignment,
      documentConsistency: Math.round(documentConsistency * 1000) / 1000,
    },
  };
};

export const routePdfBlock = (
  kind: ExtractedBlockKind,
  confidence: BlockConfidence,
  warnings: readonly string[],
): ExtractionRoutingDecision => {
  if (
    confidence.text < PDF_CONFIDENCE_THRESHOLDS.regionalVision ||
    confidence.combined < PDF_CONFIDENCE_THRESHOLDS.regionalVision
  ) {
    return {
      disposition: 'full-page-vision',
      reasons: [confidence.text < 0.55 ? 'text-integrity-low' : 'combined-confidence-low'],
    };
  }
  if (
    kind === 'unknown' ||
    warnings.includes('complex-table-fallback') ||
    confidence.combined < PDF_CONFIDENCE_THRESHOLDS.nativeSafe
  ) {
    return {
      disposition: 'regional-vision',
      reasons: [
        ...(warnings.includes('complex-table-fallback') ? ['complex-table-structure'] : []),
        ...(kind === 'unknown' ? ['unclassified-layout-region'] : []),
        ...(confidence.combined < PDF_CONFIDENCE_THRESHOLDS.nativeSafe
          ? ['confidence-review-band']
          : []),
      ],
    };
  }
  return { disposition: 'native-safe', reasons: ['confidence-at-or-above-native-threshold'] };
};

const revisions = {
  parser: PDF_PARSER_REVISION,
  layout: PDF_LAYOUT_POLICY_REVISION,
  confidence: PDF_CONFIDENCE_POLICY_REVISION,
} as const;

const markdownHeading = (text: string, level: number): string =>
  `${'#'.repeat(Math.max(1, Math.min(6, level)))} ${text}`;

const isListLine = (line: LayoutLine): boolean =>
  /^(?:[-*•]|\d+[.)]|[A-Za-z][.)]|[ivxlcdm]+[.)])\s+/iu.test(line.text);

const listMarkdown = (line: LayoutLine, listBaseX: number, bodyFontSize: number): string => {
  const depth = Math.max(0, Math.round((line.x - listBaseX) / Math.max(12, bodyFontSize * 1.5)));
  const normalized = line.text.replace(/^•\s+/u, '- ');
  return `${'  '.repeat(Math.min(4, depth))}${normalized}`;
};

const paragraphMarkdown = (lines: readonly LayoutLine[]): string => {
  const output: string[] = [];
  for (const line of lines) {
    const previous = output.at(-1);
    if (previous !== undefined && /[\p{L}\p{N}]-$/u.test(previous) && /^\p{Ll}/u.test(line.text)) {
      output[output.length - 1] = `${previous.slice(0, -1)}${line.text}`;
    } else output.push(line.text);
  }
  return output.join(' ');
};

interface TableCandidate {
  readonly lines: readonly LayoutLine[];
  readonly markdown: string;
  readonly kind: 'simple' | 'complex';
}

const tableCandidate = (
  lines: readonly LayoutLine[],
  page: PdfLayoutPageInput,
): TableCandidate | null => {
  const rows: LayoutLine[][] = [];
  for (const line of [...lines].sort((left, right) => right.y - left.y || left.x - right.x)) {
    const row = rows.find(
      (candidate) =>
        Math.abs((candidate[0]?.y ?? line.y) - line.y) <= Math.max(2, line.height * 0.3),
    );
    if (row === undefined) rows.push([line]);
    else row.push(line);
  }
  const multiCellRows = rows
    .filter((row) => row.length >= 2)
    .map((row) => [...row].sort((left, right) => left.x - right.x));
  if (multiCellRows.length < 3) return null;
  const tableLines = multiCellRows.flat();
  const rowCounts = new Set(multiCellRows.map((row) => row.length));
  const expectedColumns = Math.max(...multiCellRows.map((row) => row.length));
  const anchors = Array.from({ length: expectedColumns }, (_, column) =>
    median(
      multiCellRows
        .map((row) => row[column]?.x)
        .filter((value): value is number => value !== undefined),
    ),
  );
  const aligned = multiCellRows.every(
    (row) =>
      row.length === expectedColumns &&
      row.every(
        (cell, column) => Math.abs(cell.x - (anchors[column] ?? cell.x)) <= page.width * 0.025,
      ),
  );
  if (rowCounts.size !== 1 || !aligned) {
    const text = rows
      .filter((row) => row.some((line) => tableLines.some((candidate) => candidate.id === line.id)))
      .map((row) =>
        row
          .sort((left, right) => left.x - right.x)
          .map(({ text }) => text)
          .join(' | '),
      )
      .join('\n');
    return {
      lines: tableLines,
      kind: 'complex',
      markdown: `**Complex table — layout requires review**\n\n\`\`\`text\n${text}\n\`\`\``,
    };
  }
  const values = multiCellRows.map((row) => row.map(({ text }) => text));
  const numericColumns = anchors.map((_, column) =>
    values.slice(1).every((row) => /^[-+]?[$€£]?\d[\d,.%]*$/u.test(row[column] ?? '')),
  );
  const escapeCell = (value: string): string => value.replaceAll('|', '\\|').trim();
  const header = `| ${values[0]?.map(escapeCell).join(' | ') ?? ''} |`;
  const separator = `| ${numericColumns.map((numeric) => (numeric ? '---:' : '---')).join(' | ')} |`;
  const body = values
    .slice(1)
    .map((row) => `| ${row.map(escapeCell).join(' | ')} |`)
    .join('\n');
  return {
    lines: tableLines,
    kind: 'simple',
    markdown: [header, separator, body].filter(Boolean).join('\n'),
  };
};

const columnRegions = (lines: readonly LayoutLine[], pageWidth: number): Map<number, number> => {
  const assignments = new Map<number, number>();
  if (lines.length < 4) return assignments;
  const starts = [...new Set(lines.map((line) => Math.round(line.x)))].sort(
    (left, right) => left - right,
  );
  const anchors: number[] = [];
  for (const start of starts) {
    const previous = anchors.at(-1);
    if (previous === undefined || start - previous > pageWidth * 0.1) anchors.push(start);
  }
  if (anchors.length < 2 || anchors.length > 4) return assignments;
  const counts = anchors.map(
    (anchor, index) =>
      lines.filter((line) => {
        const next = anchors[index + 1];
        return line.x >= anchor - pageWidth * 0.035 && (next === undefined || line.x < next);
      }).length,
  );
  if (counts.filter((count) => count >= 2).length < 2) return assignments;
  for (const line of lines) {
    let best = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (const [index, anchor] of anchors.entries()) {
      const candidate = Math.abs(line.x - anchor);
      if (candidate < distance) {
        distance = candidate;
        best = index;
      }
    }
    assignments.set(line.id, best);
  }
  return assignments;
};

const createBlock = (
  page: PdfLayoutPageInput,
  ordinal: number,
  kind: ExtractedBlockKind,
  lines: readonly LayoutLine[],
  markdown: string,
  warnings: readonly string[] = [],
): ExtractedBlock => {
  const confidence = confidenceFor(kind, lines, warnings);
  return {
    ordinal,
    kind,
    source: 'text',
    text: lines.map(({ text }) => text).join('\n'),
    markdown,
    bounds: boundsForLines(lines, page),
    readingOrder: ordinal,
    confidence,
    routing: routePdfBlock(kind, confidence, warnings),
    warnings,
    revisions,
  };
};

const classifyPage = (
  page: PdfLayoutPageInput,
  lines: readonly LayoutLine[],
  furniture: ReadonlySet<string>,
): ClassifiedPdfPage => {
  const suppressed = new Set<number>();
  const blocks: ExtractedBlock[] = [];
  const pageWarnings = new Set<string>();
  for (const line of lines) {
    const key = furnitureKey(line, page);
    if (key === null || !furniture.has(key)) continue;
    suppressed.add(line.id);
    const kind: ExtractedBlockKind = key.startsWith('header:') ? 'header' : 'footer';
    blocks.push(createBlock(page, blocks.length, kind, [line], '', ['repeated-page-furniture']));
  }

  const active = lines.filter((line) => !suppressed.has(line.id));
  const bodyFontSize = dominantFontSize(active);
  if (active.length === 0) {
    return {
      body: '',
      blocks: blocks.map((block, ordinal) => ({ ...block, ordinal, readingOrder: ordinal })),
      warnings: [...pageWarnings],
      metadata: {
        bodyFontSize,
        nativeLineCount: lines.length,
        layoutRegionCount: 0,
        nativeSafeBlocks: blocks.length,
        regionalVisionBlocks: 0,
        fullPageVisionBlocks: 0,
        pageRouting: 'full-page-vision',
      },
    };
  }

  const headingSizes = [...new Set(active.map(({ fontSize }) => fontSize))]
    .filter((size) => size >= bodyFontSize * 1.12)
    .sort((left, right) => right - left);
  const first = active[0];
  const titleId =
    page.ordinal === 0 &&
    first !== undefined &&
    first.fontSize >= bodyFontSize * 1.55 &&
    !/^\s*(?:\d+|[ivxlcdm]+)[.)]\s+/iu.test(first.text)
      ? first.id
      : null;
  const structural = new Map<number, { kind: ExtractedBlockKind; level: number }>();
  for (const line of active) {
    const sizeIndex = headingSizes.findIndex((size) => Math.abs(size - line.fontSize) < 0.25);
    if (line.id === titleId) structural.set(line.id, { kind: 'title', level: 1 });
    else if (sizeIndex >= 0 || (line.bold && line.fontSize >= bodyFontSize)) {
      structural.set(line.id, {
        kind: 'heading',
        level: Math.min(6, sizeIndex + 1),
      });
    }
  }

  const nonStructural = active.filter((line) => !structural.has(line.id));
  const table = tableCandidate(nonStructural, page);
  const tableIds = new Set(table?.lines.map(({ id }) => id) ?? []);
  if (table?.kind === 'complex') pageWarnings.add('complex-table-fallback');

  const captionIds = new Set(
    nonStructural
      .filter((line) => /^(?:figure|fig\.|table)\s*\d+[.:]/iu.test(line.text))
      .map(({ id }) => id),
  );
  const diagramIds = new Set<number>();
  for (const caption of nonStructural.filter((line) => captionIds.has(line.id))) {
    const candidates = nonStructural.filter(
      (line) =>
        !tableIds.has(line.id) &&
        !captionIds.has(line.id) &&
        line.y > caption.y &&
        line.y - caption.y < page.height * 0.14 &&
        line.text.length <= 40,
    );
    const sameBand = candidates.filter((line) =>
      candidates.some((other) => other.id !== line.id && Math.abs(other.y - line.y) < 3),
    );
    if (sameBand.length >= 2) for (const line of sameBand) diagramIds.add(line.id);
  }

  const ordinary = nonStructural.filter(
    (line) => !tableIds.has(line.id) && !captionIds.has(line.id) && !diagramIds.has(line.id),
  );
  const listLines = ordinary.filter(isListLine);
  const proseLines = ordinary.filter((line) => !isListLine(line));
  const regions = columnRegions(proseLines, page.width);
  const layoutRegionCount = new Set(regions.values()).size || (proseLines.length > 0 ? 1 : 0);

  const tokens: Array<{ y: number; x: number; block: ExtractedBlock; region: number }> = [];
  for (const line of active.filter((candidate) => structural.has(candidate.id))) {
    const detail = structural.get(line.id);
    if (detail === undefined) continue;
    tokens.push({
      y: line.y,
      x: line.x,
      region: -1,
      block: createBlock(page, 0, detail.kind, [line], markdownHeading(line.text, detail.level)),
    });
  }
  if (table !== null) {
    tokens.push({
      y: Math.max(...table.lines.map(({ y }) => y)),
      x: Math.min(...table.lines.map(({ x }) => x)),
      region: -1,
      block: createBlock(
        page,
        0,
        table.kind === 'simple' ? 'table' : 'unknown',
        table.lines,
        table.markdown,
        table.kind === 'complex' ? ['complex-table-fallback'] : [],
      ),
    });
  }
  if (diagramIds.size > 0) {
    const diagram = nonStructural.filter((line) => diagramIds.has(line.id));
    tokens.push({
      y: Math.max(...diagram.map(({ y }) => y)),
      x: Math.min(...diagram.map(({ x }) => x)),
      region: -1,
      block: createBlock(page, 0, 'unknown', diagram, diagram.map(({ text }) => text).join(' → '), [
        'diagram-native-labels-only',
      ]),
    });
  }
  for (const line of nonStructural.filter((candidate) => captionIds.has(candidate.id))) {
    tokens.push({
      y: line.y,
      x: line.x,
      region: -1,
      block: createBlock(page, 0, 'caption', [line], `_${line.text}_`),
    });
  }
  const listBaseX = Math.min(...listLines.map(({ x }) => x), Number.POSITIVE_INFINITY);
  for (const line of listLines) {
    tokens.push({
      y: line.y,
      x: line.x,
      region: -1,
      block: createBlock(page, 0, 'list-item', [line], listMarkdown(line, listBaseX, bodyFontSize)),
    });
  }

  const proseGroups = new Map<string, { region: number; lines: LayoutLine[] }>();
  for (const line of proseLines) {
    const region = regions.get(line.id) ?? 0;
    const section = [...structural.keys()].filter(
      (id) => (active.find((candidate) => candidate.id === id)?.y ?? -Infinity) > line.y,
    ).length;
    const key = `${String(section)}:${String(region)}`;
    const group = proseGroups.get(key) ?? { region, lines: [] };
    group.lines.push(line);
    proseGroups.set(key, group);
  }
  for (const { region, lines: group } of proseGroups.values()) {
    const ordered = group.sort((left, right) => right.y - left.y || left.x - right.x);
    tokens.push({
      y: Math.max(...ordered.map(({ y }) => y)),
      x: Math.min(...ordered.map(({ x }) => x)),
      region,
      block: createBlock(page, 0, 'paragraph', ordered, paragraphMarkdown(ordered)),
    });
  }

  const headingFloor = Math.min(
    ...tokens
      .filter(({ block }) => block.kind === 'title' || block.kind === 'heading')
      .map(({ y }) => y),
    Number.POSITIVE_INFINITY,
  );
  const orderedTokens = tokens.sort((left, right) => {
    const leftBelowHeadings = left.y < headingFloor;
    const rightBelowHeadings = right.y < headingFloor;
    if (leftBelowHeadings && rightBelowHeadings && left.region >= 0 && right.region >= 0) {
      return left.region - right.region || right.y - left.y;
    }
    return right.y - left.y || left.x - right.x;
  });

  const emitted = orderedTokens.map(({ block }, ordinal) => ({
    ...block,
    ordinal: blocks.length + ordinal,
    readingOrder: blocks.length + ordinal,
  }));
  const allBlocks = [...blocks, ...emitted].map((block, ordinal) => ({
    ...block,
    ordinal,
    readingOrder: ordinal,
  }));
  const body = allBlocks
    .map(({ markdown }) => markdown)
    .filter((markdown) => markdown.length > 0)
    .join('\n\n');
  const nativeSafeBlocks = allBlocks.filter(
    ({ routing }) => routing?.disposition === 'native-safe',
  ).length;
  const regionalVisionBlocks = allBlocks.filter(
    ({ routing }) => routing?.disposition === 'regional-vision',
  ).length;
  const fullPageVisionBlocks = allBlocks.filter(
    ({ routing }) => routing?.disposition === 'full-page-vision',
  ).length;
  return {
    body,
    blocks: allBlocks,
    warnings: [...pageWarnings],
    metadata: {
      bodyFontSize,
      nativeLineCount: lines.length,
      layoutRegionCount,
      suppressedFurnitureBlocks: blocks.length,
      simpleTables: table?.kind === 'simple' ? 1 : 0,
      complexTableFallbacks: table?.kind === 'complex' ? 1 : 0,
      nativeSafeBlocks,
      regionalVisionBlocks,
      fullPageVisionBlocks,
      pageRouting:
        fullPageVisionBlocks > 0
          ? 'full-page-vision'
          : regionalVisionBlocks > 0
            ? 'regional-vision'
            : 'native-safe',
    },
  };
};

export const classifyPdfDocumentLayout = (
  pages: readonly PdfLayoutPageInput[],
): readonly ClassifiedPdfPage[] => {
  const lines = pages.map(buildLines);
  const furniture = repeatedFurniture(pages, lines);
  return pages.map((page, index) => classifyPage(page, lines[index] ?? [], furniture));
};
