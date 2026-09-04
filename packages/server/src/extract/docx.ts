import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type {
  ExtractedDocument,
  ExtractedImage,
  ExtractedPage,
  ExtractionOptions,
  InjectedVision,
} from './contract.js';
import { openOfficeArchive, type OfficeArchive } from './office-archive.js';

type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  removeNSPrefix: true,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

const childArray = (node: XmlNode, name: string): readonly XmlNode[] => {
  const value = node[name];
  return Array.isArray(value) ? (value as XmlNode[]) : [];
};

const attributes = (node: XmlNode): Readonly<Record<string, string>> => {
  const value = node[':@'];
  return value !== null && typeof value === 'object'
    ? (value as Readonly<Record<string, string>>)
    : {};
};

const findTag = (nodes: readonly XmlNode[], name: string): XmlNode | null => {
  for (const node of nodes) {
    if (name in node) return node;
    for (const value of Object.values(node)) {
      if (!Array.isArray(value)) continue;
      const found = findTag(value as XmlNode[], name);
      if (found !== null) return found;
    }
  }
  return null;
};

const allTags = (nodes: readonly XmlNode[], name: string): readonly XmlNode[] => {
  const found: XmlNode[] = [];
  for (const node of nodes) {
    if (name in node) found.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) found.push(...allTags(value as XmlNode[], name));
    }
  }
  return found;
};

const textContent = (nodes: readonly XmlNode[]): string => {
  let output = '';
  for (const node of nodes) {
    const text = node['#text'];
    if (typeof text === 'string') output += text;
    for (const [name, value] of Object.entries(node)) {
      if (name === ':@' || name === '#text' || !Array.isArray(value)) continue;
      output += textContent(value as XmlNode[]);
    }
  }
  return output;
};

const relationMap = async (archive: OfficeArchive): Promise<ReadonlyMap<string, string>> => {
  const path = 'word/_rels/document.xml.rels';
  if (!archive.entries.has(path)) return new Map();
  const nodes = parser.parse(await archive.text(path)) as XmlNode[];
  const relations = new Map<string, string>();
  for (const node of allTags(nodes, 'Relationship')) {
    const value = attributes(node);
    const id = value['@_Id'];
    const target = value['@_Target'];
    if (id !== undefined && target !== undefined && !target.includes('..')) {
      relations.set(id, posix.normalize(posix.join('word', target)));
    }
  }
  return relations;
};

const mediaType = (path: string): string => {
  const extension = posix.extname(path).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
};

interface RenderContext {
  readonly archive: OfficeArchive;
  readonly relations: ReadonlyMap<string, string>;
  readonly injectedVision?: InjectedVision;
  readonly images: ExtractedImage[];
  readonly warnings: string[];
  renderedBreakSeen: boolean;
  explicitBreakSeen: boolean;
}

const imageBlock = async (relationshipId: string, context: RenderContext): Promise<string> => {
  const path = context.relations.get(relationshipId);
  if (path === undefined || !context.archive.entries.has(path)) {
    context.warnings.push('docx-image-relationship-missing');
    return '';
  }
  const bytes = await context.archive.read(path);
  const id = createHash('sha256').update(bytes).digest('hex');
  const sequence = context.images.length;
  if (context.injectedVision === undefined) {
    context.images.push({
      id,
      sequence,
      mediaType: mediaType(path),
      bytes,
      disposition: 'pending_vision',
    });
    context.warnings.push('docx-image-vision-pending');
    return `<!-- noderag:image id="${id}" -->\n[Image pending analysis]\n<!-- /noderag:image -->`;
  }
  const result = await context.injectedVision.analyse({
    kind: 'document-image',
    bytes,
    mediaType: mediaType(path),
    pageNumber: null,
    imageId: id,
  });
  context.images.push({
    id,
    sequence,
    mediaType: mediaType(path),
    bytes,
    disposition: 'analysed',
    visionModel: result.model,
  });
  return `<!-- noderag:image id="${id}" -->\n${result.markdown}\n<!-- /noderag:image -->`;
};

const pageSentinel = '\u0000NODERAG_PAGE_BREAK\u0000';

