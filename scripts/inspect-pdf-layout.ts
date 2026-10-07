import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { extractDocument } from '../packages/server/src/extract/index.js';

const requested = process.argv.slice(2);
const names =
  requested.length > 0
    ? requested
    : [
        'layout-headings.pdf',
        'legal-lists.pdf',
        'three-column.pdf',
        'simple-table.pdf',
        'complex-table.pdf',
        'repeated-furniture.pdf',
        'diagram-caption.pdf',
        'aligned-prose-negative.pdf',
      ];

for (const name of names) {
  const path = resolve(import.meta.dirname, '..', 'fixtures', 'formats', 'pdf', name);
  const document = await extractDocument(await readFile(path), 'pdf');
  process.stdout.write(
    `${JSON.stringify(
      {
        file: name,
        metadata: document.metadata,
        markdown: document.markdown,
        pages: document.pages.map((page) => ({
          pageNumber: page.pageNumber,
          metadata: page.metadata,
          warnings: page.warnings,
          blocks: page.blocks.map(({ kind, text, markdown, bounds, warnings, confidence }) => ({
            kind,
            text,
            markdown,
            bounds,
            warnings,
            confidence,
          })),
        })),
      },
      null,
      2,
    )}\n`,
  );
}
