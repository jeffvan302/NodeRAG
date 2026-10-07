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
import { PDF_CROP_POLICY_REVISION } from '../packages/server/src/extract/pdf.js';
import type { VisionProviderRequest } from '../packages/server/src/vision/contract.js';
import {
  VISION_PREPROCESSING_REVISION,
  VISION_PROMPT_REVISION,
  VISION_SCHEMA_REVISION,
} from '../packages/server/src/vision/contract.js';
import { DeterministicFakeVisionProvider } from '../packages/server/src/vision/fake.js';
import { VisionProcessor, type VisionCachePort } from '../packages/server/src/vision/service.js';
import type { AnalysedVisionResult } from '../packages/server/src/extract/contract.js';

interface Expectation {
  readonly file: string;
  readonly visionDisposition: 'none' | 'region' | 'page';
}

class RecordingProvider extends DeterministicFakeVisionProvider {
  readonly batches: Array<readonly VisionProviderRequest[]> = [];

  override async analyseMany(requests: readonly VisionProviderRequest[]) {
    this.batches.push(requests);
    return super.analyseMany(requests);
  }
}

const root = resolve(import.meta.dirname, '..');
const fixtureRoot = resolve(root, 'fixtures/formats/pdf');
const expectations = JSON.parse(
  await readFile(resolve(fixtureRoot, 'layout-expectations.json'), 'utf8'),
) as { readonly fixtures: readonly Expectation[] };
const cacheEntries = new Map<string, AnalysedVisionResult>();
const cache: VisionCachePort = {
  async get(key) {
    return cacheEntries.get(key.fingerprint) ?? null;
  },
  async markDispatched() {
    return null;
  },
  async put(key, _dispatchId, result) {
    cacheEntries.set(key.fingerprint, result);
  },
  async markFailed() {},
};
const provider = new RecordingProvider();
const vision = new VisionProcessor({ provider, cache, maximumConcurrency: 2 });
const fixtures: Array<Record<string, unknown>> = [];
let locatorFailures = 0;
let duplicateVisionBlocks = 0;
let cleanProviderCalls = 0;
let routingFailures = 0;

for (const expected of expectations.fixtures) {
  const bytes = await readFile(resolve(fixtureRoot, expected.file));
  const native = await extractDocument(bytes, 'pdf');
  const batchOffset = provider.batches.length;
  const started = performance.now();
  const enhanced = await extractDocument(bytes, 'pdf', {}, vision);
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const dispatched = provider.batches.slice(batchOffset).flat();
  const regional = dispatched.filter(({ sourceKind }) => sourceKind === 'pdf-region').length;
  const fullPage = dispatched.filter(({ sourceKind }) => sourceKind === 'pdf-page').length;
  const regionalApplied = enhanced.pages.filter(({ extraction }) => extraction === 'mixed').length;
  const fullPageApplied = enhanced.pages.filter(({ extraction }) => extraction === 'vision').length;
  if (expected.visionDisposition === 'none') cleanProviderCalls += dispatched.length;
  const routePassed =
    expected.visionDisposition === 'none'
      ? dispatched.length === 0
      : expected.visionDisposition === 'region'
        ? regionalApplied > 0 && fullPageApplied === 0
        : fullPageApplied > 0;
  if (!routePassed) routingFailures += 1;

  for (const page of enhanced.pages) {
    const seen = new Set<string>();
    for (const block of page.blocks) {
      if (
        enhanced.markdown.slice(block.characterStart, block.characterEnd) !== block.markdown ||
        Buffer.from(enhanced.markdown, 'utf8')
          .subarray(block.byteStart, block.byteEnd)
          .toString('utf8') !== block.markdown
      ) {
        locatorFailures += 1;
      }
      if (block.source === 'vision') {
        const normalized = block.text.replace(/\s+/gu, ' ').trim();
        if (normalized.length > 0 && seen.has(normalized)) duplicateVisionBlocks += 1;
        seen.add(normalized);
      }
    }
  }
  fixtures.push({
    file: expected.file,
    expectedVisionDisposition: expected.visionDisposition,
    routePassed,
    regionalImages: regional,
    fullPageImages: fullPage,
    regionalApplied,
    fullPageApplied,
    cacheHits: Number(enhanced.metadata['visionCacheHits'] ?? 0),
    providerBatches: provider.batches.slice(batchOffset).map(({ length }) => length),
    nativeMarkdownSha256: createHash('sha256').update(native.markdown).digest('hex'),
    enhancedMarkdownSha256: createHash('sha256').update(enhanced.markdown).digest('hex'),
    nativeCharacters: native.markdown.length,
    enhancedCharacters: enhanced.markdown.length,
    enhancedVisionBlocks: enhanced.pages
      .flatMap(({ blocks }) => blocks)
      .filter(({ source }) => source === 'vision').length,
    elapsedMs,
  });
}

const providerImages = provider.batches.reduce((total, batch) => total + batch.length, 0);
const gates = {
  cleanDigitalZeroCalls: cleanProviderCalls === 0,
  expectedRoutingPassed: routingFailures === 0,
  dualUnitLocatorsPassed: locatorFailures === 0,
  noDuplicateVisionBlocks: duplicateVisionBlocks === 0,
  batchingBoundedToFive: provider.batches.every(({ length }) => length <= 5),
};
const passed = Object.values(gates).every(Boolean);
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
      revisions: {
        pdfExtractionVersion: PDF_EXTRACTION_VERSION,
        parserRevision: PDF_PARSER_REVISION,
        layoutPolicyRevision: PDF_LAYOUT_POLICY_REVISION,
        confidencePolicyRevision: PDF_CONFIDENCE_POLICY_REVISION,
        visionPromptRevision: VISION_PROMPT_REVISION,
        visionSchemaRevision: VISION_SCHEMA_REVISION,
        visionPreprocessingRevision: VISION_PREPROCESSING_REVISION,
        cropPolicyRevision: PDF_CROP_POLICY_REVISION,
      },
      provider: {
        name: provider.provider,
        images: providerImages,
        batches: provider.batches.length,
        batchSizes: provider.batches.map(({ length }) => length),
        cacheEntries: cacheEntries.size,
      },
      metrics: { cleanProviderCalls, routingFailures, locatorFailures, duplicateVisionBlocks },
      gates,
      fixtures,
      gate: passed ? 'passed' : 'failed',
    },
    null,
    2,
  )}\n`,
);
if (!passed) process.exitCode = 1;
