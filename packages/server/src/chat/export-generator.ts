import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  type FileChild,
} from 'docx';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import PDFDocument from 'pdfkit';
import {
  notoCyrillic,
  notoDevanagari,
  notoGreek,
  notoLatin,
  notoLatinBold,
  notoLatinExtended,
  notoLatinItalic,
  notoVietnamese,
} from './generated-fonts.js';
import { renderMermaidDiagram } from './export-diagram.js';
import type { DocumentBlock, DocumentTextRun, NormalizedChatDocument } from './export-document.js';

const FIXED_DATE = new Date('2000-01-01T00:00:00.000Z');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';
const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 500;
const MAX_DOCX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;

export type ChatExportFormat = 'docx' | 'pdf';

export interface ChatExportProvenance {
  readonly artifactId: string;
  readonly revision: number;
  readonly sourceSha256: string;
}

export interface GeneratedChatExport {
  readonly bytes: Buffer;
  readonly mimeType: typeof DOCX_MIME | typeof PDF_MIME;
  readonly extension: ChatExportFormat;
  readonly warnings: readonly string[];
}

export class ChatExportGenerationError extends Error {
  constructor(
    readonly code:
      | 'chat_export_generation_failed'
      | 'chat_export_output_too_large'
      | 'chat_export_docx_invalid'
      | 'chat_export_docx_active_content'
      | 'chat_export_pdf_invalid'
      | 'chat_export_pdf_active_content',
  ) {
    super(code);
    this.name = 'ChatExportGenerationError';
  }
}

const headingLevels = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

const docxRuns = (runs: readonly DocumentTextRun[]): readonly TextRun[] =>
  runs.map(
    (run) =>
      new TextRun({
        text: run.text,
        ...(run.bold === true ? { bold: true } : {}),
        ...(run.italic === true ? { italics: true } : {}),
        ...(run.strike === true ? { strike: true } : {}),
        ...(run.code === true ? { font: 'Noto Sans Mono', shading: { fill: 'EEF1F3' } } : {}),
      }),
  );

const docxParagraph = (
  runs: readonly DocumentTextRun[],
  options: { readonly prefix?: string; readonly indent?: number } = {},
): Paragraph =>
  new Paragraph({
    children: [
      ...(options.prefix === undefined ? [] : [new TextRun({ text: options.prefix, bold: true })]),
      ...docxRuns(runs),
    ],
    spacing: { after: 140, line: 276 },
    ...(options.indent === undefined ? {} : { indent: { left: options.indent } }),
  });

