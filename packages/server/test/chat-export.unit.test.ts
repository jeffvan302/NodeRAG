import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { extractDocument } from '../src/extract/index.js';
import { parseChatMarkdown } from '../src/chat/export-document.js';
import { classifyChatExportStorageFailure } from '../src/chat/exports.js';
import type { ChatExportError } from '../src/chat/exports.js';
import {
  generateChatExport,
  validateSafeDocx,
  validateSafePdf,
} from '../src/chat/export-generator.js';

const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

const fixture = `---
title: Revenue Research
author: NodeRag Test
---

# Revenue Research

Tax **revenue** increased with *stable collections* and [public evidence](https://example.com/report).

> A quoted source passage with citation [R1].

1. Personal income tax
2. Corporate tax

| Source | 2025 | 2026 |
| --- | ---: | ---: |
| Tax revenue | 40.2 | 42.8 |

\`\`\`mermaid
flowchart TD
  A[Revenue] --> B[Tax]
  B --> C[Public services]
\`\`\`

$$ revenue = tax + fees $$

![Remote chart](https://private.invalid/chart.png)

<!-- pagebreak -->

## Appendix

\`\`\`ts
const safe = true;
\`\`\`
`;

const provenance = {
  artifactId: '11111111-1111-4111-8111-111111111111',
  revision: 3,
  sourceSha256: 'a'.repeat(64),
};

