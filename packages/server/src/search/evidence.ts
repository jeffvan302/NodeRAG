import { vectorMatchConfidence, type RetrievalConfidenceCalibration } from './confidence.js';

export type SearchEvidenceKind = 'exact' | 'semantic';

export interface SearchEvidence {
  readonly kind: SearchEvidenceKind;
  readonly text: string;
  readonly confidence: number;
}

const lexicalMatches = (value: string): readonly RegExpMatchArray[] => [
  ...value.matchAll(/[\p{L}\p{N}_-]+/gu),
];

const inflections = (token: string): ReadonlySet<string> => {
  const variants = new Set([token]);
  if (token.length >= 4) {
    variants.add(`${token}s`);
    variants.add(`${token}es`);
    if (token.endsWith('y')) variants.add(`${token.slice(0, -1)}ies`);
    if (token.endsWith('ies')) variants.add(`${token.slice(0, -3)}y`);
    if (token.endsWith('es')) variants.add(token.slice(0, -2));
    if (token.endsWith('s')) variants.add(token.slice(0, -1));
  }
  return variants;
};

export const exactSearchEvidence = (
  query: string,
  passage: string,
  limit = 16,
): readonly SearchEvidence[] => {
  const queryTokens = new Set(
    lexicalMatches(query.normalize('NFC').toLocaleLowerCase()).flatMap((match) => [
      ...inflections(match[0]),
    ]),
  );
  const found = new Map<string, SearchEvidence>();
  for (const match of lexicalMatches(passage.normalize('NFC'))) {
    const text = match[0];
    if (!queryTokens.has(text.toLocaleLowerCase())) continue;
    const key = text.toLocaleLowerCase();
    if (!found.has(key)) found.set(key, { kind: 'exact', text, confidence: 1 });
    if (found.size >= limit) break;
  }
  return [...found.values()];
};

const splitLongSpan = (span: string, maximumCharacters = 420): readonly string[] => {
  const output: string[] = [];
  let remaining = span.trim();
  while (remaining.length > maximumCharacters) {
    const preferred = remaining.lastIndexOf(' ', maximumCharacters);
    const end = preferred >= Math.floor(maximumCharacters * 0.6) ? preferred : maximumCharacters;
    output.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining.length > 0) output.push(remaining);
  return output;
};

export const semanticSentenceCandidates = (passage: string, limit = 12): readonly string[] => {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const match of passage.matchAll(/[^.!?…\n]+(?:[.!?…]+|$)/gu)) {
    for (const candidate of splitLongSpan(match[0])) {
      const normalized = candidate.normalize('NFC').replace(/\s+/gu, ' ').trim();
      const key = normalized.toLocaleLowerCase();
      if (normalized.length < 20 || seen.has(key)) continue;
      seen.add(key);
      output.push(normalized);
      if (output.length >= limit) return output;
    }
  }
  return output;
};

export const cosineSimilarity = (left: readonly number[], right: readonly number[]): number => {
  if (left.length === 0 || left.length !== right.length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue))
      return Number.NEGATIVE_INFINITY;
    dot += leftValue * rightValue;
    leftSquared += leftValue * leftValue;
    rightSquared += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftSquared) * Math.sqrt(rightSquared);
  return denominator === 0 ? Number.NEGATIVE_INFINITY : dot / denominator;
};

export const semanticSearchEvidence = (
  candidates: readonly string[],
  queryVector: readonly number[],
  candidateVectors: readonly (readonly number[])[],
  calibration: RetrievalConfidenceCalibration,
  limit = 2,
): readonly SearchEvidence[] =>
  candidates
    .map((text, index) => ({
      text,
      similarity: cosineSimilarity(queryVector, candidateVectors[index] ?? []),
    }))
    .filter(({ similarity }) => similarity >= calibration.minimumVectorSimilarity)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, limit)
    .map(({ text, similarity }) => ({
      kind: 'semantic',
      text,
      confidence: vectorMatchConfidence(similarity, calibration),
    }));
