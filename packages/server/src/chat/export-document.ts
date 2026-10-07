import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';

export const CHAT_DOCUMENT_MODEL_VERSION = 'chat-document.v1' as const;
export const CHAT_EXPORT_GENERATOR_REVISION = 'chat-export.v1' as const;
export const CHAT_EXPORT_FORMAT_POLICY_REVISION = 'safe-office-pdf.v1' as const;

const MAX_SOURCE_CHARACTERS = 10_485_760;
const MAX_BLOCKS = 50_000;
const MAX_TABLE_COLUMNS = 50;
const MAX_TABLE_ROWS = 500;
const MAX_WARNINGS = 200;

export interface DocumentTextRun {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strike?: boolean;
  readonly code?: boolean;
}

export type DocumentBlock =
  | {
      readonly kind: 'heading';
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly runs: readonly DocumentTextRun[];
    }
  | { readonly kind: 'paragraph'; readonly runs: readonly DocumentTextRun[] }
  | { readonly kind: 'blockquote'; readonly blocks: readonly DocumentBlock[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly DocumentBlock[])[];
    }
  | {
      readonly kind: 'table';
      readonly header: readonly (readonly DocumentTextRun[])[];
      readonly rows: readonly (readonly (readonly DocumentTextRun[])[])[];
    }
  | { readonly kind: 'code'; readonly language: string | null; readonly text: string }
  | { readonly kind: 'equation'; readonly source: string }
  | { readonly kind: 'diagram'; readonly language: 'mermaid'; readonly source: string }
  | { readonly kind: 'page_break' }
  | { readonly kind: 'horizontal_rule' }
  | { readonly kind: 'degradation'; readonly label: string; readonly source?: string };

export interface NormalizedChatDocument {
  readonly version: typeof CHAT_DOCUMENT_MODEL_VERSION;
  readonly title: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly blocks: readonly DocumentBlock[];
  readonly warnings: readonly string[];
}

export interface ParsedChatDocument {
  readonly document: NormalizedChatDocument;
  readonly canonicalJson: string;
  readonly sha256: string;
}

export class ChatDocumentError extends Error {
  constructor(
    readonly code:
      | 'chat_export_source_too_large'
      | 'chat_export_document_too_complex'
      | 'chat_export_markdown_invalid',
  ) {
    super(code);
    this.name = 'ChatDocumentError';
  }
}

const parser = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

type MarkdownToken = ReturnType<typeof parser.parse>[number];

const visibleText = (runs: readonly DocumentTextRun[]): string =>
  runs.map(({ text }) => text).join('');

const cleanLanguage = (value: string): string | null => {
  const language = value.trim().split(/\s+/u, 1)[0]?.toLocaleLowerCase('en-US') ?? '';
  return /^[a-z0-9_+#.-]{1,40}$/u.test(language) ? language : null;
};

const safePlainUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
};

const parseFrontMatter = (
  source: string,
): { readonly source: string; readonly metadata: Readonly<Record<string, string>> } => {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== '---') return { source, metadata: {} };
  const closing = lines.slice(1, 102).findIndex((line) => line.trim() === '---');
  if (closing < 0) return { source, metadata: {} };
  const metadata: Record<string, string> = {};
  for (const line of lines.slice(1, closing + 1)) {
    const match = /^([A-Za-z][A-Za-z0-9 _-]{0,39}):\s*(.{0,500})$/u.exec(line);
    if (match === null) continue;
    const key = (match[1] ?? '').trim().toLocaleLowerCase('en-US').replaceAll(' ', '-');
    const value = (match[2] ?? '').trim();
    if (value.length > 0) metadata[key] = value;
  }
  return { source: lines.slice(closing + 2).join('\n'), metadata };
};

const matchingClose = (tokens: readonly MarkdownToken[], open: number): number => {
  const type = tokens[open]?.type;
  if (type === undefined || !type.endsWith('_open')) return open;
  const closeType = `${type.slice(0, -5)}_close`;
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index]?.type === type) depth += 1;
    if (tokens[index]?.type === closeType) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new ChatDocumentError('chat_export_markdown_invalid');
};