const docxBlocks = (
  blocks: readonly DocumentBlock[],
  warnings: Set<string>,
  depth = 0,
): readonly FileChild[] => {
  const output: FileChild[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
        output.push(
          new Paragraph({
            heading: headingLevels[block.level - 1] ?? HeadingLevel.HEADING_6,
            children: docxRuns(block.runs),
            spacing: { before: block.level === 1 ? 240 : 180, after: 120 },
          }),
        );
        break;
      case 'paragraph':
        output.push(docxParagraph(block.runs, depth === 0 ? {} : { indent: depth * 360 }));
        break;
      case 'blockquote': {
        output.push(
          new Paragraph({
            children: [new TextRun({ text: 'Quoted passage', italics: true, color: '4B7569' })],
            indent: { left: 720 + depth * 240 },
            border: {
              left: { color: '4B7569', style: BorderStyle.SINGLE, size: 18, space: 12 },
            },
            spacing: { after: 80 },
          }),
          ...docxBlocks(block.blocks, warnings, depth + 1),
        );
        break;
      }
      case 'list':
        block.items.forEach((item, itemIndex) => {
          const prefix = block.ordered ? `${String(block.start + itemIndex)}. ` : '• ';
          const [first, ...rest] = item;
          if (first?.kind === 'paragraph') {
            output.push(docxParagraph(first.runs, { prefix, indent: 480 + depth * 360 }));
            output.push(...docxBlocks(rest, warnings, depth + 1));
          } else {
            output.push(docxParagraph([{ text: ' ' }], { prefix, indent: 480 + depth * 360 }));
            output.push(...docxBlocks(item, warnings, depth + 1));
          }
        });
        break;
      case 'table': {
        const rows = [block.header, ...block.rows];
        if (rows.length === 0 || block.header.length === 0) {
          output.push(docxParagraph([{ text: '[Empty table]' }]));
          break;
        }
        output.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            layout: TableLayoutType.FIXED,
            rows: rows.map(
              (row, rowIndex) =>
                new TableRow({
                  tableHeader: rowIndex === 0,
                  children: row.map(
                    (cell) =>
                      new TableCell({
                        width: { size: 100 / row.length, type: WidthType.PERCENTAGE },
                        ...(rowIndex === 0
                          ? {
                              shading: {
                                fill: 'DCEBE6',
                                type: ShadingType.CLEAR,
                                color: 'auto',
                              },
                            }
                          : {}),
                        children: [
                          new Paragraph({
                            children: docxRuns(
                              rowIndex === 0 ? cell.map((run) => ({ ...run, bold: true })) : cell,
                            ),
                            spacing: { after: 60 },
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          }),
        );
        output.push(new Paragraph({ children: [], spacing: { after: 120 } }));
        break;
      }
      case 'code':
        output.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `${block.language === null ? '' : `[${block.language}]\n`}${block.text}`,
                font: 'Noto Sans Mono',
                size: 18,
              }),
            ],
            shading: { fill: 'F1F3F4', type: ShadingType.CLEAR, color: 'auto' },
            spacing: { before: 80, after: 160 },
          }),
        );
        break;
      case 'equation':
        output.push(
          new Paragraph({
            children: [new TextRun({ text: block.source, font: 'Cambria Math', italics: true })],
            alignment: AlignmentType.CENTER,
            shading: { fill: 'F7F4EA', type: ShadingType.CLEAR, color: 'auto' },
            spacing: { before: 100, after: 160 },
          }),
        );
        break;
      case 'diagram': {
        const rendered = renderMermaidDiagram(block.source);
        if (rendered === null) {
          warnings.add(
            'A Mermaid diagram outside the supported flowchart subset was exported as source text.',
          );
          output.push(
            docxParagraph([
              { text: 'Diagram (Mermaid source):\n', bold: true },
              { text: block.source, code: true },
            ]),
          );
        } else {
          const width = Math.min(620, rendered.width);
          output.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new ImageRun({
                  data: rendered.bytes,
                  type: 'png',
                  transformation: {
                    width,
                    height: Math.max(80, Math.round((rendered.height / rendered.width) * width)),
                  },
                  altText: {
                    title: 'Mermaid flowchart',
                    description: rendered.description,
                    name: 'Mermaid flowchart',
                  },
                }),
              ],
              spacing: { before: 120, after: 160 },
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  text: `Diagram source: ${block.source.replaceAll('\n', ' ').trim()}`,
                  size: 16,
                  color: '536B64',
                }),
              ],
              spacing: { after: 160 },
            }),
          );
        }
        break;
      }
      case 'page_break':
        output.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case 'horizontal_rule':
        output.push(
          new Paragraph({
            border: { bottom: { color: '80958F', style: BorderStyle.SINGLE, size: 8, space: 6 } },
            spacing: { after: 140 },
          }),
        );
        break;
      case 'degradation':
        output.push(
          new Paragraph({
            children: [new TextRun({ text: block.label, italics: true, color: '725B00' })],
            shading: { fill: 'FFF7D6', type: ShadingType.CLEAR, color: 'auto' },
            spacing: { after: 140 },
          }),
        );
        break;
    }
  }
  return output;
};

const canonicalizeDocx = async (bytes: Buffer): Promise<Buffer> => {
  const input = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const names = Object.keys(input.files)
    .filter((name) => !input.files[name]?.dir)
    .sort();
  if (names.length < 3 || names.length > MAX_DOCX_ENTRIES) {
    throw new ChatExportGenerationError('chat_export_docx_invalid');
  }
  let uncompressed = 0;
  const output = new JSZip();
  for (const name of names) {
    if (name.startsWith('/') || name.includes('..') || name.includes('\\')) {
      throw new ChatExportGenerationError('chat_export_docx_invalid');
    }
    let content = await input.file(name)?.async('nodebuffer');
    if (content === undefined) throw new ChatExportGenerationError('chat_export_docx_invalid');
    if (name === 'docProps/core.xml') {
      content = Buffer.from(
        content
          .toString('utf8')
          .replace(
            /<(dcterms:(?:created|modified))[^>]*>[^<]*<\/\1>/gu,
            '<$1 xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00.000Z</$1>',
          ),
        'utf8',
      );
    }
    uncompressed += content.byteLength;
    if (uncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new ChatExportGenerationError('chat_export_docx_invalid');
    }
    output.file(name, content, { date: FIXED_DATE, createFolders: true });
  }
  return output.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'DOS',
  });
};

