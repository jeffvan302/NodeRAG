import { sliceUtf8 } from '@noderag/shared';
import { describe, expect, it } from 'vitest';
import { assembleExtractedDocument } from '../src/extract/assembly.js';
import type { ExtractedDocument } from '../src/extract/contract.js';

const documentWithBody = (body: string): ExtractedDocument => ({
  format: 'pdf',
  pages: [
    {
      ordinal: 0,
      pageNumber: 1,
      label: '1',
      body,
      extraction: 'text',
      confidence: 0.9,
      warnings: [],
      images: [],
      metadata: {},
    },
  ],
  pageBasis: 'exact',
  encoding: null,
  encodingConfidence: null,
  offsetsMatchOriginal: false,
  warnings: [],
  metadata: {
    parserRevision: 'pdfjs-dist@test',
    layoutPolicyRevision: 'page-shadow.test',
    confidencePolicyRevision: 'page-confidence.test',
  },
});

describe('extraction block assembly', () => {
  it('creates a page-sized compatibility block without changing Markdown or dual-unit locators', () => {
    const body = 'Revenue 😀\r\n\r\nTax income';
    const assembled = assembleExtractedDocument(documentWithBody(body));
    expect(assembled.markdown).toBe('Revenue 😀\n\nTax income');
    expect(assembled.pages[0]?.blocks).toHaveLength(1);
    const block = assembled.pages[0]?.blocks[0];
    expect(block).toMatchObject({
      ordinal: 0,
      kind: 'unknown',
      source: 'text',
      markdown: assembled.markdown,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      revisions: {
        parser: 'pdfjs-dist@test',
        layout: 'page-shadow.test',
        confidence: 'page-confidence.test',
      },
    });
    expect(assembled.markdown.slice(block?.characterStart, block?.characterEnd)).toBe(
      assembled.markdown,
    );
    expect(sliceUtf8(assembled.markdown, block?.byteStart ?? 0, block?.byteEnd ?? 0)).toBe(
      assembled.markdown,
    );
  });

  it('orders explicit blocks and assigns exact canonical ranges', () => {
    const input = documentWithBody('# Revenue\n\nTax income');
    const page = input.pages[0];
    if (page === undefined) throw new Error('test page missing');
    const assembled = assembleExtractedDocument({
      ...input,
      pages: [
        {
          ...page,
          blocks: [
            {
              ordinal: 1,
              kind: 'paragraph',
              source: 'text',
              text: 'Tax income',
              markdown: 'Tax income',
              bounds: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
              readingOrder: 1,
              confidence: { text: 1, readingOrder: 1, structure: 0.9, combined: 0.97 },
              warnings: [],
              revisions: { parser: 'test', layout: 'test', confidence: 'test' },
            },
            {
              ordinal: 0,
              kind: 'heading',
              source: 'text',
              text: 'Revenue',
              markdown: '# Revenue',
              bounds: { x: 0.1, y: 0.05, width: 0.8, height: 0.1 },
              readingOrder: 0,
              confidence: { text: 1, readingOrder: 1, structure: 0.95, combined: 0.98 },
              warnings: [],
              revisions: { parser: 'test', layout: 'test', confidence: 'test' },
            },
          ],
        },
      ],
    });
    expect(assembled.pages[0]?.blocks.map(({ kind }) => kind)).toEqual(['heading', 'paragraph']);
    for (const block of assembled.pages[0]?.blocks ?? []) {
      expect(assembled.markdown.slice(block.characterStart, block.characterEnd)).toBe(
        block.markdown,
      );
      expect(sliceUtf8(assembled.markdown, block.byteStart, block.byteEnd)).toBe(block.markdown);
    }
  });

  it('rejects shadow blocks that would change the page body', () => {
    const input = documentWithBody('Original body');
    const page = input.pages[0];
    if (page === undefined) throw new Error('test page missing');
    expect(() =>
      assembleExtractedDocument({
        ...input,
        pages: [
          {
            ...page,
            blocks: [
              {
                ordinal: 0,
                kind: 'paragraph',
                source: 'text',
                text: 'Changed body',
                markdown: 'Changed body',
                bounds: null,
                readingOrder: 0,
                confidence: { text: 1, readingOrder: 1, structure: 1, combined: 1 },
                warnings: [],
                revisions: { parser: 'test', layout: 'test', confidence: 'test' },
              },
            ],
          },
        ],
      }),
    ).toThrow('extraction-block-markdown-mismatch');
  });

  it('clips explicit block bounds before they are stored', () => {
    const input = documentWithBody('Clipped block');
    const page = input.pages[0];
    if (page === undefined) throw new Error('test page missing');
    const assembled = assembleExtractedDocument({
      ...input,
      pages: [
        {
          ...page,
          blocks: [
            {
              ordinal: 0,
              kind: 'paragraph',
              source: 'text',
              text: 'Clipped block',
              markdown: 'Clipped block',
              bounds: { x: 0.95, y: -0.1, width: 0.3, height: 1.4 },
              readingOrder: 0,
              confidence: { text: 1, readingOrder: 1, structure: 1, combined: 1 },
              warnings: [],
              revisions: { parser: 'test', layout: 'test', confidence: 'test' },
            },
          ],
        },
      ],
    });

    const bounds = assembled.pages[0]?.blocks[0]?.bounds;
    expect(bounds).toMatchObject({ x: 0.95, y: 0, height: 1 });
    expect(bounds?.width).toBeCloseTo(0.05);
  });
});
