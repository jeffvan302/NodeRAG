export interface RetrievalConfidenceCalibration {
  readonly minimumVectorSimilarity: number;
  readonly highConfidenceVectorSimilarity: number;
}

export const qwenQ8RetrievalCalibration: RetrievalConfidenceCalibration = {
  minimumVectorSimilarity: 0.3,
  highConfidenceVectorSimilarity: 0.7,
};

export const noCutoffRetrievalCalibration: RetrievalConfidenceCalibration = {
  minimumVectorSimilarity: -1,
  highConfidenceVectorSimilarity: 1,
};

const bounded = (value: number): number => Math.max(0, Math.min(0.99, value));
const rounded = (value: number): number => Math.round(bounded(value) * 1000) / 1000;

export const assertRetrievalCalibration = (
  calibration: RetrievalConfidenceCalibration,
): RetrievalConfidenceCalibration => {
  const { minimumVectorSimilarity, highConfidenceVectorSimilarity } = calibration;
  if (
    !Number.isFinite(minimumVectorSimilarity) ||
    minimumVectorSimilarity < -1 ||
    minimumVectorSimilarity > 1 ||
    !Number.isFinite(highConfidenceVectorSimilarity) ||
    highConfidenceVectorSimilarity <= minimumVectorSimilarity ||
    highConfidenceVectorSimilarity > 1
  ) {
    throw new Error('invalid-retrieval-confidence-calibration');
  }
  return calibration;
};

/**
 * Maps a model-specific cosine range onto a conservative match-confidence range.
 * The minimum accepted similarity starts at 50% confidence. The measured
 * high-confidence anchor approaches, but never claims, 100%.
 */
export const vectorMatchConfidence = (
  similarity: number,
  calibration: RetrievalConfidenceCalibration,
): number => {
  assertRetrievalCalibration(calibration);
  if (!Number.isFinite(similarity) || similarity < calibration.minimumVectorSimilarity) return 0;
  const span = calibration.highConfidenceVectorSimilarity - calibration.minimumVectorSimilarity;
  const position = Math.max(
    0,
    Math.min(1, (similarity - calibration.minimumVectorSimilarity) / span),
  );
  const smooth = position * position * (3 - 2 * position);
  return rounded(0.5 + smooth * 0.49);
};

const lexicalTokens = (value: string): readonly string[] =>
  value
    .normalize('NFC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu) ?? [];

const passageHasToken = (passageTokens: ReadonlySet<string>, queryToken: string): boolean => {
  if (passageTokens.has(queryToken)) return true;
  if (queryToken.length < 4) return false;
  if (passageTokens.has(`${queryToken}s`) || passageTokens.has(`${queryToken}es`)) return true;
  return queryToken.endsWith('y') && passageTokens.has(`${queryToken.slice(0, -1)}ies`);
};

export const keywordMatchConfidence = (
  query: string,
  passage: string,
  keywordRank: number,
): number => {
  const queryTokens = [...new Set(lexicalTokens(query))];
  const passageTokens = new Set(lexicalTokens(passage));
  const coverage =
    queryTokens.length === 0
      ? 0
      : queryTokens.filter((token) => passageHasToken(passageTokens, token)).length /
        queryTokens.length;
  const rankStrength =
    Number.isFinite(keywordRank) && keywordRank > 0 ? keywordRank / (keywordRank + 0.1) : 0;
  const exactPhrase = passage
    .normalize('NFC')
    .toLocaleLowerCase()
    .includes(query.normalize('NFC').toLocaleLowerCase());
  return rounded(0.35 + coverage * 0.35 + rankStrength * 0.24 + (exactPhrase ? 0.05 : 0));
};

export const passageLexicalEvidenceConfidence = (
  query: string,
  passage: string,
): number | undefined => {
  const confidence = keywordMatchConfidence(query, passage, 0);
  return confidence > 0.35 ? confidence : undefined;
};

export const combinedMatchConfidence = (
  vectorConfidence: number | undefined,
  keywordConfidence: number | undefined,
): number => {
  if (vectorConfidence === undefined) return rounded(keywordConfidence ?? 0);
  if (keywordConfidence === undefined) return rounded(vectorConfidence);
  const strongest = Math.max(vectorConfidence, keywordConfidence);
  return rounded(strongest + (1 - strongest) * 0.25);
};
