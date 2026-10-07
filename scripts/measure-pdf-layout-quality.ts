import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { extractDocument } from '../packages/server/src/extract/index.js';
import {
  PDF_CONFIDENCE_POLICY_REVISION,
  PDF_EXTRACTION_VERSION,
  PDF_LAYOUT_POLICY_REVISION,
  PDF_PARSER_REVISION,
} from '../packages/server/src/extract/pdf-layout.js';

interface LayoutExpectation {
  readonly file: string;
  readonly expectedKinds?: readonly string[];
  readonly expectedSuppressedKinds?: readonly string[];
  readonly forbiddenKinds?: readonly string[];
  readonly requiredMarkdown?: readonly string[];
  readonly requiredTextOrder?: readonly string[];
  readonly forbiddenMarkdown?: readonly string[];
  readonly requiredWarning?: string;
  readonly visionDisposition: 'none' | 'region' | 'page';
}

interface Expectations {
  readonly version: number;
  readonly fixtures: readonly LayoutExpectation[];
}

const root = resolve(import.meta.dirname, '..');
const fixtureRoot = resolve(root, 'fixtures', 'formats', 'pdf');
const expectations = JSON.parse(
  await readFile(resolve(fixtureRoot, 'layout-expectations.json'), 'utf8'),
) as Expectations;

let headingExpected = 0;
let headingAccepted = 0;
let listExpected = 0;
let listAccepted = 0;
let evidenceExpected = 0;
let evidenceAccepted = 0;
let tableEvidenceExpected = 0;
let tableEvidenceAccepted = 0;
let duplicateBlocks = 0;
let materialBlocks = 0;
let locatorFailures = 0;
let falseTableClassifications = 0;
let complexFallbackFailures = 0;
let visionBoundPages = 0;
const routingConfusion = {
  expectedNoneActualNone: 0,
  expectedNoneActualRegion: 0,
  expectedNoneActualPage: 0,
  expectedRegionActualRegion: 0,
  expectedRegionActualNone: 0,
  expectedRegionActualPage: 0,
  expectedPageActualPage: 0,
  expectedPageActualNone: 0,
  expectedPageActualRegion: 0,
};
let peakRssBytes = process.memoryUsage().rss;
const reports: Array<Record<string, unknown>> = [];

for (const expectation of expectations.fixtures) {
  const bytes = await readFile(resolve(fixtureRoot, expectation.file));
  const started = performance.now();
  const document = await extractDocument(bytes, 'pdf');
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  const blocks = document.pages.flatMap((page) => page.blocks);
  const emitted = blocks.filter(({ markdown }) => markdown.length > 0);
  const actualKinds = emitted.map(({ kind }) => kind);
  const suppressedKinds = blocks
    .filter(({ markdown }) => markdown.length === 0)
    .map(({ kind }) => kind);

  for (const required of expectation.requiredMarkdown ?? []) {
    evidenceExpected += 1;
    if (document.markdown.includes(required)) evidenceAccepted += 1;
    if (required.startsWith('#')) {
      headingExpected += 1;
      if (document.markdown.includes(required)) headingAccepted += 1;
    }
    if (/^(?:\s*[-*]|\s*\d+[.)])\s/u.test(required)) {
      listExpected += 1;
      if (document.markdown.includes(required)) listAccepted += 1;
    }
    if (required.startsWith('|')) {
      tableEvidenceExpected += 1;
      if (document.markdown.includes(required)) tableEvidenceAccepted += 1;
    }
  }
  for (const required of expectation.requiredTextOrder ?? []) {
    evidenceExpected += 1;
    if (document.markdown.includes(required)) evidenceAccepted += 1;
  }

  const positions = (expectation.requiredTextOrder ?? []).map((text) =>
    document.markdown.indexOf(text),
  );
  const readingOrderPassed =
    positions.every((position) => position >= 0) &&
    positions.every((position, index) => index === 0 || position > (positions[index - 1] ?? -1));
  const expectedKindsPassed =
    expectation.expectedKinds === undefined ||
    expectation.expectedKinds.every((kind, index) => actualKinds[index] === kind);
  const suppressedKindsPassed = (expectation.expectedSuppressedKinds ?? []).every((kind) =>
    suppressedKinds.includes(kind),
  );
  const forbiddenMarkdownPassed = (expectation.forbiddenMarkdown ?? []).every(
    (text) => !document.markdown.includes(text),
  );
  const warningPassed =
    expectation.requiredWarning === undefined ||
    document.warnings.includes(expectation.requiredWarning);
  if ((expectation.forbiddenKinds ?? []).includes('table') && actualKinds.includes('table')) {
    falseTableClassifications += 1;
  }
  if (
    expectation.requiredWarning === 'complex-table-fallback' &&
    (!document.warnings.includes('complex-table-fallback') || !actualKinds.includes('unknown'))
  ) {
    complexFallbackFailures += 1;
  }
  visionBoundPages += document.pages.filter(({ extraction }) => extraction === 'vision').length;
  const actualVisionDisposition = document.pages.some(({ extraction }) => extraction === 'vision')
    ? 'page'
    : blocks.some(({ routing }) => routing?.disposition === 'regional-vision')
      ? 'region'
      : 'none';
  const confusionKey =
    `expected${expectation.visionDisposition[0]?.toUpperCase()}${expectation.visionDisposition.slice(1)}Actual${actualVisionDisposition[0]?.toUpperCase()}${actualVisionDisposition.slice(1)}` as keyof typeof routingConfusion;
  routingConfusion[confusionKey] += 1;

  for (const page of document.pages) {
    const seenText = new Set<string>();
    for (const block of page.blocks) {
      if (block.markdown.length > 0) {
        materialBlocks += 1;
        const normalized = block.text.replace(/\s+/gu, ' ').trim();
        if (normalized.length > 0 && seenText.has(normalized)) duplicateBlocks += 1;
        seenText.add(normalized);
      }
      const characterSlice = document.markdown.slice(block.characterStart, block.characterEnd);
      const byteSlice = Buffer.from(document.markdown, 'utf8')
        .subarray(block.byteStart, block.byteEnd)
        .toString('utf8');
      if (characterSlice !== block.markdown || byteSlice !== block.markdown) locatorFailures += 1;
    }
  }

  reports.push({
    file: expectation.file,
    kinds: actualKinds,
    suppressedKinds,
    readingOrderPassed,
    expectedKindsPassed,
    suppressedKindsPassed,
    forbiddenMarkdownPassed,
    warningPassed,
    expectedVisionDisposition: expectation.visionDisposition,
    actualVisionDisposition,
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    markdownSha256: createHash('sha256').update(document.markdown).digest('hex'),
  });
}