const renderRun = async (run: XmlNode, context: RenderContext): Promise<string> => {
  const values = childArray(run, 'r');
  const properties = values.find((value) => 'rPr' in value);
  const propertyNodes = properties === undefined ? [] : childArray(properties, 'rPr');
  const bold = findTag(propertyNodes, 'b') !== null;
  const italic = findTag(propertyNodes, 'i') !== null;
  let output = '';
  for (const node of values) {
    if ('t' in node) output += textContent(childArray(node, 't'));
    else if ('tab' in node) output += '\t';
    else if ('br' in node) {
      const type = attributes(node)['@_type'];
      if (type === 'page') {
        context.explicitBreakSeen = true;
        output += pageSentinel;
      } else output += '\n';
    } else if ('lastRenderedPageBreak' in node) {
      context.renderedBreakSeen = true;
      output += pageSentinel;
    } else if ('footnoteReference' in node) {
      const id = attributes(node)['@_id'];
      if (id !== undefined && !id.startsWith('-')) output += `[^${id}]`;
    } else if ('drawing' in node || 'pict' in node) {
      for (const blip of allTags([node], 'blip')) {
        const id = attributes(blip)['@_embed'];
        if (id !== undefined) output += await imageBlock(id, context);
      }
    }
  }
  if (output.length === 0 || output.includes(pageSentinel)) return output;
  if (bold) output = `**${output}**`;
  if (italic) output = `*${output}*`;
  return output;
};

const paragraphStyle = (paragraph: XmlNode): string | null => {
  const style = findTag(childArray(paragraph, 'p'), 'pStyle');
  return style === null ? null : (attributes(style)['@_val'] ?? null);
};

const listProperties = (
  paragraph: XmlNode,
): { readonly level: number; readonly id: string } | null => {
  const num = findTag(childArray(paragraph, 'p'), 'numPr');
  if (num === null) return null;
  const values = childArray(num, 'numPr');
  const level = findTag(values, 'ilvl');
  const id = findTag(values, 'numId');
  const numberId = id === null ? undefined : attributes(id)['@_val'];
  if (numberId === undefined) return null;
  return { level: Number(attributes(level ?? {})['@_val'] ?? 0), id: numberId };
};

const renderParagraph = async (
  paragraph: XmlNode,
  context: RenderContext,
  orderedLists: ReadonlySet<string>,
): Promise<string> => {
  let output = '';
  for (const node of childArray(paragraph, 'p')) {
    if ('r' in node) output += await renderRun(node, context);
    else if ('hyperlink' in node || 'fldSimple' in node) {
      for (const run of allTags([node], 'r')) output += await renderRun(run, context);
    }
  }
  const style = paragraphStyle(paragraph);
  const heading = style?.match(/(?:Heading|heading)\s*([1-6])/u);
  if (heading !== null && heading !== undefined) {
    return `${'#'.repeat(Number(heading[1]))} ${output.trim()}`;
  }
  if (style === 'Title') return `# ${output.trim()}`;
  const list = listProperties(paragraph);
  if (list !== null) {
    const marker = orderedLists.has(list.id) ? '1.' : '-';
    return `${'  '.repeat(Math.max(0, list.level))}${marker} ${output.trim()}`;
  }
  return output.trim();
};

const orderedNumberingIds = async (archive: OfficeArchive): Promise<ReadonlySet<string>> => {
  if (!archive.entries.has('word/numbering.xml')) return new Set();
  const nodes = parser.parse(await archive.text('word/numbering.xml')) as XmlNode[];
  const orderedAbstract = new Set<string>();
  for (const abstract of allTags(nodes, 'abstractNum')) {
    const id = attributes(abstract)['@_abstractNumId'];
    const formats = allTags(childArray(abstract, 'abstractNum'), 'numFmt').map(
      (format) => attributes(format)['@_val'],
    );
    if (id !== undefined && formats.some((format) => format !== undefined && format !== 'bullet')) {
      orderedAbstract.add(id);
    }
  }
  const orderedIds = new Set<string>();
  for (const num of allTags(nodes, 'num')) {
    const id = attributes(num)['@_numId'];
    const abstract = findTag(childArray(num, 'num'), 'abstractNumId');
    if (id !== undefined && abstract !== null) {
      const abstractId = attributes(abstract)['@_val'];
      if (abstractId !== undefined && orderedAbstract.has(abstractId)) orderedIds.add(id);
    }
  }
  return orderedIds;
};

