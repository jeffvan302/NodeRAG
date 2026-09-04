import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { extractDocument } from '../src/extract/index.js';

const fixture = (...parts: string[]): string =>
  join(process.cwd(), 'fixtures', 'formats', ...parts);

describe('document extractors', () => {
  it('preserves Markdown structure while normalizing line endings and Unicode', async () => {
    const result = await extractDocument(
      Buffer.from('\uFEFF# Cafe\u0301\r\n\r\n- item\r\n', 'utf8'),
      'md',
    );
    expect(result.markdown).toBe('# Café\n\n- item\n');
    expect(result).toMatchObject({
      format: 'md',
      pageBasis: 'none',
      encoding: 'utf-8',
      encodingConfidence: 1,
      offsetsMatchOriginal: false,
    });
  });

  it('detects BOM-less UTF-16 and a supported legacy encoding', async () => {
    const utf16 = await extractDocument(Buffer.from('Plain text\n', 'utf16le'), 'txt');
    expect(utf16.markdown).toBe('Plain text\n');
    expect(utf16.encoding).toBe('utf-16le');
    expect(utf16.warnings).toContain('bomless-utf16-detected');

    const legacy = await extractDocument(iconv.encode('Café résumé', 'windows-1252'), 'txt');
    expect(legacy.markdown).toBe('Café résumé');
    expect(legacy.warnings).toContain('legacy-encoding-detected');
  });

  it('decodes the complete text fixture matrix and normalizes after decoding', async () => {
    const utf8 = await extractDocument(await readFile(fixture('txt', 'utf8.txt')), 'txt');
    const utf16 = await extractDocument(await readFile(fixture('txt', 'utf16-no-bom.txt')), 'txt');
    const shiftJis = await extractDocument(await readFile(fixture('txt', 'shift-jis.txt')), 'txt');
    expect(utf8).toMatchObject({ encoding: 'utf-8', offsetsMatchOriginal: true });
    expect(utf8.markdown).toContain('Pump 😀');
    expect(utf16).toMatchObject({ encoding: 'utf-16le', offsetsMatchOriginal: false });
    expect(shiftJis.markdown).toContain('設備保全');
    expect(shiftJis.encoding).toMatch(/shift|sjis/iu);
  });

  it('orders two-column PDF text and records exact pages', async () => {
    const result = await extractDocument(await readFile(fixture('pdf', 'two-column.pdf')), 'pdf');
    expect(result.pageBasis).toBe('exact');
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.pageNumber).toBe(1);
    expect(result.pages[0]?.confidence).toBeGreaterThan(0.4);
    expect(result.markdown.length).toBeGreaterThan(20);
  });

  it('marks scanned PDF pages for vision when vision is unavailable', async () => {
    const result = await extractDocument(await readFile(fixture('pdf', 'scanned.pdf')), 'pdf');
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({ extraction: 'vision', confidence: 0, body: '' });
    expect(result.warnings).toContain('pdf-page-vision-required');
  });

  it('folds text and conservatively joins PDF line-end hyphenation', async () => {
    const ligatures = await extractDocument(await readFile(fixture('pdf', 'ligatures.pdf')), 'pdf');
    const hyphenated = await extractDocument(
      await readFile(fixture('pdf', 'hyphenated.pdf')),
      'pdf',
    );
    expect(ligatures.markdown).toContain('office flower efficient waffle');
    expect(hyphenated.markdown).toContain('electromechanical');
    expect(hyphenated.markdown).not.toContain('electro-\nmechanical');
  });

  it('extracts DOCX structure and reports only page evidence present in the package', async () => {
    const word = await extractDocument(await readFile(fixture('docx', 'word-saved.docx')), 'docx');
    expect(word.pageBasis).toBe('rendered');
    expect(word.pages.length).toBeGreaterThanOrEqual(2);
    expect(word.markdown).toContain('#');

    const google = await extractDocument(
      await readFile(fixture('docx', 'gdocs-export-synthetic.docx')),
      'docx',
    );
    expect(google.markdown.length).toBeGreaterThan(20);
    expect(['none', 'explicit', 'rendered']).toContain(google.pageBasis);
  });

  it('extracts DOCX explicit breaks, tables, images, lists, emphasis, and footnotes', async () => {
    const explicit = await extractDocument(
      await readFile(fixture('docx', 'explicit-breaks.docx')),
      'docx',
    );
    expect(explicit.pageBasis).toBe('explicit');
    expect(explicit.pages).toHaveLength(2);

    const structured = await extractDocument(
      await readFile(fixture('docx', 'tables-images-footnotes.docx')),
      'docx',
    );
    expect(structured.markdown).toContain('| Asset | State |');
    expect(structured.markdown).toContain('1. Inspect pump');
    expect(structured.markdown).toContain('**Important** and *reviewed*[^1]');
    expect(structured.markdown).toContain('[^1]: Reviewed during the synthetic inspection.');
    expect(structured.pages[0]?.images).toHaveLength(1);
    expect(structured.warnings).toContain('docx-image-vision-pending');
  });

  it('streams XLSX worksheets into sheet-based Markdown pages', async () => {
    const result = await extractDocument(
      await readFile(fixture('xlsx', 'messy-workbook.xlsx')),
      'xlsx',
    );
    expect(result.pageBasis).toBe('sheet');
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.markdown).toContain('|');
    expect(result.metadata.reader).toBe('saxes-streaming');
  });

  it('handles XLSX formatting, missing caches, merges, wide records, and tall streams', async () => {
    const formatted = await extractDocument(
      await readFile(fixture('xlsx', 'dates-currency.xlsx')),
      'xlsx',
    );
    expect(formatted.markdown).toContain('2026-01-05');
    expect(formatted.markdown).toContain('$3,100.00');

    const formulas = await extractDocument(
      await readFile(fixture('xlsx', 'formulas-no-cache.xlsx')),
      'xlsx',
    );
    expect(formulas.warnings).toContain('formula-cache-missing:Formula!B2');
    expect(formulas.markdown).toContain('[Formula result unavailable]');

    const merged = await extractDocument(
      await readFile(fixture('xlsx', 'merged-cells.xlsx')),
      'xlsx',
    );
    expect(merged.markdown).toContain('| Region | Region | Count |');
    expect(merged.markdown).toContain('| North | North | 4 |');

    const wide = await extractDocument(await readFile(fixture('xlsx', 'wide-90-col.xlsx')), 'xlsx');
    expect(wide.markdown).toContain('### Record 1');
    expect(wide.markdown).toContain('- Field 90: 90');

    const tall = await extractDocument(
      await readFile(fixture('xlsx', 'tall-5000-row.xlsx')),
      'xlsx',
      { maximumWorkbookCells: 20_000 },
    );
    expect(tall.metadata.reader).toBe('saxes-streaming');
    expect(tall.metadata.visitedCells).toBe(15_003);
    expect(tall.markdown).toContain('Asset-5000');
  });

  it('enforces workbook cell and Office archive safety ceilings', async () => {
    const tall = await readFile(fixture('xlsx', 'tall-5000-row.xlsx'));
    await expect(extractDocument(tall, 'xlsx', { maximumWorkbookCells: 100 })).rejects.toThrow(
      'workbook-cell-limit-exceeded',
    );
    await expect(extractDocument(tall, 'xlsx', { maximumUncompressedBytes: 1024 })).rejects.toThrow(
      'office-archive-size-limit',
    );
  });

  it('assembles pages with exactly two newline separators and dual offsets', async () => {
    const result = await extractDocument(
      await readFile(fixture('docx', 'word-saved.docx')),
      'docx',
    );
    expect(result.markdown).not.toContain('\n\n\n');
    for (const page of result.pages) {
      expect(result.markdown.slice(page.characterStart, page.characterEnd)).toBe(page.body);
      expect(
        Buffer.from(result.markdown, 'utf8').subarray(page.byteStart, page.byteEnd).toString(),
      ).toBe(page.body);
    }
  });
});
