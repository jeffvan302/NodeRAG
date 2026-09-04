import { createLocatorMap, isUtf16Boundary, type DualRange } from './locator.js';

export interface ChunkProfile {
  readonly targetCharacters: number;
  readonly overlapCharacters: number;
  readonly snapWindow: number;
  readonly headingPrefix: boolean;
}

export interface ChunkCandidate extends DualRange {
  readonly ordinal: number;
  readonly text: string;
  readonly headingPath: readonly string[];
  readonly embeddingText: string;
  readonly structureKind: string | null;
  readonly structureKinds: readonly string[];
  readonly continuation: Readonly<Record<string, unknown>>;
}

interface Heading {
  readonly offset: number;
  readonly level: number;
  readonly text: string;
}

interface MarkdownBlock {
  readonly start: number;
  readonly end: number;
  readonly kind: 'code' | 'image-provenance' | 'list-item' | 'table';
  readonly repeatedHeader?: string;
}

const assertProfile = (profile: ChunkProfile): void => {
  if (profile.targetCharacters < 200 || profile.targetCharacters > 8000) {
    throw new RangeError('targetCharacters must be between 200 and 8000.');
  }
  if (profile.overlapCharacters < 0 || profile.overlapCharacters > profile.targetCharacters / 2) {
    throw new RangeError('overlapCharacters must be between zero and half the target.');
  }
  if (profile.snapWindow < 0 || profile.snapWindow > 0.5) {
    throw new RangeError('snapWindow must be between zero and 0.5.');
  }
};

const headingsIn = (text: string): readonly Heading[] => {
  const headings: Heading[] = [];
  const expression = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/gmu;
  for (const match of text.matchAll(expression)) {
    const marks = match[1];
    const label = match[2];
    if (marks !== undefined && label !== undefined && match.index !== undefined) {
      headings.push({ offset: match.index, level: marks.length, text: label });
    }
  }
  return headings;
};

const headingPathAt = (headings: readonly Heading[], offset: number): readonly string[] => {
  const path: string[] = [];
  for (const heading of headings) {
    if (heading.offset > offset) break;
    path.length = heading.level - 1;
    path[heading.level - 1] = heading.text;
  }
  return path.filter((value): value is string => value !== undefined);
};

const lastBoundary = (text: string, start: number, end: number, expression: RegExp): number => {
  expression.lastIndex = start;
  let found = -1;
  while (true) {
    const match = expression.exec(text);
    if (match === null || match.index >= end) break;
    const candidate = match.index + match[0].length;
    if (candidate <= end && isUtf16Boundary(text, candidate)) found = candidate;
    if (match[0].length === 0) expression.lastIndex += 1;
  }
  return found;
};

const lineRanges = (
  text: string,
): Array<{ readonly start: number; readonly end: number; readonly text: string }> => {
  const lines: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline + 1;
    lines.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return lines;
};

