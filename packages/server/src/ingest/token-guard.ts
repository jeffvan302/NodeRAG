import {
  createLocatorMap,
  isUtf16Boundary,
  type ChunkCandidate,
  type Embedder,
} from '@noderag/shared';

const candidateFromRange = (
  canonical: string,
  original: ChunkCandidate,
  start: number,
  end: number,
): ChunkCandidate => {
  const text = canonical.slice(start, end);
  const prefix = original.embeddingText.slice(
    0,
    original.embeddingText.length - original.text.length,
  );
  return {
    ordinal: original.ordinal,
    text,
    headingPath: original.headingPath,
    embeddingText: `${prefix}${text}`,
    structureKind: original.structureKind,
    structureKinds: original.structureKinds,
    continuation: {
      ...original.continuation,
      tokenGuardSplit: true,
      originalCharacterStart: original.characterStart,
      originalCharacterEnd: original.characterEnd,
    },
    ...createLocatorMap(canonical).range(start, end),
  };
};

const safeSplit = (
  canonical: string,
  start: number,
  end: number,
  tokenCount: number,
  maximumTokens: number,
): number => {
  const length = end - start;
  const estimated = start + Math.max(1, Math.floor((length * maximumTokens * 0.9) / tokenCount));
  const lower = Math.max(start + 1, estimated - Math.floor(length * 0.15));
  for (let offset = Math.min(end - 1, estimated); offset >= lower; offset -= 1) {
    if (/\s/u.test(canonical[offset - 1] ?? '') && isUtf16Boundary(canonical, offset))
      return offset;
  }
  let offset = Math.min(end - 1, estimated);
  if (!isUtf16Boundary(canonical, offset)) offset -= 1;
  if (offset <= start) throw new Error('TOKEN_LIMIT_UNSPLITTABLE');
  return offset;
};

export interface GuardedChunk extends ChunkCandidate {
  readonly tokenCount: number;
}

export const enforceTokenGuard = async (
  canonical: string,
  candidates: readonly ChunkCandidate[],
  maximumTokens: number,
  embedder: Embedder,
): Promise<readonly GuardedChunk[]> => {
  const pending = [...candidates];
  const accepted: GuardedChunk[] = [];
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === undefined) break;
    const count = (await embedder.countTokens([candidate.embeddingText], 4))[0];
    if (count === undefined) throw new Error('Embedder omitted a token count.');
    if (count <= maximumTokens) {
      accepted.push({ ...candidate, tokenCount: count });
      continue;
    }
    const split = safeSplit(
      canonical,
      candidate.characterStart,
      candidate.characterEnd,
      count,
      maximumTokens,
    );
    pending.unshift(candidateFromRange(canonical, candidate, split, candidate.characterEnd));
    pending.unshift(candidateFromRange(canonical, candidate, candidate.characterStart, split));
  }
  return accepted.map((candidate, ordinal) => ({ ...candidate, ordinal }));
};