export const validateSafeDocx = async (bytes: Buffer): Promise<void> => {
  if (bytes.byteLength < 4 || bytes.subarray(0, 2).toString('ascii') !== 'PK') {
    throw new ChatExportGenerationError('chat_export_docx_invalid');
  }
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true }).catch(() => {
    throw new ChatExportGenerationError('chat_export_docx_invalid');
  });
  const files = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir);
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
    if (!files.includes(required)) throw new ChatExportGenerationError('chat_export_docx_invalid');
  }
  if (
    files.some((name) =>
      /(?:vbaProject|activeX|embeddings|customUI|oleObject|externalLinks)/iu.test(name),
    )
  ) {
    throw new ChatExportGenerationError('chat_export_docx_active_content');
  }
  const xmlParser = new XMLParser({ processEntities: false, allowBooleanAttributes: true });
  let total = 0;
  for (const name of files) {
    const entry = zip.file(name);
    if (entry === null) throw new ChatExportGenerationError('chat_export_docx_invalid');
    const content = await entry.async('nodebuffer');
    total += content.byteLength;
    if (total > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new ChatExportGenerationError('chat_export_docx_invalid');
    }
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    const text = content.toString('utf8');
    if (/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External["']/iu.test(text)) {
      throw new ChatExportGenerationError('chat_export_docx_active_content');
    }
    try {
      xmlParser.parse(text);
    } catch {
      throw new ChatExportGenerationError('chat_export_docx_invalid');
    }
  }
};

const generateDocx = async (
  document: NormalizedChatDocument,
  provenance: ChatExportProvenance,
): Promise<GeneratedChatExport> => {
  const warnings = new Set(document.warnings);
  const children = [...docxBlocks(document.blocks, warnings)];
  if (warnings.size > 0) {
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Export notes')] }),
      ...[...warnings].map((warning) =>
        docxParagraph([{ text: warning }], { prefix: '• ', indent: 360 }),
      ),
    );
  }
  const output = new Document({
    creator: 'NodeRag',
    title: document.title,
    subject: `NodeRag artifact ${provenance.artifactId} revision ${String(provenance.revision)} SHA-256 ${provenance.sourceSha256}`,
    description: 'Deterministic safe export from a NodeRag Chat artifact.',
    keywords: `NodeRag, artifact revision ${String(provenance.revision)}`,
    revision: 1,
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [new TextRun({ text: document.title, color: '536B64', size: 18 })],
                border: {
                  bottom: { color: 'B5C7C1', style: BorderStyle.SINGLE, size: 4, space: 4 },
                },
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ children: ['Page ', PageNumber.CURRENT] })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  const packed = await Packer.toBuffer(output, false);
  const bytes = await canonicalizeDocx(packed);
  await validateSafeDocx(bytes);
  return { bytes, mimeType: DOCX_MIME, extension: 'docx', warnings: [...warnings] };
};

type FontScript = 'latin' | 'latinExt' | 'greek' | 'cyrillic' | 'devanagari' | 'vietnamese';

const fontScript = (codePoint: number): FontScript | null => {
  if (codePoint <= 0x024f || (codePoint >= 0x2000 && codePoint <= 0x206f)) return 'latin';
  if (codePoint >= 0x1e00 && codePoint <= 0x1eff) return 'vietnamese';
  if ((codePoint >= 0x0370 && codePoint <= 0x03ff) || (codePoint >= 0x1f00 && codePoint <= 0x1fff))
    return 'greek';
  if (codePoint >= 0x0400 && codePoint <= 0x052f) return 'cyrillic';
  if (codePoint >= 0x0900 && codePoint <= 0x097f) return 'devanagari';
  if ((codePoint >= 0x2c60 && codePoint <= 0x2c7f) || (codePoint >= 0xa720 && codePoint <= 0xa7ff))
    return 'latinExt';
  return null;
};

