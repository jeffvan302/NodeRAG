import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDocument } from '../src/extract/index.js';
import {
  classifyPdfDocumentLayout,
  type PdfLayoutPageInput,
  type PdfLayoutRun,
} from '../src/extract/pdf-layout.js';

const fixture = (name: string): string => join(process.cwd(), 'fixtures', 'formats', 'pdf', name);

const extractFixture = async (name: string) =>
  extractDocument(await readFile(fixture(name)), 'pdf');

const kinds = (document: Awaited<ReturnType<typeof extractFixture>>): readonly string[] =>
  document.pages.flatMap((page) => page.blocks.map(({ kind }) => kind));

describe('deterministic PDF layout reconstruction', () => {
  it('reconstructs title and heading levels around separate prose blocks', async () => {
    const document = await extractFixture('layout-headings.pdf');
    expect(kinds(document)).toEqual(['title', 'heading', 'paragraph', 'heading', 'paragraph']);
    expect(document.markdown).toBe(
      '# Annual Financial Report\n\n## Revenue sources\n\nRevenue increased during the reporting period.\n\n### Tax revenue\n\nPersonal and corporate tax remain the primary sources.',
    );
  });

  it('preserves legal heading hierarchy and nested list indentation', async () => {
    const document = await extractFixture('legal-lists.pdf');
    expect(kinds(document)).toEqual([
      'heading',
      'heading',
      'paragraph',
      'list-item',
      'list-item',
      'list-item',
      'list-item',
    ]);
    expect(document.markdown).toContain('# 1. Revenue');
    expect(document.markdown).toContain('## 1.1 Tax revenue');
    expect(document.markdown).toContain('  - Assessed monthly');
    expect(document.markdown).toContain('  - Reconciled annually');
  });

  it('orders three columns top-to-bottom and left-to-right by region', async () => {
    const document = await extractFixture('three-column.pdf');
    const positions = [
      'First column A',
      'First column B',
      'Second column A',
      'Second column B',
      'Third column A',
      'Third column B',
    ].map((value) => document.markdown.indexOf(value));
    expect(positions.every((value) => value >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(kinds(document)).toEqual(['heading', 'paragraph', 'paragraph', 'paragraph']);
  });

  it('emits a GFM table only for stable rows and columns', async () => {
    const document = await extractFixture('simple-table.pdf');
    expect(kinds(document)).toEqual(['heading', 'table']);
    expect(document.markdown).toContain('| Source | 2025 | 2026 |');
    expect(document.markdown).toContain('| --- | ---: | ---: |');
    expect(document.markdown).toContain('| Tax revenue | 40.2 | 42.8 |');
  });

  it('falls back honestly for a merged or spanning table', async () => {
    const document = await extractFixture('complex-table.pdf');
    expect(kinds(document)).toContain('unknown');
    expect(document.warnings).toContain('complex-table-fallback');
    expect(document.markdown).toContain('Complex table — layout requires review');
    expect(document.markdown).toContain('Forecast years');
    expect(document.markdown).toContain('Notes span all forecast columns');
    const uncertain = document.pages[0]?.blocks.find(({ kind }) => kind === 'unknown');
    expect(uncertain?.routing).toEqual({
      disposition: 'regional-vision',
      reasons: expect.arrayContaining(['complex-table-structure', 'confidence-review-band']),
    });
    expect(uncertain?.confidence.components).toMatchObject({
      textIntegrity: expect.any(Number),
      readingOrder: expect.any(Number),
      classifierMargin: expect.any(Number),
      tableAlignment: expect.any(Number),
      documentConsistency: expect.any(Number),
    });
  });

  it('suppresses only repeated page furniture while retaining provenance blocks', async () => {
    const document = await extractFixture('repeated-furniture.pdf');
    expect(kinds(document)).toContain('header');
    expect(kinds(document)).toContain('footer');
    expect(document.markdown).not.toContain('CONFIDENTIAL REVENUE REPORT');
    expect(document.markdown).not.toContain('Page 1');
    expect(document.markdown).not.toContain('Page 2');
    expect(document.markdown).toContain('First reporting section');
    expect(document.markdown).toContain('Second reporting section');
  });

  it('keeps diagram labels and associates a caption without inventing semantics', async () => {
    const document = await extractFixture('diagram-caption.pdf');
    expect(kinds(document)).toEqual(['heading', 'unknown', 'caption']);
    expect(document.markdown).toContain('Collect → Report');
    expect(document.markdown).toContain('_Figure 1. Revenue moves from collection to reporting._');
    expect(document.pages[0]?.blocks.find(({ kind }) => kind === 'unknown')?.warnings).toContain(
      'diagram-native-labels-only',
    );
  });

  it('does not classify vertically aligned prose as a table', async () => {
    const document = await extractFixture('aligned-prose-negative.pdf');
    expect(kinds(document)).not.toContain('table');
    expect(document.markdown).toContain('Revenue is collected from several sources.');
    expect(document.markdown).toContain('Revenue is reported in the financial statements.');
    expect(
      document.pages[0]?.blocks.every(({ routing }) => routing?.disposition === 'native-safe'),
    ).toBe(true);
  });

  it('routes unreadable pages to full-page vision without inventing a block', async () => {
    const document = await extractFixture('scanned.pdf');
    expect(document.pages[0]?.blocks).toEqual([]);
    expect(document.pages[0]?.metadata['pageRouting']).toBe('full-page-vision');
    expect(document.pages[0]?.warnings).toContain('pdf-page-vision-required');
  });

  it('is deterministic and invariant to proportional coordinate scaling', () => {
    const run = (text: string, x: number, y: number, fontSize = 12): PdfLayoutRun => ({
      text,
      x,
      y,
      width: text.length * fontSize * 0.5,
      height: fontSize,
      fontSize,
      fontName: 'Fixture',
      fontFamily: 'Fixture Sans',
      bold: fontSize > 12,
      italic: false,
      direction: 'ltr',
      transform: [fontSize, 0, 0, fontSize, x, y],
      hasEol: true,
      renderMode: 0,
    });
    const page: PdfLayoutPageInput = {
      ordinal: 0,
      pageNumber: 1,
      width: 600,
      height: 800,
      runs: [
        run('Scaled layout', 60, 740, 18),
        run('Left one', 60, 690),
        run('Left two', 60, 670),
        run('Right one', 340, 690),
        run('Right two', 340, 670),
      ],
    };
    const scale = 1.75;
    const scaled: PdfLayoutPageInput = {
      ...page,
      width: page.width * scale,
      height: page.height * scale,
      runs: page.runs.map((item) => ({
        ...item,
        x: item.x * scale,
        y: item.y * scale,
        width: item.width * scale,
        height: item.height * scale,
        fontSize: item.fontSize * scale,
        transform: item.transform.map((value) => value * scale),
      })),
    };
    const first = classifyPdfDocumentLayout([page])[0];
    const second = classifyPdfDocumentLayout([page])[0];
    const proportional = classifyPdfDocumentLayout([scaled])[0];
    expect(second).toEqual(first);
    expect(proportional?.body).toBe(first?.body);
    expect(proportional?.blocks.map(({ kind }) => kind)).toEqual(
      first?.blocks.map(({ kind }) => kind),
    );
  });

  it('clips extracted block bounds to the page rectangle', () => {
    const page: PdfLayoutPageInput = {
      ordinal: 0,
      pageNumber: 1,
      width: 600,
      height: 800,
      runs: [
        {
          text: 'Text whose PDF coordinates extend beyond the page edge.',
          x: 570,
          y: -4,
          width: 180,
          height: 24,
          fontSize: 12,
          fontName: 'Fixture',
          fontFamily: 'Fixture Sans',
          bold: false,
          italic: false,
          direction: 'ltr',
          transform: [12, 0, 0, 12, 570, -4],
          hasEol: true,
          renderMode: 0,
        },
      ],
    };

    const block = classifyPdfDocumentLayout([page])[0]?.blocks[0];
    expect(block?.bounds).not.toBeNull();
    expect((block?.bounds?.x ?? 0) + (block?.bounds?.width ?? 0)).toBeLessThanOrEqual(1);
    expect((block?.bounds?.y ?? 0) + (block?.bounds?.height ?? 0)).toBeLessThanOrEqual(1);
  });
});
