import { describe, expect, it } from 'vitest';
import { chunkCanonicalMarkdown, isUtf16Boundary, sliceUtf8 } from '../src/index.js';

const profile = {
  targetCharacters: 240,
  overlapCharacters: 40,
  snapWindow: 0.15,
  headingPrefix: true,
} as const;

describe('canonical Markdown chunking', () => {
  it('uses coherent boundaries, overlap, headings, and exact dual locators', () => {
    const paragraph =
      'A paragraph with an astral 😀 character and enough words to exercise boundaries. ';
    const text = `# Alpha\n\n${paragraph.repeat(4)}\n\n## Beta\n\n${paragraph.repeat(5)}`;
    const chunks = chunkCanonicalMarkdown(text, profile);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]?.headingPath).toEqual(['Alpha']);
    expect(chunks.at(-1)?.headingPath).toEqual(['Alpha', 'Beta']);
    for (const chunk of chunks) {
      expect(text.slice(chunk.characterStart, chunk.characterEnd)).toBe(chunk.text);
      expect(sliceUtf8(text, chunk.byteStart, chunk.byteEnd)).toBe(chunk.text);
      expect(chunk.embeddingText.endsWith(chunk.text)).toBe(true);
    }
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1];
      const current = chunks[index];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      expect((previous?.characterEnd ?? 0) - (current?.characterStart ?? 0)).toBe(40);
    }
  });

  it('merges a final runt and never cuts a surrogate pair', () => {
    const text = `${'x'.repeat(230)}😀${'y'.repeat(230)} tiny`;
    const chunks = chunkCanonicalMarkdown(text, profile);
    expect(chunks.at(-1)?.characterEnd).toBe(text.length);
    for (const chunk of chunks) {
      expect(isUtf16Boundary(text, chunk.characterStart)).toBe(true);
      expect(isUtf16Boundary(text, chunk.characterEnd)).toBe(true);
    }
    expect(chunks.some((chunk) => chunk.text.includes('😀'))).toBe(true);
  });

  it('keeps ordinary Markdown structures atomic and describes oversized continuations', () => {
    const tableRows = Array.from(
      { length: 30 },
      (_, index) => `| row ${String(index)} | ${'value '.repeat(8)} |\n`,
    ).join('');
    const text = [
      '# Structures\n\n',
      '- one list item with a continuation\n  that remains attached\n\n',
      '```ts\nconst exact = "line boundary";\n```\n\n',
      '<!-- noderag:image id=7 -->\nimage provenance body\n<!-- /noderag:image -->\n\n',
      '<!-- noderag:vision image-sha256="abc" -->\nvision body\n<!-- /noderag:vision -->\n\n',
      '| Key | Value |\n| --- | --- |\n',
      tableRows,
    ].join('');
    const chunks = chunkCanonicalMarkdown(text, profile);
    for (const chunk of chunks) {
      expect(text.slice(chunk.characterStart, chunk.characterEnd)).toBe(chunk.text);
      expect(sliceUtf8(text, chunk.byteStart, chunk.byteEnd)).toBe(chunk.text);
      expect(isUtf16Boundary(text, chunk.characterStart)).toBe(true);
      expect(isUtf16Boundary(text, chunk.characterEnd)).toBe(true);
    }
    expect(chunks.some(({ structureKinds }) => structureKinds.includes('list-item'))).toBe(true);
    expect(chunks.some(({ structureKinds }) => structureKinds.includes('code'))).toBe(true);
    expect(chunks.some(({ structureKinds }) => structureKinds.includes('image-provenance'))).toBe(
      true,
    );
    expect(chunks.map(({ embeddingText }) => embeddingText).join('\n')).not.toContain(
      '<!-- noderag:',
    );
    expect(chunks.map(({ embeddingText }) => embeddingText).join('\n')).toContain('vision body');
    const continuation = chunks.find(
      ({ structureKind, continuation: detail }) =>
        structureKind === 'table' && detail['continued'] === true,
    );
    expect(continuation?.embeddingText).toContain('Table continuation:');
    expect(continuation?.embeddingText).toContain('| Key | Value |');
  });
});
