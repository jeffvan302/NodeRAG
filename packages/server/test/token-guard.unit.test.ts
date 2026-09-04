import { describe, expect, it } from 'vitest';
import { chunkCanonicalMarkdown, type Embedder } from '@noderag/shared';
import { enforceTokenGuard } from '../src/ingest/token-guard.js';

const characterEmbedder: Embedder = {
  async countTokens(texts) {
    return texts.map((text) => text.length);
  },
  async embed() {
    throw new Error('not used');
  },
};

describe('chunk token guard', () => {
  it('splits a candidate until every embedding input is under the ceiling', async () => {
    const canonical = `# Heading\n\n${'word '.repeat(100)}`;
    const candidates = chunkCanonicalMarkdown(canonical, {
      targetCharacters: 600,
      overlapCharacters: 0,
      snapWindow: 0,
      headingPrefix: true,
    });
    const guarded = await enforceTokenGuard(canonical, candidates, 160, characterEmbedder);
    expect(guarded.length).toBeGreaterThan(2);
    expect(guarded.every((chunk) => chunk.tokenCount <= 160)).toBe(true);
    expect(guarded.map((chunk) => chunk.text).join('')).toBe(canonical);
  });
});