const pdfFontName = (script: FontScript, run: DocumentTextRun): string => {
  if (script !== 'latin') return `Noto-${script}`;
  if (run.bold === true) return 'Noto-latin-bold';
  if (run.italic === true) return 'Noto-latin-italic';
  return 'Noto-latin';
};

interface PdfSegment {
  readonly text: string;
  readonly font: string;
  readonly run: DocumentTextRun;
}

const pdfSegments = (
  runs: readonly DocumentTextRun[],
  warnings: Set<string>,
): readonly PdfSegment[] => {
  const output: PdfSegment[] = [];
  for (const run of runs) {
    let currentFont = '';
    let current = '';
    const flush = (): void => {
      if (current.length > 0) output.push({ text: current, font: currentFont, run });
      current = '';
    };
    for (const character of run.text) {
      const codePoint = character.codePointAt(0) ?? 0;
      const script = fontScript(codePoint);
      const safeCharacter = script === null ? '□' : character;
      const font = pdfFontName(script ?? 'latin', run);
      if (script === null)
        warnings.add('Some PDF glyphs outside the bundled font set were replaced with □.');
      if (font !== currentFont) {
        flush();
        currentFont = font;
      }
      current += safeCharacter;
    }
    flush();
  }
  return output;
};

const registerPdfFonts = (pdf: PDFKit.PDFDocument): void => {
  pdf.registerFont('Noto-latin', Buffer.from(notoLatin));
  pdf.registerFont('Noto-latin-bold', Buffer.from(notoLatinBold));
  pdf.registerFont('Noto-latin-italic', Buffer.from(notoLatinItalic));
  pdf.registerFont('Noto-latinExt', Buffer.from(notoLatinExtended));
  pdf.registerFont('Noto-greek', Buffer.from(notoGreek));
  pdf.registerFont('Noto-cyrillic', Buffer.from(notoCyrillic));
  pdf.registerFont('Noto-devanagari', Buffer.from(notoDevanagari));
  pdf.registerFont('Noto-vietnamese', Buffer.from(notoVietnamese));
};

const pdfRichText = (
  pdf: PDFKit.PDFDocument,
  runs: readonly DocumentTextRun[],
  warnings: Set<string>,
  options: { readonly size?: number; readonly indent?: number; readonly prefix?: string } = {},
): void => {
  const runsWithPrefix =
    options.prefix === undefined ? runs : [{ text: options.prefix, bold: true }, ...runs];
  const segments = pdfSegments(runsWithPrefix, warnings);
  if (segments.length === 0) {
    pdf.moveDown(0.5);
    return;
  }
  segments.forEach((segment, index) => {
    pdf
      .font(segment.font)
      .fontSize(options.size ?? 10.5)
      .fillColor('#17231f');
    pdf.text(segment.text, {
      continued: index < segments.length - 1,
      indent: options.indent ?? 0,
      lineGap: 2,
      strike: segment.run.strike === true,
    });
  });
  pdf.moveDown(0.5);
};

const pdfEnsureRoom = (pdf: PDFKit.PDFDocument, height: number): void => {
  if (pdf.y + height > pdf.page.height - pdf.page.margins.bottom - 30) pdf.addPage();
};

const pdfTable = (
  pdf: PDFKit.PDFDocument,
  block: Extract<DocumentBlock, { kind: 'table' }>,
  warnings: Set<string>,
): void => {
  const rows = [block.header, ...block.rows];
  const columns = Math.max(0, ...rows.map((row) => row.length));
  if (columns === 0) return;
  if (columns > 8) {
    warnings.add('A wide PDF table was exported in a line-oriented layout.');
    rows.forEach((row, rowIndex) => {
      pdfRichText(
        pdf,
        [
          {
            text: row.map((cell) => cell.map(({ text }) => text).join('')).join(' | '),
            bold: rowIndex === 0,
          },
        ],
        warnings,
      );
    });
    return;
  }
  const x = pdf.page.margins.left;
  const available = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;
  const width = available / columns;
  rows.forEach((row, rowIndex) => {
    pdf.font('Noto-latin').fontSize(8.5);
    const texts = Array.from({ length: columns }, (_, column) =>
      (row[column] ?? []).map(({ text }) => text).join(''),
    );
    const height = Math.max(
      28,
      ...texts.map((text) => pdf.heightOfString(text, { width: width - 10, lineGap: 1 }) + 12),
    );
    pdfEnsureRoom(pdf, height);
    const y = pdf.y;
    texts.forEach((text, column) => {
      pdf
        .rect(x + column * width, y, width, height)
        .fillAndStroke(rowIndex === 0 ? '#dcebe6' : '#ffffff', '#94aaa3');
      pdf
        .font(rowIndex === 0 ? 'Noto-latin-bold' : 'Noto-latin')
        .fontSize(8.5)
        .fillColor('#17231f')
        .text(text, x + column * width + 5, y + 6, { width: width - 10, lineGap: 1 });
    });
    pdf.y = y + height;
  });
  pdf.moveDown(0.7);
};