const ratio = (accepted: number, expected: number): number =>
  expected === 0 ? 1 : Math.round((accepted / expected) * 10_000) / 10_000;
const elapsed = reports
  .map(({ elapsedMs }) => Number(elapsedMs))
  .sort((left, right) => left - right);
const medianElapsedMs = elapsed[Math.floor(elapsed.length / 2)] ?? 0;
const allFixtureAssertionsPassed = reports.every(
  ({
    readingOrderPassed,
    expectedKindsPassed,
    suppressedKindsPassed,
    forbiddenMarkdownPassed,
    warningPassed,
  }) =>
    readingOrderPassed === true &&
    expectedKindsPassed === true &&
    suppressedKindsPassed === true &&
    forbiddenMarkdownPassed === true &&
    warningPassed === true,
);
const metrics = {
  headingKindAndLevelF1: ratio(headingAccepted, headingExpected),
  listItemF1: ratio(listAccepted, listExpected),
  simpleTableCellEvidenceAccuracy: ratio(tableEvidenceAccepted, tableEvidenceExpected),
  requiredEvidenceRetention: ratio(evidenceAccepted, evidenceExpected),
  duplicateTextRate: ratio(duplicateBlocks, materialBlocks),
  locatorFailures,
  falseTableClassifications,
  complexFallbackFailures,
  visionBoundPages,
  routingConfusion,
  visionRequiredFalseAcceptanceRate: ratio(
    routingConfusion.expectedRegionActualNone + routingConfusion.expectedPageActualNone,
    expectations.fixtures.filter(({ visionDisposition }) => visionDisposition !== 'none').length,
  ),
  cleanPageFullVisionRate: ratio(
    routingConfusion.expectedNoneActualPage,
    expectations.fixtures.filter(({ visionDisposition }) => visionDisposition === 'none').length,
  ),
  medianElapsedMs,
  maximumPeakRssBytes: peakRssBytes,
};
const gates = {
  allFixtureAssertionsPassed,
  headingTargetPassed: metrics.headingKindAndLevelF1 >= 0.9,
  listTargetPassed: metrics.listItemF1 >= 0.95,
  simpleTableTargetPassed: metrics.simpleTableCellEvidenceAccuracy >= 0.95,
  retentionPassed: metrics.requiredEvidenceRetention === 1,
  duplicateTextPassed: metrics.duplicateTextRate === 0,
  locatorsPassed: locatorFailures === 0,
  negativeTablePassed: falseTableClassifications === 0,
  complexFallbackPassed: complexFallbackFailures === 0,
  routingFalseAcceptancePassed:
    routingConfusion.expectedRegionActualNone + routingConfusion.expectedPageActualNone === 0,
  cleanPageFullVisionPassed: routingConfusion.expectedNoneActualPage === 0,
};
const passed = Object.values(gates).every(Boolean);

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      extraction: {
        pdfExtractionVersion: PDF_EXTRACTION_VERSION,
        parserRevision: PDF_PARSER_REVISION,
        layoutPolicyRevision: PDF_LAYOUT_POLICY_REVISION,
        confidencePolicyRevision: PDF_CONFIDENCE_POLICY_REVISION,
      },
      metrics,
      gates,
      fixtures: reports,
      gate: passed ? 'passed' : 'failed',
    },
    null,
    2,
  )}\n`,
);
if (!passed) process.exitCode = 1;
