import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { XMLParser } from 'fast-xml-parser';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import type {
  ExtractedDocument,
  ExtractedImage,
  ExtractedPage,
  ExtractionOptions,
  InjectedVision,
} from './contract.js';
import { openOfficeArchive } from './office-archive.js';
import { extractedImageFromVision, markdownFromVision } from '../vision/result.js';

interface CellData {
  text: string;
  kind: 'empty' | 'text' | 'number' | 'date' | 'boolean' | 'error';
}

interface SheetMetadata {
  readonly name: string;
  readonly hidden: boolean;
  readonly target: string | null;
}

interface MergeRange {
  readonly startRow: number;
  readonly endRow: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

interface XmlCell {
  readonly '@_r'?: string;
  readonly '@_s'?: string;
  readonly '@_t'?: string;
  readonly f?: unknown;
  readonly v?: unknown;
  readonly is?: unknown;
}

const normalParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
});

const asArray = <T>(value: T | readonly T[] | undefined): readonly T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value as T];

const columnNumber = (letters: string): number => {
  let value = 0;
  for (const character of letters.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
  return value;
};

const columnName = (number: number): string => {
  let value = number;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
};

const mergeRange = (reference: string): MergeRange | null => {
  const match = reference.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/iu);
  if (match === null) return null;
  return {
    startColumn: columnNumber(match[1] ?? ''),
    startRow: Number(match[2]),
    endColumn: columnNumber(match[3] ?? ''),
    endRow: Number(match[4]),
  };
};

