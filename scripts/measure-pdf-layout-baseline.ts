import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { extractDocument } from '../packages/server/src/extract/index.js';
import {
  PDF_CONFIDENCE_POLICY_REVISION,
  PDF_EXTRACTION_VERSION,
  PDF_LAYOUT_POLICY_REVISION,
  PDF_PARSER_REVISION,
} from '../packages/server/src/extract/pdf-layout.js';

const root = resolve(import.meta.dirname, '..');
const fixtureRoot = resolve(root, 'fixtures/formats/pdf');
const names = (await readdir(fixtureRoot))
  .filter((name) => name.endsWith('.pdf'))
  .sort((left, right) => left.localeCompare(right));

const reports: Array<{
  readonly file: string;
  readonly bytes: number;
  readonly pages: number;
  readonly blocks: number;
  readonly markdownCharacters: number;
  readonly markdownSha256: string;
  readonly warnings: readonly string[];
  readonly elapsedMs: number;
  readonly peakRssBytes: number;
}> = [];

for (const name of names) {
  const bytes = await readFile(resolve(fixtureRoot, name));
  let peakRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 5);
  const started = performance.now();
  try {
    const extracted = await extractDocument(bytes, 'pdf');
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    reports.push({
      file: name,
      bytes: bytes.length,
      pages: extracted.pages.length,
      blocks: extracted.pages.reduce((total, page) => total + page.blocks.length, 0),
      markdownCharacters: extracted.markdown.length,
      markdownSha256: createHash('sha256').update(extracted.markdown).digest('hex'),
      warnings: [...new Set(extracted.warnings)].sort(),
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      peakRssBytes,
    });
  } finally {
    clearInterval(sampler);
  }
}

const sortedDurations = reports
  .map(({ elapsedMs }) => elapsedMs)
  .sort((left, right) => left - right);
const percentile = (fraction: number): number =>
  sortedDurations[
    Math.min(sortedDurations.length - 1, Math.floor(sortedDurations.length * fraction))
  ] ?? 0;

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
      },
      extraction: {
        pdfExtractionVersion: PDF_EXTRACTION_VERSION,
        parserRevision: PDF_PARSER_REVISION,
        layoutPolicyRevision: PDF_LAYOUT_POLICY_REVISION,
        confidencePolicyRevision: PDF_CONFIDENCE_POLICY_REVISION,
      },
      summary: {
        fixtures: reports.length,
        medianElapsedMs: percentile(0.5),
        p95ElapsedMs: percentile(0.95),
        maximumPeakRssBytes: Math.max(...reports.map(({ peakRssBytes }) => peakRssBytes)),
      },
      fixtures: reports,
    },
    null,
    2,
  )}\n`,
);
