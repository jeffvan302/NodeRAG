import type { PdfEvidence } from './pdf-viewer.js';

const lexicalTokens = (value: string): readonly string[] =>
  value.normalize('NFC').match(/[\p{L}\p{N}_-]+/gu) ?? [];

const inflections = (token: string): readonly string[] => {
  if (token.length < 4) return [token];
  const variants = new Set([token, `${token}s`, `${token}es`]);
  const lower = token.toLocaleLowerCase();
  if (lower.endsWith('y')) variants.add(`${token.slice(0, -1)}ies`);
  if (lower.endsWith('ies')) variants.add(`${token.slice(0, -3)}y`);
  if (lower.endsWith('es')) variants.add(token.slice(0, -2));
  if (lower.endsWith('s')) variants.add(token.slice(0, -1));
  return [...variants];
};

export const immediateExactPdfEvidence = (query: string, limit = 24): readonly PdfEvidence[] => {
  const evidence = new Map<string, PdfEvidence>();
  for (const token of lexicalTokens(query)) {
    for (const variant of inflections(token)) {
      const key = variant.toLocaleLowerCase();
      if (!evidence.has(key)) evidence.set(key, { kind: 'exact', text: variant, confidence: 1 });
      if (evidence.size >= limit) return [...evidence.values()];
    }
  }
  return [...evidence.values()];
};

export const mergePdfEvidence = (
  first: readonly PdfEvidence[],
  second: readonly PdfEvidence[],
): readonly PdfEvidence[] => {
  const merged = new Map<string, PdfEvidence>();
  for (const item of [...first, ...second]) {
    const key = `${item.kind}:${item.text.normalize('NFC').toLocaleLowerCase()}`;
    const current = merged.get(key);
    if (current === undefined || current.confidence < item.confidence) merged.set(key, item);
  }
  return [...merged.values()];
};