const workbookMetadata = async (
  archive: Awaited<ReturnType<typeof openOfficeArchive>>,
): Promise<readonly SheetMetadata[]> => {
  const workbook = normalParser.parse(await archive.text('xl/workbook.xml')) as {
    workbook?: { sheets?: { sheet?: unknown } };
  };
  const relationships = archive.entries.has('xl/_rels/workbook.xml.rels')
    ? (normalParser.parse(await archive.text('xl/_rels/workbook.xml.rels')) as {
        Relationships?: { Relationship?: unknown };
      })
    : {};
  const targets = new Map<string, string>();
  for (const relation of asArray(
    relationships.Relationships?.Relationship as
      Readonly<Record<string, string>> | readonly Readonly<Record<string, string>>[] | undefined,
  )) {
    const id = relation['@_Id'];
    const target = relation['@_Target'];
    if (id !== undefined && target !== undefined && !target.includes('..')) {
      const withoutRoot = target.replace(/^\//u, '');
      targets.set(
        id,
        posix.normalize(
          withoutRoot.startsWith('xl/') ? withoutRoot : posix.join('xl', withoutRoot),
        ),
      );
    }
  }
  return asArray(
    workbook.workbook?.sheets?.sheet as
      Readonly<Record<string, string>> | readonly Readonly<Record<string, string>>[] | undefined,
  ).map((sheet) => ({
    name: sheet['@_name'] ?? 'Sheet',
    hidden: sheet['@_state'] === 'hidden' || sheet['@_state'] === 'veryHidden',
    target: targets.get(sheet['@_id'] ?? '') ?? null,
  }));
};

const decimalPlaces = (format: string): number => {
  const decimal = format.split('.')[1]?.match(/^0+/u)?.[0];
  return decimal?.length ?? 0;
};

const formattedNumber = (value: number, format: string): string => {
  const visibleFormat = format.replace(/"[^"]*"/gu, '');
  const decimals = decimalPlaces(visibleFormat);
  if (visibleFormat.includes('%')) return `${(value * 100).toFixed(decimals)}%`;
  const currency = format.match(/[$€£¥]/u)?.[0];
  const grouping = visibleFormat.includes(',');
  const number = new Intl.NumberFormat('en-US', {
    useGrouping: grouping,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
  return currency === undefined ? number : `${currency}${number}`;
};

const xmlText = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(xmlText).join('');
  if (value === null || typeof value !== 'object') return '';
  const record = value as Readonly<Record<string, unknown>>;
  return Object.entries(record)
    .filter(([key]) => !key.startsWith('@_'))
    .map(([, child]) => xmlText(child))
    .join('');
};

const workbookSharedStrings = async (
  archive: Awaited<ReturnType<typeof openOfficeArchive>>,
): Promise<readonly string[]> => {
  if (!archive.entries.has('xl/sharedStrings.xml')) return [];
  const parsed = normalParser.parse(await archive.text('xl/sharedStrings.xml')) as {
    sst?: { si?: unknown };
  };
  return asArray(parsed.sst?.si).map(xmlText);
};

const workbookStyleFormats = async (
  archive: Awaited<ReturnType<typeof openOfficeArchive>>,
): Promise<readonly string[]> => {
  if (!archive.entries.has('xl/styles.xml')) return [];
  const parsed = normalParser.parse(await archive.text('xl/styles.xml')) as {
    styleSheet?: {
      numFmts?: { numFmt?: unknown };
      cellXfs?: { xf?: unknown };
    };
  };
  const custom = new Map<number, string>();
  for (const item of asArray(
    parsed.styleSheet?.numFmts?.numFmt as
      Readonly<Record<string, string>> | readonly Readonly<Record<string, string>>[] | undefined,
  )) {
    custom.set(Number(item['@_numFmtId']), item['@_formatCode'] ?? '');
  }
  const builtIn = new Map<number, string>([
    [9, '0%'],
    [10, '0.00%'],
    [14, 'yyyy-mm-dd'],
    [22, 'yyyy-mm-dd hh:mm'],
  ]);
  return asArray(
    parsed.styleSheet?.cellXfs?.xf as
      Readonly<Record<string, string>> | readonly Readonly<Record<string, string>>[] | undefined,
  ).map(
    (style) =>
      custom.get(Number(style['@_numFmtId'])) ?? builtIn.get(Number(style['@_numFmtId'])) ?? '',
  );
};

const isDateFormat = (format: string): boolean =>
  /(^|[^\\])[ymd]/iu.test(format.replace(/"[^"]*"/gu, ''));

const excelDate = (serial: number): string =>
  new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString();

const xmlCellData = (
  cell: XmlCell,
  sharedStrings: readonly string[],
  styleFormats: readonly string[],
  warnings: string[],
  sheetName: string,
): CellData => {
  const reference = cell['@_r'] ?? '?';
  const raw = xmlText(cell.v);
  if (cell.f !== undefined && raw.length === 0) {
    warnings.push(`formula-cache-missing:${sheetName}!${reference}`);
    return { text: '[Formula result unavailable]', kind: 'error' };
  }
  if (raw.length === 0 && cell.is === undefined) return { text: '', kind: 'empty' };
  const type = cell['@_t'] ?? 'n';
  if (type === 's') return { text: sharedStrings[Number(raw)] ?? '', kind: 'text' };
  if (type === 'str' || type === 'inlineStr') {
    return { text: type === 'inlineStr' ? xmlText(cell.is) : raw, kind: 'text' };
  }
  if (type === 'b') return { text: raw === '1' ? 'TRUE' : 'FALSE', kind: 'boolean' };
  if (type === 'e') {
    warnings.push(`cell-error:${sheetName}!${reference}:${raw}`);
    return { text: raw, kind: 'error' };
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) return { text: raw, kind: 'text' };
  const format = styleFormats[Number(cell['@_s'] ?? 0)] ?? '';
  if (isDateFormat(format)) return { text: excelDate(number), kind: 'date' };
  return { text: formattedNumber(number, format), kind: 'number' };
};

const localName = (name: string): string => name.split(':').at(-1) ?? name;

const tagAttribute = (tag: SaxesTagPlain, name: string): string | undefined => {
  const value = tag.attributes[name];
  return typeof value === 'string' ? value : undefined;
};

const streamWorksheetRows = async (
  archive: Awaited<ReturnType<typeof openOfficeArchive>>,
  path: string,
  sheetName: string,
  warnings: string[],
  sharedStrings: readonly string[],
  styleFormats: readonly string[],
  maximumCells: number,
): Promise<{
  readonly rows: CellData[][];
  readonly merges: readonly MergeRange[];
  readonly visitedCells: number;
}> => {
  const rows: CellData[][] = [];
  const merges: MergeRange[] = [];
  let rowNumber = 0;
  let rowCells: CellData[] = [];
  let visitedCells = 0;
  let activeCell:
    (XmlCell & { valueText: string; inlineText: string; hasFormula: boolean }) | null = null;
  let capture: 'value' | 'inline' | null = null;
  const parser = new SaxesParser<{ xmlns: false }>({ xmlns: false });
  parser.on('opentag', (tag: SaxesTagPlain) => {
    const name = localName(tag.name);
    if (name === 'row') {
      rowNumber = Number(tagAttribute(tag, 'r') ?? rows.length + 1);
      rowCells = [];
    } else if (name === 'c') {
      const reference = tagAttribute(tag, 'r');
      const style = tagAttribute(tag, 's');
      const type = tagAttribute(tag, 't');
      activeCell = {
        ...(reference === undefined ? {} : { '@_r': reference }),
        ...(style === undefined ? {} : { '@_s': style }),
        ...(type === undefined ? {} : { '@_t': type }),
        valueText: '',
        inlineText: '',
        hasFormula: false,
      };
    } else if (name === 'f' && activeCell !== null) activeCell.hasFormula = true;
    else if (name === 'v' && activeCell !== null) capture = 'value';
    else if (name === 't' && activeCell !== null) capture = 'inline';
    else if (name === 'mergeCell') {
      const range = mergeRange(tagAttribute(tag, 'ref') ?? '');
      if (range !== null) merges.push(range);
    }
  });
  parser.on('text', (text) => {
    if (activeCell === null) return;
    if (capture === 'value') activeCell.valueText += text;
    else if (capture === 'inline') activeCell.inlineText += text;
  });
  parser.on('closetag', (tag: SaxesTagPlain) => {
    const name = localName(tag.name);
    if (name === 'v' || name === 't') capture = null;
    else if (name === 'c' && activeCell !== null) {
      visitedCells += 1;
      if (visitedCells > maximumCells) throw new Error('workbook-cell-limit-exceeded');
      const reference = activeCell['@_r'] ?? '';
      const column = columnNumber(
        reference.match(/^[A-Z]+/iu)?.[0] ?? columnName(rowCells.length + 1),
      );
      rowCells[column - 1] = xmlCellData(
        {
          ...(activeCell['@_r'] === undefined ? {} : { '@_r': activeCell['@_r'] }),
          ...(activeCell['@_s'] === undefined ? {} : { '@_s': activeCell['@_s'] }),
          ...(activeCell['@_t'] === undefined ? {} : { '@_t': activeCell['@_t'] }),
          ...(activeCell.hasFormula ? { f: true } : {}),
          ...(activeCell.valueText.length > 0 ? { v: activeCell.valueText } : {}),
          ...(activeCell.inlineText.length > 0 ? { is: activeCell.inlineText } : {}),
        },
        sharedStrings,
        styleFormats,
        warnings,
        sheetName,
      );
      activeCell = null;
    } else if (name === 'row') rows[rowNumber - 1] = rowCells;
  });
  const decoder = new StringDecoder('utf8');
  for await (const value of archive.stream(path)) {
    parser.write(decoder.write(Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)));
  }
  parser.write(decoder.end()).close();
  return {
    rows: Array.from({ length: rows.length }, (_, index) => rows[index] ?? []),
    merges,
    visitedCells,
  };
};

const repeatedMergedValues = (rows: CellData[][], ranges: readonly MergeRange[]): void => {
  for (const range of ranges) {
    const source = rows[range.startRow - 1]?.[range.startColumn - 1];
    if (source === undefined || source.text.length === 0) continue;
    for (let row = range.startRow; row <= range.endRow; row += 1) {
      for (let column = range.startColumn; column <= range.endColumn; column += 1) {
        const targetRow = rows[row - 1];
        if (targetRow !== undefined) targetRow[column - 1] = { ...source };
      }
    }
  }
};

const nonempty = (cell: CellData | undefined): boolean => (cell?.text.trim().length ?? 0) > 0;

const contiguousRegions = (rows: readonly CellData[][]): readonly CellData[][][] => {
  const rowBlocks: CellData[][][] = [];
  let block: CellData[][] = [];
  for (const row of rows) {
    if (row.some(nonempty)) block.push(row);
    else if (block.length > 0) {
      rowBlocks.push(block);
      block = [];
    }
  }
  if (block.length > 0) rowBlocks.push(block);
  const regions: CellData[][][] = [];
  for (const rowsInBlock of rowBlocks) {
    const width = Math.max(...rowsInBlock.map(({ length }) => length));
    let start: number | null = null;
    for (let column = 0; column <= width; column += 1) {
      const occupied = column < width && rowsInBlock.some((row) => nonempty(row[column]));
      if (occupied && start === null) start = column;
      if (!occupied && start !== null) {
        const regionStart = start;
        regions.push(
          rowsInBlock.map((row) =>
            Array.from(
              { length: column - regionStart },
              (_, index) => row[regionStart + index] ?? { text: '', kind: 'empty' },
            ),
          ),
        );
        start = null;
      }
    }
  }
  return regions;
};

const escaped = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', '<br>');

const inferredHeader = (rows: readonly CellData[][]): boolean => {
  const first = rows[0] ?? [];
  if (first.length === 0 || first.some((cell) => cell.kind !== 'text' || cell.text.length === 0)) {
    return false;
  }
  return rows
    .slice(1, 6)
    .some((row) => row.some((cell) => cell.kind !== 'text' && cell.kind !== 'empty'));
};

const regionMarkdown = (rows: readonly CellData[][], wideColumns: number): string => {
  const width = Math.max(...rows.map(({ length }) => length));
  const header = inferredHeader(rows);
  if (width > wideColumns) {
    const labels = header
      ? (rows[0]?.map(({ text }, index) => text || columnName(index + 1)) ?? [])
      : Array.from({ length: width }, (_, index) => columnName(index + 1));
    return rows
      .slice(header ? 1 : 0)
      .map(
        (row, index) =>
          `### Record ${String(index + 1)}\n${labels
            .map((label, column) => `- ${label}: ${row[column]?.text ?? ''}`)
            .join('\n')}`,
      )
      .join('\n\n');
  }
  const headings = header
    ? (rows[0]?.map(({ text }, index) => escaped(text || columnName(index + 1))) ?? [])
    : Array.from({ length: width }, (_, index) => columnName(index + 1));
  const data = rows.slice(header ? 1 : 0);
  return [
    `| ${headings.join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...data.map(
      (row) =>
        `| ${Array.from({ length: width }, (_, column) => escaped(row[column]?.text ?? '')).join(' | ')} |`,
    ),
  ].join('\n');
};

const worksheetImages = async (
  archive: Awaited<ReturnType<typeof openOfficeArchive>>,
  injectedVision: InjectedVision | undefined,
): Promise<{
  readonly images: readonly ExtractedImage[];
  readonly blocks: readonly string[];
  readonly warnings: readonly string[];
}> => {
  const images: ExtractedImage[] = [];
  const blocks: string[] = [];
  const warnings: string[] = [];
  for (const [path] of archive.entries) {
    if (!path.startsWith('xl/media/')) continue;
    const bytes = await archive.read(path);
    const id = createHash('sha256').update(bytes).digest('hex');
    const type = path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    if (injectedVision === undefined) {
      images.push({
        id,
        sequence: images.length,
        mediaType: type,
        bytes,
        disposition: 'pending_vision',
      });
      warnings.push('worksheet-image-vision-pending');
      continue;
    }
    const request = {
      kind: 'worksheet-image',
      bytes,
      mediaType: type,
      pageNumber: null,
      imageId: id,
    } as const;
    const result = await injectedVision.analyse(request);
    images.push(extractedImageFromVision(request, images.length, result));
    if (result.disposition === 'analysed' && result.confidence < 0.5)
      warnings.push('worksheet-image-low-vision-confidence');
    const block = markdownFromVision(request, result);
    if (block.length > 0) blocks.push(block);
    if (result.disposition === 'pending_vision') warnings.push('worksheet-image-vision-pending');
    if (result.disposition === 'skipped')
      warnings.push(`worksheet-image-skipped:${result.skipReason}`);
  }
  return { images, blocks, warnings };
};

export const extractXlsx = async (
  bytes: Uint8Array,
  options: ExtractionOptions = {},
  injectedVision?: InjectedVision,
): Promise<ExtractedDocument> => {
  const archive = await openOfficeArchive(bytes, options);
  if (!archive.entries.has('xl/workbook.xml')) throw new Error('invalid-xlsx-package');
  const metadata = await workbookMetadata(archive);
  const imageResult = await worksheetImages(archive, injectedVision);
  const sharedStrings = await workbookSharedStrings(archive);
  const styleFormats = await workbookStyleFormats(archive);
  const pages: ExtractedPage[] = [];
  const documentWarnings = [...imageResult.warnings];
  const maximumCells = options.maximumWorkbookCells ?? 2_000_000;
  let visitedCells = 0;
  if (metadata.length > (options.maximumPages ?? 1000)) {
    throw new Error('workbook-sheet-limit-exceeded');
  }
  for (const [sheetIndex, sheet] of metadata.entries()) {
    const name = sheet?.name ?? `Sheet ${String(sheetIndex + 1)}`;
    const warnings: string[] = [];
    if (sheet?.hidden) warnings.push('hidden-sheet');
    const streamed =
      sheet?.target !== null && sheet?.target !== undefined && archive.entries.has(sheet.target)
        ? await streamWorksheetRows(
            archive,
            sheet.target,
            name,
            warnings,
            sharedStrings,
            styleFormats,
            maximumCells - visitedCells,
          )
        : { rows: [] as CellData[][], merges: [] as MergeRange[], visitedCells: 0 };
    if (
      sheet?.target === null ||
      sheet?.target === undefined ||
      !archive.entries.has(sheet.target)
    ) {
      warnings.push('worksheet-part-missing');
    }
    visitedCells += streamed.visitedCells;
    const rows = streamed.rows;
    repeatedMergedValues(rows, streamed.merges);
    const regions = contiguousRegions(rows);
    if (regions.length === 0) warnings.push('empty-sheet');
    const blocks = regions.map((region) => regionMarkdown(region, options.wideSheetColumns ?? 15));
    if (sheetIndex === 0) blocks.push(...imageResult.blocks);
    const images = sheetIndex === 0 ? imageResult.images : [];
    pages.push({
      ordinal: sheetIndex,
      pageNumber: sheetIndex + 1,
      label: name,
      body: blocks.filter(Boolean).join('\n\n'),
      extraction: images.some(({ disposition }) => disposition === 'analysed') ? 'mixed' : 'text',
      confidence: warnings.some((warning) => warning.startsWith('formula-cache-missing')) ? 0.8 : 1,
      warnings,
      images,
      metadata: { hidden: sheet?.hidden ?? false, regions: regions.length, rows: rows.length },
    });
    documentWarnings.push(...warnings);
  }
  return {
    format: 'xlsx',
    pages,
    pageBasis: 'sheet',
    encoding: null,
    encodingConfidence: null,
    offsetsMatchOriginal: false,
    warnings: [...new Set(documentWarnings)],
    metadata: {
      sheets: pages.length,
      visitedCells,
      reader: 'saxes-streaming',
      wideSheetColumns: options.wideSheetColumns ?? 15,
    },
  };
};
