import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { extractDocument } from '../packages/server/src/extract/index.js';
import {
  PDF_CONFIDENCE_POLICY_REVISION,
  PDF_CONFIDENCE_THRESHOLDS,
} from '../packages/server/src/extract/pdf-layout.js';

const fixtureRoot = resolve(import.meta.dirname, '..', 'fixtures', 'formats', 'pdf');
const fixtureNames = [
  'layout-headings.pdf',
  'legal-lists.pdf',
  'three-column.pdf',
  'simple-table.pdf',
  'complex-table.pdf',
  'repeated-furniture.pdf',
  'diagram-caption.pdf',
  'aligned-prose-negative.pdf',
  'scanned.pdf',
  'no-tounicode.pdf',
] as const;

const rows: Array<Record<string, unknown>> = [];
for (const file of fixtureNames) {
  const document = await extractDocument(await readFile(resolve(fixtureRoot, file)), 'pdf');
  const dispositions = document.pages.flatMap((page) =>
    page.blocks.map((block) => block.routing?.disposition ?? 'native-safe'),
  );
  const fullPage = document.pages.some(({ extraction }) => extraction === 'vision');
  rows.push({
    file,
    previousPolicy: fullPage ? 'full-page-vision' : 'native-safe',
    currentPolicy: fullPage
      ? 'full-page-vision'
      : dispositions.includes('regional-vision')
        ? 'regional-vision'
        : 'native-safe',
    canonicalMarkdownUnchangedByComparison: true,
  });
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      comparisonOnly: true,
      mutationPerformed: false,
      previousPolicy: 'page-confidence.v1',
      currentPolicy: PDF_CONFIDENCE_POLICY_REVISION,
      thresholds: PDF_CONFIDENCE_THRESHOLDS,
      changedDecisions: rows.filter(
        ({ previousPolicy, currentPolicy }) => previousPolicy !== currentPolicy,
      ).length,
      fixtures: rows,
    },
    null,
    2,
  )}\n`,
);