const renderTable = async (
  table: XmlNode,
  context: RenderContext,
  orderedLists: ReadonlySet<string>,
): Promise<string> => {
  const rows: string[][] = [];
  for (const row of childArray(table, 'tbl').filter((node) => 'tr' in node)) {
    const cells: string[] = [];
    for (const cell of childArray(row, 'tr').filter((node) => 'tc' in node)) {
      const paragraphs = allTags(childArray(cell, 'tc'), 'p');
      const body = (
        await Promise.all(
          paragraphs.map((paragraph) => renderParagraph(paragraph, context, orderedLists)),
        )
      )
        .filter(Boolean)
        .join('<br>');
      cells.push(body.replaceAll('|', '\\|'));
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';
  const columns = Math.max(...rows.map(({ length }) => length));
  const normalized = rows.map((row) =>
    Array.from({ length: columns }, (_, index) => row[index] ?? ''),
  );
  return [
    `| ${normalized[0]?.join(' | ')} |`,
    `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
};

const footnoteDefinitions = async (
  archive: OfficeArchive,
  context: RenderContext,
  orderedLists: ReadonlySet<string>,
): Promise<readonly string[]> => {
  if (!archive.entries.has('word/footnotes.xml')) return [];
  const nodes = parser.parse(await archive.text('word/footnotes.xml')) as XmlNode[];
  const definitions: string[] = [];
  for (const footnote of allTags(nodes, 'footnote')) {
    const id = attributes(footnote)['@_id'];
    if (id === undefined || id.startsWith('-')) continue;
    const text = (
      await Promise.all(
        allTags(childArray(footnote, 'footnote'), 'p').map((paragraph) =>
          renderParagraph(paragraph, context, orderedLists),
        ),
      )
    )
      .filter(Boolean)
      .join(' ');
    definitions.push(`[^${id}]: ${text}`);
  }
  return definitions;
};

export const extractDocx = async (
  bytes: Uint8Array,
  options: ExtractionOptions = {},
  injectedVision?: InjectedVision,
): Promise<ExtractedDocument> => {
  const archive = await openOfficeArchive(bytes, options);
  if (!archive.entries.has('[Content_Types].xml') || !archive.entries.has('word/document.xml')) {
    throw new Error('invalid-docx-package');
  }
  const nodes = parser.parse(await archive.text('word/document.xml')) as XmlNode[];
  const body = findTag(nodes, 'body');
  if (body === null) throw new Error('docx-body-missing');
  const context: RenderContext = {
    archive,
    relations: await relationMap(archive),
    ...(injectedVision === undefined ? {} : { injectedVision }),
    images: [],
    warnings: [],
    renderedBreakSeen: false,
    explicitBreakSeen: false,
  };
  const orderedLists = await orderedNumberingIds(archive);
  const pageBlocks: string[][] = [[]];
  const appendBlock = (block: string): void => {
    const segments = block.split(pageSentinel);
    segments.forEach((segment, index) => {
      if (segment.trim().length > 0) pageBlocks.at(-1)?.push(segment.trim());
      if (index + 1 < segments.length) pageBlocks.push([]);
    });
  };
  for (const node of childArray(body, 'body')) {
    if ('p' in node) appendBlock(await renderParagraph(node, context, orderedLists));
    else if ('tbl' in node) appendBlock(await renderTable(node, context, orderedLists));
    else if ('sectPr' in node) {
      const type = findTag(childArray(node, 'sectPr'), 'type');
      if (attributes(type ?? {})['@_val'] === 'nextPage') {
        context.explicitBreakSeen = true;
        pageBlocks.push([]);
      }
    }
  }
  const footnotes = await footnoteDefinitions(archive, context, orderedLists);
  if (footnotes.length > 0) pageBlocks.at(-1)?.push(footnotes.join('\n'));
  while (pageBlocks.length > 1 && pageBlocks.at(-1)?.length === 0) pageBlocks.pop();
  const basis = context.renderedBreakSeen
    ? 'rendered'
    : context.explicitBreakSeen
      ? 'explicit'
      : 'none';
  const pages: ExtractedPage[] = pageBlocks.map((blocks, ordinal) => ({
    ordinal,
    pageNumber: basis === 'none' ? null : ordinal + 1,
    label: basis === 'none' ? null : String(ordinal + 1),
    body: blocks.join('\n\n'),
    extraction: context.images.some(({ disposition }) => disposition === 'analysed')
      ? 'mixed'
      : 'text',
    confidence: 1,
    warnings: context.warnings,
    images: ordinal === 0 ? context.images : [],
    metadata: {},
  }));
  if (pages.length > (options.maximumPages ?? 1000)) throw new Error('docx-page-limit-exceeded');
  return {
    format: 'docx',
    pages,
    pageBasis: basis,
    encoding: null,
    encodingConfidence: null,
    offsetsMatchOriginal: false,
    warnings: [...new Set(context.warnings)],
    metadata: {
      renderedBreakSeen: context.renderedBreakSeen,
      explicitBreakSeen: context.explicitBreakSeen,
      imageCount: context.images.length,
      footnoteCount: footnotes.length,
    },
  };
};
