import { describe, expect, it } from 'vitest';
import { normalizeMarkdown } from '../src/ingest/normalization.js';

describe('Markdown normalization', () => {
  it('removes a BOM and normalizes CRLF, lone CR, and NFD to LF/NFC', () => {
    const original = Buffer.from('\uFEFF# Cafe\u0301\r\n\rBody\r\n', 'utf8');
    const result = normalizeMarkdown(original);
    expect(result.markdown).toBe('# Café\n\nBody\n');
    expect(result).toMatchObject({
      encoding: 'utf-8',
      bomRemoved: true,
      lineEndingsChanged: true,
      unicodeChanged: true,
      offsetsMatchOriginal: false,
    });
  });

  it('records byte-identical canonical UTF-8 Markdown', () => {
    const original = Buffer.from('# Canonical\n\nBody 😀\n', 'utf8');
    expect(normalizeMarkdown(original).offsetsMatchOriginal).toBe(true);
  });

  it('rejects malformed UTF-8', () => {
    expect(() => normalizeMarkdown(Uint8Array.from([0xc3, 0x28]))).toThrow();
  });
});