const pdfBlocks = (
  pdf: PDFKit.PDFDocument,
  blocks: readonly DocumentBlock[],
  warnings: Set<string>,
  depth = 0,
): void => {
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
        pdf.moveDown(block.level === 1 ? 0.8 : 0.45);
        pdfRichText(
          pdf,
          block.runs.map((run) => ({ ...run, bold: true })),
          warnings,
          {
            size: [22, 17, 14, 12, 11, 10][block.level - 1] ?? 10,
          },
        );
        break;
      case 'paragraph':
        pdfRichText(pdf, block.runs, warnings, { indent: depth * 18 });
        break;
      case 'blockquote': {
        const start = pdf.y;
        pdfBlocks(pdf, block.blocks, warnings, depth + 1);
        pdf
          .save()
          .strokeColor('#4b7569')
          .lineWidth(2)
          .moveTo(58 + depth * 8, start)
          .lineTo(58 + depth * 8, pdf.y)
          .stroke()
          .restore();
        break;
      }
      case 'list':
        block.items.forEach((item, itemIndex) => {
          const prefix = block.ordered ? `${String(block.start + itemIndex)}. ` : '• ';
          const [first, ...rest] = item;
          if (first?.kind === 'paragraph') {
            pdfRichText(pdf, first.runs, warnings, { prefix, indent: 14 + depth * 18 });
            pdfBlocks(pdf, rest, warnings, depth + 1);
          } else {
            pdfRichText(pdf, [{ text: ' ' }], warnings, { prefix, indent: 14 + depth * 18 });
            pdfBlocks(pdf, item, warnings, depth + 1);
          }
        });
        break;
      case 'table':
        pdfTable(pdf, block, warnings);
        break;
      case 'code': {
        const text = `${block.language === null ? '' : `[${block.language}]\n`}${block.text}`;
        pdf.font('Noto-latin').fontSize(8.5);
        const height = Math.min(460, pdf.heightOfString(text, { width: 470 }) + 18);
        pdfEnsureRoom(pdf, Math.max(34, height));
        const y = pdf.y;
        pdf.roundedRect(54, y, 487, Math.max(34, height), 4).fill('#f1f3f4');
        pdf
          .fillColor('#17231f')
          .text(text, 62, y + 8, { width: 470, height: height - 12, ellipsis: true });
        pdf.y = y + Math.max(34, height) + 10;
        break;
      }
      case 'equation':
        pdfEnsureRoom(pdf, 48);
        pdf.roundedRect(90, pdf.y, 415, 38, 4).fill('#f7f4ea');
        pdf
          .font('Noto-latin-italic')
          .fontSize(11)
          .fillColor('#17231f')
          .text(block.source, 100, pdf.y + 11, {
            width: 395,
            align: 'center',
            ellipsis: true,
          });
        pdf.y += 50;
        break;
      case 'diagram': {
        const rendered = renderMermaidDiagram(block.source);
        if (rendered === null) {
          warnings.add(
            'A Mermaid diagram outside the supported flowchart subset was exported as source text.',
          );
          pdfRichText(
            pdf,
            [{ text: `Diagram (Mermaid source):\n${block.source}`, code: true }],
            warnings,
          );
        } else {
          const width = Math.min(480, rendered.width);
          const height = Math.max(70, Math.round((rendered.height / rendered.width) * width));
          pdfEnsureRoom(pdf, height + 18);
          pdf.image(rendered.bytes, (pdf.page.width - width) / 2, pdf.y, { fit: [width, height] });
          pdf.y += height + 18;
          pdfRichText(
            pdf,
            [{ text: `Diagram source: ${block.source.replaceAll('\n', ' ').trim()}` }],
            warnings,
            { size: 8 },
          );
        }
        break;
      }
      case 'page_break':
        pdf.addPage();
        break;
      case 'horizontal_rule':
        pdfEnsureRoom(pdf, 20);
        pdf
          .moveDown(0.35)
          .strokeColor('#80958f')
          .lineWidth(0.7)
          .moveTo(54, pdf.y)
          .lineTo(541, pdf.y)
          .stroke();
        pdf.moveDown(0.8);
        break;
      case 'degradation':
        pdfEnsureRoom(pdf, 38);
        pdf.roundedRect(54, pdf.y, 487, 30, 4).fill('#fff7d6');
        pdf
          .font('Noto-latin-italic')
          .fontSize(9.5)
          .fillColor('#725b00')
          .text(block.label, 62, pdf.y + 8, { width: 470 });
        pdf.y += 42;
        break;
    }
  }
};

