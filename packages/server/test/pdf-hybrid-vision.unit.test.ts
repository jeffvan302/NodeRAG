import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractDocument,
  type InjectedVision,
  type VisionRequest,
  type VisionResult,
} from '../src/extract/index.js';

const fixture = (name: string): string => join(process.cwd(), 'fixtures', 'formats', 'pdf', name);

const analysed = (request: VisionRequest, confidence = 0.96, cached = false): VisionResult => {
  const digest = createHash('sha256').update(request.bytes).digest('hex');
  return {
    disposition: 'analysed',
    kind: 'table',
    markdown: '| Reconstructed | Value |\n| --- | --- |\n| Revenue | 42.8 |',
    alt: 'Reconstructed revenue table',
    confidence,
    layoutBlocks: [
      {
        kind: 'table',
        markdown: '| Reconstructed | Value |\n| --- | --- |\n| Revenue | 42.8 |',
        text: 'Reconstructed Value Revenue 42.8',
        confidence,
        sourceImageIndex: 1,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      },
    ],
    provider: 'stage-four-fake',
    model: 'layout-fixture-v1',
    revisions: {
      provider: 'vision-provider.v2',
      model: 'layout-fixture-v1',
      prompt: 'vision-transcription.v3-layout',
      schema: 'vision-result.v3-layout-blocks',
      preprocessing: 'vision-preprocess.v1',
    },
    originalSha256: digest,
    preprocessedSha256: digest,
    width: 640,
    height: 320,
    elapsedMs: 8,
    cached,
    cacheKey: digest,
  };
};

const recordingVision = (
  result: (request: VisionRequest) => VisionResult = (request) => analysed(request),
) => {
  const requests: VisionRequest[] = [];
  const vision: InjectedVision = {
    maximumImagesPerCall: 5,
    maximumParallelCalls: 2,
    async analyse(request) {
      requests.push(request);
      return result(request);
    },
    async analyseMany(batch) {
      requests.push(...batch);
      return batch.map(result);
    },
  };
  return { requests, vision };
};

describe('selective PDF vision and reconciliation', () => {
  it('sends one bounded crop and replaces only the uncertain table region', async () => {
    const recorder = recordingVision();
    const document = await extractDocument(
      await readFile(fixture('complex-table.pdf')),
      'pdf',
      {},
      recorder.vision,
    );
    expect(recorder.requests).toHaveLength(1);
    expect(recorder.requests[0]).toMatchObject({
      kind: 'pdf-region',
      pageNumber: 1,
      targetBlockOrdinal: 1,
      region: {
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      },
    });
    expect(document.pages[0]?.extraction).toBe('mixed');
    expect(document.markdown).toContain('| Reconstructed | Value |');
    expect(document.markdown).not.toContain('Complex table — layout requires review');
    expect(document.markdown.match(/<!-- noderag:vision /gu)).toHaveLength(1);
    expect(document.markdown.match(/Notes span all forecast columns/gu)).toHaveLength(1);
    const visionBlock = document.pages[0]?.blocks.find(({ source }) => source === 'vision');
    expect(visionBlock).toMatchObject({
      kind: 'table',
      routing: { disposition: 'native-safe' },
      revisions: {
        visionPrompt: 'vision-transcription.v3-layout',
        visionSchema: 'vision-result.v3-layout-blocks',
      },
    });
    expect(document.metadata['cropPolicyRevision']).toBe('pdf-crop.v1-margin-015');
  });

  it('uses zero provider calls for clean digital prose and simple tables', async () => {
    const recorder = recordingVision();
    const prose = await extractDocument(
      await readFile(fixture('aligned-prose-negative.pdf')),
      'pdf',
      {},
      recorder.vision,
    );
    const table = await extractDocument(
      await readFile(fixture('simple-table.pdf')),
      'pdf',
      {},
      recorder.vision,
    );
    expect(recorder.requests).toEqual([]);
    expect(prose.pages[0]?.extraction).toBe('text');
    expect(table.pages[0]?.blocks.some(({ kind }) => kind === 'table')).toBe(true);
  });

  it('replaces an unreadable full page instead of appending duplicate native text', async () => {
    const recorder = recordingVision();
    const document = await extractDocument(
      await readFile(fixture('scanned.pdf')),
      'pdf',
      {},
      recorder.vision,
    );
    expect(recorder.requests).toHaveLength(1);
    expect(recorder.requests[0]?.kind).toBe('pdf-page');
    expect(document.pages[0]?.extraction).toBe('vision');
    expect(document.pages[0]?.blocks).toHaveLength(1);
    expect(document.markdown.match(/\| Reconstructed \| Value \|/gu)).toHaveLength(1);
  });

  it('retains the native fallback and makes low-confidence vision retryable', async () => {
    const recorder = recordingVision((request) => analysed(request, 0.3));
    const document = await extractDocument(
      await readFile(fixture('complex-table.pdf')),
      'pdf',
      {},
      recorder.vision,
    );
    expect(document.pages[0]?.extraction).toBe('text');
    expect(document.markdown).toContain('Complex table — layout requires review');
    expect(document.pages[0]?.warnings).toContain('pdf-region-vision-unresolved');
    expect(document.pages[0]?.images[0]).toMatchObject({
      disposition: 'pending_vision',
      lastErrorCode: 'vision-low-confidence',
    });
  });
});