const markdownBlocks = (text: string): readonly MarkdownBlock[] => {
  const lines = lineRanges(text);
  const blocks: MarkdownBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const fence = /^\s*(`{3,}|~{3,})/u.exec(line.text)?.[1];
    if (fence !== undefined) {
      let endIndex = index + 1;
      while (
        endIndex < lines.length &&
        !new RegExp(`^\\s*${fence[0]}{${fence.length},}`).test(lines[endIndex]?.text ?? '')
      )
        endIndex += 1;
      const last = lines[Math.min(endIndex, lines.length - 1)];
      blocks.push({ start: line.start, end: last?.end ?? line.end, kind: 'code' });
      index = Math.min(endIndex, lines.length - 1);
      continue;
    }
    if (/^\s*<!--\s*noderag:image\b/iu.test(line.text)) {
      let endIndex = index + 1;
      while (
        endIndex < lines.length &&
        !/<!--\s*\/noderag:image\s*-->/iu.test(lines[endIndex]?.text ?? '')
      )
        endIndex += 1;
      const last = lines[Math.min(endIndex, lines.length - 1)];
      blocks.push({ start: line.start, end: last?.end ?? line.end, kind: 'image-provenance' });
      index = Math.min(endIndex, lines.length - 1);
      continue;
    }
    const next = lines[index + 1];
    if (
      line.text.includes('|') &&
      next !== undefined &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(next.text.trimEnd())
    ) {
      let endIndex = index + 2;
      while (endIndex < lines.length && (lines[endIndex]?.text.includes('|') ?? false))
        endIndex += 1;
      blocks.push({
        start: line.start,
        end: lines[endIndex - 1]?.end ?? next.end,
        kind: 'table',
        repeatedHeader: `${line.text}${next.text}`,
      });
      index = endIndex - 1;
      continue;
    }
    if (/^\s*(?:[-+*]|\d+[.)])\s+/u.test(line.text)) {
      let endIndex = index + 1;
      while (
        endIndex < lines.length &&
        (/^\s{2,}\S/u.test(lines[endIndex]?.text ?? '') ||
          /^\s*$/u.test(lines[endIndex]?.text ?? ''))
      )
        endIndex += 1;
      blocks.push({
        start: line.start,
        end: lines[endIndex - 1]?.end ?? line.end,
        kind: 'list-item',
      });
      index = endIndex - 1;
    }
  }
  return blocks;
};

const containingBlock = (
  blocks: readonly MarkdownBlock[],
  offset: number,
): MarkdownBlock | undefined => blocks.find((block) => offset > block.start && offset < block.end);

const snapEnd = (
  text: string,
  chunkStart: number,
  nominalEnd: number,
  window: number,
  target: number,
  overlap: number,
  blocks: readonly MarkdownBlock[],
): number => {
  if (nominalEnd >= text.length) return text.length;
  const protectedBlock = containingBlock(blocks, nominalEnd);
  if (protectedBlock !== undefined && protectedBlock.end - protectedBlock.start <= target) {
    if (protectedBlock.start > chunkStart) return protectedBlock.start;
    return protectedBlock.end;
  }
  const earliest = Math.max(chunkStart + 1, nominalEnd - window);
  if (protectedBlock !== undefined) {
    const lineEnd = lastBoundary(text, earliest, nominalEnd, /\n/gu);
    if (
      lineEnd > chunkStart + overlap &&
      isUtf16Boundary(text, lineEnd) &&
      isUtf16Boundary(text, lineEnd - overlap)
    ) {
      return lineEnd;
    }
  }
  const boundaryExpressions = [/\n[ \t]*\n/gu, /[.!?](?:["')\]]*)[ \t]+/gu, /\n/gu, /[ \t]+/gu];
  for (const expression of boundaryExpressions) {
    const candidate = lastBoundary(text, earliest, nominalEnd, expression);
    if (candidate > chunkStart && containingBlock(blocks, candidate) === undefined) {
      let exact = candidate;
      while (
        exact > chunkStart + overlap &&
        (!isUtf16Boundary(text, exact) || !isUtf16Boundary(text, exact - overlap))
      )
        exact -= 1;
      return exact;
    }
  }
  let safe = nominalEnd;
  while (
    safe > chunkStart + overlap &&
    (!isUtf16Boundary(text, safe) || !isUtf16Boundary(text, safe - overlap))
  )
    safe -= 1;
  return Math.max(chunkStart + 1, safe);
};

const rawRanges = (
  text: string,
  profile: ChunkProfile,
  blocks: readonly MarkdownBlock[],
): Array<[number, number]> => {
  if (text.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  const window = Math.floor(profile.targetCharacters * profile.snapWindow);
  let start = 0;
  while (start < text.length) {
    const nominalEnd = Math.min(text.length, start + profile.targetCharacters);
    const end = snapEnd(
      text,
      start,
      nominalEnd,
      window,
      profile.targetCharacters,
      profile.overlapCharacters,
      blocks,
    );
    ranges.push([start, end]);
    if (end === text.length) break;
    let next = Math.max(start + 1, end - profile.overlapCharacters);
    if (!isUtf16Boundary(text, next)) next -= 1;
    start = next;
  }
  const last = ranges.at(-1);
  const previous = ranges.at(-2);
  if (
    last !== undefined &&
    previous !== undefined &&
    last[1] - last[0] < profile.targetCharacters * 0.25
  ) {
    previous[1] = last[1];
    ranges.pop();
  }
  return ranges;
};

export const chunkCanonicalMarkdown = (
  text: string,
  profile: ChunkProfile,
): readonly ChunkCandidate[] => {
  assertProfile(profile);
  const locator = createLocatorMap(text);
  const headings = headingsIn(text);
  const blocks = markdownBlocks(text);
  return rawRanges(text, profile, blocks).map(([start, end], ordinal) => {
    const chunkText = text.slice(start, end);
    const headingPath = headingPathAt(headings, start);
    const headingContext =
      profile.headingPrefix && headingPath.length > 0 ? `${headingPath.join(' > ')}\n\n` : '';
    const continuedBlock = containingBlock(blocks, start);
    const structureKinds = [
      ...new Set(
        blocks.filter((block) => block.end > start && block.start < end).map(({ kind }) => kind),
      ),
    ];
    const structureKind =
      continuedBlock?.kind ??
      blocks.find((block) => block.start >= start && block.end <= end)?.kind ??
      null;
    const continuation =
      continuedBlock === undefined
        ? {}
        : {
            kind: continuedBlock.kind,
            continued: true,
            canonicalBlockStart: continuedBlock.start,
          };
    const repeatedHeader =
      continuedBlock?.kind === 'table' && continuedBlock.repeatedHeader !== undefined
        ? `Table continuation:\n${continuedBlock.repeatedHeader}\n`
        : continuedBlock?.kind === 'code'
          ? 'Code continuation:\n'
          : '';
    return {
      ordinal,
      text: chunkText,
      headingPath,
      embeddingText: `${headingContext}${repeatedHeader}${chunkText}`,
      structureKind,
      structureKinds,
      continuation,
      ...locator.range(start, end),
    };
  });
};