export const validateSafePdf = (bytes: Buffer): void => {
  if (!bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-')) {
    throw new ChatExportGenerationError('chat_export_pdf_invalid');
  }
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1');
  if (!tail.includes('%%EOF')) throw new ChatExportGenerationError('chat_export_pdf_invalid');
  const source = bytes.toString('latin1');
  if (/\/(?:JavaScript|JS|Launch|EmbeddedFile|OpenAction|RichMedia)\b|\/AA\s*<</u.test(source)) {
    throw new ChatExportGenerationError('chat_export_pdf_active_content');
  }
};

const generatePdf = async (
  document: NormalizedChatDocument,
  provenance: ChatExportProvenance,
): Promise<GeneratedChatExport> => {
  const warnings = new Set(document.warnings);
  const pdf = new PDFDocument({
    size: 'A4',
    margins: { top: 60, right: 54, bottom: 62, left: 54 },
    bufferPages: true,
    autoFirstPage: true,
    compress: true,
    pdfVersion: '1.7',
    subset: 'PDF/A-2b',
    info: {
      Title: document.title,
      Author: 'NodeRag',
      Subject: `Artifact ${provenance.artifactId} revision ${String(provenance.revision)} SHA-256 ${provenance.sourceSha256}`,
      Keywords: 'NodeRag chat artifact export',
      Creator: 'NodeRag chat-export.v1',
      Producer: 'NodeRag chat-export.v1',
      CreationDate: FIXED_DATE,
      ModDate: FIXED_DATE,
    },
  });
  registerPdfFonts(pdf);
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    pdf.once('error', reject);
    pdf.once('end', () => resolve(Buffer.concat(chunks)));
  });
  pdfBlocks(pdf, document.blocks, warnings);
  if (warnings.size > 0) {
    pdf.addPage();
    pdfRichText(pdf, [{ text: 'Export notes', bold: true }], warnings, { size: 17 });
    for (const warning of warnings)
      pdfRichText(pdf, [{ text: warning }], warnings, { prefix: '• ' });
  }
  const range = pdf.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page += 1) {
    pdf.switchToPage(page);
    pdf
      .font('Noto-latin')
      .fontSize(8)
      .fillColor('#536b64')
      .text(document.title, 54, 28, { width: 487, ellipsis: true });
    pdf
      .font('Noto-latin')
      .fontSize(8)
      .fillColor('#536b64')
      .text(`Page ${String(page + 1)} of ${String(range.count)}`, 54, pdf.page.height - 38, {
        width: 487,
        align: 'center',
      });
  }
  pdf.end();
  const bytes = await completed;
  validateSafePdf(bytes);
  return { bytes, mimeType: PDF_MIME, extension: 'pdf', warnings: [...warnings] };
};

export const generateChatExport = async (
  document: NormalizedChatDocument,
  format: ChatExportFormat,
  provenance: ChatExportProvenance,
  maximumBytes = MAX_EXPORT_BYTES,
): Promise<GeneratedChatExport> => {
  const generated =
    format === 'docx'
      ? await generateDocx(document, provenance)
      : await generatePdf(document, provenance);
  if (generated.bytes.byteLength > maximumBytes) {
    throw new ChatExportGenerationError('chat_export_output_too_large');
  }
  return generated;
};