const inlineRuns = (
  token: MarkdownToken | undefined,
  warn: (warning: string) => void,
): readonly DocumentTextRun[] => {
  const output: DocumentTextRun[] = [];
  let bold = false;
  let italic = false;
  let strike = false;
  const links: (string | null)[] = [];
  const push = (text: string, code = false): void => {
    if (text.length === 0) return;
    const previous = output.at(-1);
    if (
      previous !== undefined &&
      previous.bold === (bold || undefined) &&
      previous.italic === (italic || undefined) &&
      previous.strike === (strike || undefined) &&
      previous.code === (code || undefined)
    ) {
      output[output.length - 1] = { ...previous, text: `${previous.text}${text}` };
      return;
    }
    output.push({
      text,
      ...(bold ? { bold: true } : {}),
      ...(italic ? { italic: true } : {}),
      ...(strike ? { strike: true } : {}),
      ...(code ? { code: true } : {}),
    });
  };
  for (const child of token?.children ?? []) {
    switch (child.type) {
      case 'text':
        push(child.content);
        break;
      case 'code_inline':
        push(child.content, true);
        break;
      case 'softbreak':
      case 'hardbreak':
        push('\n');
        break;
      case 'strong_open':
        bold = true;
        break;
      case 'strong_close':
        bold = false;
        break;
      case 'em_open':
        italic = true;
        break;
      case 'em_close':
        italic = false;
        break;
      case 's_open':
        strike = true;
        break;
      case 's_close':
        strike = false;
        break;
      case 'link_open': {
        const url = safePlainUrl(String(child.attrGet('href') ?? ''));
        if (url === null) warn('A non-HTTP link target was omitted from the export.');
        links.push(url);
        break;
      }
      case 'link_close': {
        const url = links.pop();
        if (url !== null && url !== undefined) push(` (${url})`);
        break;
      }
      case 'image':
        push(`[Image: ${child.content.length > 0 ? child.content : 'untitled'} — source omitted]`);
        warn(
          'Markdown images are represented by a safe placeholder; external image retrieval is disabled.',
        );
        break;
      case 'html_inline':
        push('[Raw HTML omitted]');
        warn('Raw HTML was omitted from the export.');
        break;
      default:
        if (child.content.length > 0) push(child.content);
        break;
    }
  }
  if (links.length > 0) warn('An incomplete Markdown link was exported as plain text.');
  return output;
};

interface ParseState {
  readonly warnings: string[];
  blockCount: number;
}

const appendBlock = (state: ParseState, output: DocumentBlock[], block: DocumentBlock): void => {
  state.blockCount += 1;
  if (state.blockCount > MAX_BLOCKS) {
    throw new ChatDocumentError('chat_export_document_too_complex');
  }
  output.push(block);
};

const tableBlock = (
  tokens: readonly MarkdownToken[],
  start: number,
  end: number,
  warn: (warning: string) => void,
): DocumentBlock => {
  const rows: (readonly (readonly DocumentTextRun[])[])[] = [];
  let header: readonly (readonly DocumentTextRun[])[] = [];
  let current: (readonly DocumentTextRun[])[] | null = null;
  let inHeader = false;
  for (let index = start + 1; index < end; index += 1) {
    const token = tokens[index];
    if (token?.type === 'thead_open') inHeader = true;
    else if (token?.type === 'thead_close') inHeader = false;
    else if (token?.type === 'tr_open') current = [];
    else if (token?.type === 'tr_close' && current !== null) {
      if (inHeader && header.length === 0) header = current;
      else rows.push(current);
      current = null;
    } else if ((token?.type === 'th_open' || token?.type === 'td_open') && current !== null) {
      const inline = tokens[index + 1];
      current.push(inlineRuns(inline?.type === 'inline' ? inline : undefined, warn));
    }
  }
  const columns = Math.max(header.length, ...rows.map((row) => row.length), 0);
  if (columns > MAX_TABLE_COLUMNS || rows.length > MAX_TABLE_ROWS) {
    warn('A very large table was replaced with a readable warning.');
    return {
      kind: 'degradation',
      label: `Table omitted safely (${String(rows.length)} rows by ${String(columns)} columns).`,
    };
  }
  if (header.length === 0 && rows.length > 0) header = rows.shift() ?? [];
  return { kind: 'table', header, rows };
};

