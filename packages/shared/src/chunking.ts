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
}

interface Heading {
  readonly offset: number;
  readonly level: number;
  readonly text: string;
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

const snapEnd = (text: string, chunkStart: number, nominalEnd: number, window: number): number => {
  if (nominalEnd >= text.length) return text.length;
  const earliest = Math.max(chunkStart + 1, nominalEnd - window);
  const boundaryExpressions = [/\n[ \t]*\n/gu, /[.!?](?:["')\]]*)[ \t]+/gu, /\n/gu, /[ \t]+/gu];
  for (const expression of boundaryExpressions) {
    const candidate = lastBoundary(text, earliest, nominalEnd, expression);
    if (candidate > chunkStart) return candidate;
  }
  let safe = nominalEnd;
  if (!isUtf16Boundary(text, safe)) safe -= 1;
  return Math.max(chunkStart + 1, safe);
};

const rawRanges = (text: string, profile: ChunkProfile): Array<[number, number]> => {
  if (text.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  const window = Math.floor(profile.targetCharacters * profile.snapWindow);
  let start = 0;
  while (start < text.length) {
    const nominalEnd = Math.min(text.length, start + profile.targetCharacters);
    const end = snapEnd(text, start, nominalEnd, window);
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
  return rawRanges(text, profile).map(([start, end], ordinal) => {
    const chunkText = text.slice(start, end);
    const headingPath = headingPathAt(headings, start);
    const prefix =
      profile.headingPrefix && headingPath.length > 0 ? `${headingPath.join(' > ')}\n\n` : '';
    return {
      ordinal,
      text: chunkText,
      headingPath,
      embeddingText: `${prefix}${chunkText}`,
      ...locator.range(start, end),
    };
  });
};