describe('C09 normalized document and deterministic safe export', () => {
  it('normalizes supported Markdown and records visible degradations', () => {
    const parsed = parseChatMarkdown(fixture, 'fallback.md');
    expect(parsed.document.title).toBe('Revenue Research');
    expect(parsed.document.metadata).toMatchObject({ title: 'Revenue Research' });
    expect(parsed.document.blocks.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        'heading',
        'paragraph',
        'blockquote',
        'list',
        'table',
        'diagram',
        'equation',
        'page_break',
        'code',
      ]),
    );
    expect(parsed.document.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('external image retrieval is disabled'),
        expect.stringContaining('selectable source text'),
      ]),
    );
    expect(parsed.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(parseChatMarkdown(fixture, 'fallback.md').sha256).toBe(parsed.sha256);
  });

  it('generates a canonical macro-free DOCX that re-ingests with searchable text', async () => {
    const parsed = parseChatMarkdown(fixture, 'fallback.md');
    const first = await generateChatExport(parsed.document, 'docx', provenance);
    const second = await generateChatExport(parsed.document, 'docx', provenance);
    await validateSafeDocx(first.bytes);
    expect(first.mimeType).toContain('officedocument');
    if (sha256(first.bytes) !== sha256(second.bytes)) {
      const [firstZip, secondZip] = await Promise.all([
        JSZip.loadAsync(first.bytes),
        JSZip.loadAsync(second.bytes),
      ]);
      const changed: string[] = [];
      for (const name of Object.keys(firstZip.files)) {
        const left = await firstZip.file(name)?.async('nodebuffer');
        const right = await secondZip.file(name)?.async('nodebuffer');
        if (left !== undefined && right !== undefined && sha256(left) !== sha256(right))
          changed.push(name);
      }
      expect(changed).toEqual([]);
    }
    expect(sha256(first.bytes)).toBe(sha256(second.bytes));
    const zip = await JSZip.loadAsync(first.bytes);
    expect(Object.keys(zip.files).join('\n')).not.toMatch(/vba|activeX|externalLinks/iu);
    expect(await zip.file('word/document.xml')?.async('string')).toContain('Revenue Research');
    const extracted = await extractDocument(first.bytes, 'docx');
    expect(extracted.markdown).toContain('Tax revenue');
    expect(extracted.markdown).toContain('Public services');
  });

  it('generates a canonical passive PDF with embedded fonts and searchable text', async () => {
    const parsed = parseChatMarkdown(fixture, 'fallback.md');
    const first = await generateChatExport(parsed.document, 'pdf', provenance);
    const second = await generateChatExport(parsed.document, 'pdf', provenance);
    validateSafePdf(first.bytes);
    expect(first.mimeType).toBe('application/pdf');
    expect(sha256(first.bytes)).toBe(sha256(second.bytes));
    expect(first.bytes.toString('latin1')).not.toMatch(/\/JavaScript|\/Launch|\/EmbeddedFile/u);
    const extracted = await extractDocument(first.bytes, 'pdf');
    expect(extracted.markdown).toContain('Revenue Research');
    expect(extracted.markdown).toContain('Tax revenue');
  });

  it('rejects malformed or active output containers', async () => {
    await expect(validateSafeDocx(Buffer.from('not a zip'))).rejects.toMatchObject({
      code: 'chat_export_docx_invalid',
    });
    expect(() => validateSafePdf(Buffer.from('%PDF-1.7\n/JavaScript\n%%EOF'))).toThrowError(
      expect.objectContaining({ code: 'chat_export_pdf_active_content' }),
    );
  });

  it('preserves supported Unicode, visibly degrades unsupported glyphs, and bounds source memory', async () => {
    const international = parseChatMarkdown(
      '# International\n\nΕλληνικά · Русский · भारत · Tiếng Việt · unsupported 😀',
      'international.md',
    );
    const first = await generateChatExport(international.document, 'pdf', provenance);
    const second = await generateChatExport(international.document, 'pdf', provenance);
    expect(sha256(first.bytes)).toBe(sha256(second.bytes));
    expect(first.warnings).toEqual(expect.arrayContaining([expect.stringContaining('glyph')]));
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: Uint8Array.from(first.bytes), verbosity: 0 });
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent({ disableNormalization: true });
    const rawText = content.items
      .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
      .map(({ str }) => str)
      .join('');
    await task.destroy();
    expect(rawText).toContain('Ελληνικά');
    expect(rawText).toContain('Русский');
    expect(rawText).toContain('भारत');
    expect(rawText).toContain('Tiếng Việt');
    const extracted = await extractDocument(first.bytes, 'pdf');
    expect(extracted.markdown).toContain('Ελληνικά');
    expect(extracted.markdown).toContain('Русский');
    expect(extracted.markdown).toContain('भारत');
    expect(extracted.markdown).toContain('Tiếng Việt');
    expect(() => parseChatMarkdown('x'.repeat(10_485_761), 'too-large.md')).toThrowError(
      expect.objectContaining({ code: 'chat_export_source_too_large' }),
    );
    await expect(
      generateChatExport(international.document, 'pdf', provenance, 16),
    ).rejects.toMatchObject({ code: 'chat_export_output_too_large' });
  });

  it('classifies disk-full faults without exposing filesystem details', () => {
    expect(() =>
      classifyChatExportStorageFailure(
        Object.assign(new Error('/private/path is full'), { code: 'ENOSPC' }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ChatExportError>>({
        code: 'chat_export_disk_full',
        status: 507,
      }),
    );
  });

  it('exports a long structured document and visibly degrades a wide table', async () => {
    const header = `| ${Array.from({ length: 10 }, (_, index) => `Column ${String(index + 1)}`).join(' | ')} |`;
    const separator = `| ${Array.from({ length: 10 }, () => '---').join(' | ')} |`;
    const row = `| ${Array.from({ length: 10 }, (_, index) => `Value ${String(index + 1)}`).join(' | ')} |`;
    const sections = Array.from(
      { length: 120 },
      (_, index) =>
        `## Record ${String(index + 1)}\n\nRevenue evidence ${String(index + 1)} remains selectable and searchable.`,
    ).join('\n\n');
    const parsed = parseChatMarkdown(
      `# Long structured export\n\n${header}\n${separator}\n${row}\n\n${sections}`,
      'long-structured.md',
    );
    const [docx, pdf] = await Promise.all([
      generateChatExport(parsed.document, 'docx', provenance),
      generateChatExport(parsed.document, 'pdf', provenance),
    ]);
    await validateSafeDocx(docx.bytes);
    validateSafePdf(pdf.bytes);
    expect(pdf.warnings).toContain('A wide PDF table was exported in a line-oriented layout.');
    const extracted = await extractDocument(docx.bytes, 'docx');
    expect(extracted.markdown).toContain('Long structured export');
    expect(extracted.markdown).toContain('Revenue evidence 120');
  });
});