const parseBlocks = (
  tokens: readonly MarkdownToken[],
  start: number,
  end: number,
  state: ParseState,
): readonly DocumentBlock[] => {
  const output: DocumentBlock[] = [];
  const warn = (warning: string): void => {
    if (!state.warnings.includes(warning) && state.warnings.length < MAX_WARNINGS) {
      state.warnings.push(warning);
    }
  };
  let index = start;
  while (index < end) {
    const token = tokens[index];
    if (token === undefined) break;
    if (token.type === 'heading_open') {
      const level = Number(token.tag.slice(1));
      const runs = inlineRuns(tokens[index + 1], warn);
      appendBlock(state, output, {
        kind: 'heading',
        level: Math.min(6, Math.max(1, level)) as 1 | 2 | 3 | 4 | 5 | 6,
        runs,
      });
      index = matchingClose(tokens, index) + 1;
      continue;
    }
    if (token.type === 'paragraph_open') {
      const runs = inlineRuns(tokens[index + 1], warn);
      const text = visibleText(runs).trim();
      if (text.startsWith('$$') && text.endsWith('$$') && text.length >= 4) {
        appendBlock(state, output, { kind: 'equation', source: text.slice(2, -2).trim() });
        warn('Equations are exported as selectable source text rather than executable content.');
      } else if (text === '<!-- pagebreak -->' || text === '::: page-break') {
        appendBlock(state, output, { kind: 'page_break' });
      } else {
        appendBlock(state, output, { kind: 'paragraph', runs });
      }
      index = matchingClose(tokens, index) + 1;
      continue;
    }
    if (token.type === 'blockquote_open') {
      const close = matchingClose(tokens, index);
      appendBlock(state, output, {
        kind: 'blockquote',
        blocks: parseBlocks(tokens, index + 1, close, state),
      });
      index = close + 1;
      continue;
    }
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      const close = matchingClose(tokens, index);
      const items: (readonly DocumentBlock[])[] = [];
      let cursor = index + 1;
      while (cursor < close) {
        if (tokens[cursor]?.type !== 'list_item_open') {
          cursor += 1;
          continue;
        }
        const itemClose = matchingClose(tokens, cursor);
        items.push(parseBlocks(tokens, cursor + 1, itemClose, state));
        cursor = itemClose + 1;
      }
      appendBlock(state, output, {
        kind: 'list',
        ordered: token.type === 'ordered_list_open',
        start: Math.max(1, Number(token.attrGet('start') ?? 1)),
        items,
      });
      index = close + 1;
      continue;
    }
    if (token.type === 'table_open') {
      const close = matchingClose(tokens, index);
      appendBlock(state, output, tableBlock(tokens, index, close, warn));
      index = close + 1;
      continue;
    }
    if (token.type === 'fence' || token.type === 'code_block') {
      const language = cleanLanguage(token.info);
      if (language === 'mermaid') {
        appendBlock(state, output, { kind: 'diagram', language: 'mermaid', source: token.content });
      } else if (language === 'math' || language === 'latex' || language === 'equation') {
        appendBlock(state, output, { kind: 'equation', source: token.content.trim() });
        warn('Equations are exported as selectable source text rather than executable content.');
      } else {
        appendBlock(state, output, { kind: 'code', language, text: token.content });
      }
      index += 1;
      continue;
    }
    if (token.type === 'hr') {
      appendBlock(state, output, { kind: 'horizontal_rule' });
      index += 1;
      continue;
    }
    if (token.type === 'html_block') {
      if (token.content.trim() === '<!-- pagebreak -->') {
        appendBlock(state, output, { kind: 'page_break' });
      } else {
        appendBlock(state, output, { kind: 'degradation', label: 'Raw HTML omitted safely.' });
        warn('Raw HTML was omitted from the export.');
      }
      index += 1;
      continue;
    }
    if (token.type === 'inline') {
      appendBlock(state, output, { kind: 'paragraph', runs: inlineRuns(token, warn) });
      index += 1;
      continue;
    }
    index += 1;
  }
  return output;
};

export const parseChatMarkdown = (markdown: string, fallbackTitle: string): ParsedChatDocument => {
  const normalized = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n').normalize('NFC');
  if (normalized.length > MAX_SOURCE_CHARACTERS) {
    throw new ChatDocumentError('chat_export_source_too_large');
  }
  const frontMatter = parseFrontMatter(normalized);
  const tokens = parser.parse(frontMatter.source, {});
  const state: ParseState = { warnings: [], blockCount: 0 };
  const blocks = parseBlocks(tokens, 0, tokens.length, state);
  const firstHeading = blocks.find(
    (block): block is Extract<DocumentBlock, { kind: 'heading' }> => block.kind === 'heading',
  );
  const title = (
    frontMatter.metadata['title'] ??
    (firstHeading === undefined ? fallbackTitle : visibleText(firstHeading.runs))
  )
    .trim()
    .slice(0, 240);
  const document: NormalizedChatDocument = {
    version: CHAT_DOCUMENT_MODEL_VERSION,
    title: title.length > 0 ? title : 'NodeRag document',
    metadata: frontMatter.metadata,
    blocks,
    warnings: state.warnings,
  };
  const canonicalJson = JSON.stringify(document);
  return {
    document,
    canonicalJson,
    sha256: createHash('sha256').update(canonicalJson).digest('hex'),
  };
};
