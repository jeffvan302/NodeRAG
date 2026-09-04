import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';
import { extractDocument } from '../src/extract/index.js';
import { visionResponseSchema } from '../src/vision/contract.js';
import { DeterministicFakeVisionProvider } from '../src/vision/fake.js';
import { OllamaVisionProvider } from '../src/vision/ollama.js';
import { preprocessVisionImage } from '../src/vision/preprocess.js';
import { VisionProcessor, type VisionCachePort } from '../src/vision/service.js';

const fixture = (...parts: string[]): string =>
  join(process.cwd(), 'fixtures', 'formats', ...parts);

const testImage = (width = 128, height = 96): Buffer => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#111';
  for (let x = 0; x < width; x += 8) context.fillRect(x, (x * 3) % height, 5, 20);
  return canvas.toBuffer('image/png');
};

const request = (bytes = testImage()) => ({
  kind: 'document-image' as const,
  bytes,
  mediaType: 'image/png',
  pageNumber: null,
  imageId: 'fixture',
});

describe('vision contract and preprocessing', () => {
  it('strictly rejects missing and hallucinated response fields', () => {
    expect(
      visionResponseSchema.safeParse({ kind: 'table', markdown: '| a |', alt: 'table' }).success,
    ).toBe(false);
    expect(
      visionResponseSchema.safeParse({
        kind: 'table',
        markdown: '| a |',
        alt: 'table',
        confidence: 0.8,
        narrative: 'not in schema',
      }).success,
    ).toBe(false);
  });

  it('downscales large images and retains both digests', async () => {
    const prepared = await preprocessVisionImage(testImage(800, 400), { maximumDimension: 200 });
    expect(prepared).toMatchObject({ disposition: 'ready', width: 200, height: 100 });
    if (prepared.disposition !== 'ready') throw new Error('expected-ready-image');
    expect(prepared.originalSha256).toHaveLength(64);
    expect(prepared.preprocessedSha256).toHaveLength(64);
    expect(prepared.preprocessedSha256).not.toBe(prepared.originalSha256);
  });

  it('skips tiny, extreme-aspect, and low-entropy images', async () => {
    const tiny = await preprocessVisionImage(testImage(32, 32), { maximumDimension: 256 });
    expect(tiny).toMatchObject({ disposition: 'skipped', reason: 'too-small' });

    const extreme = await preprocessVisionImage(testImage(2048, 64), { maximumDimension: 256 });
    expect(extreme).toMatchObject({ disposition: 'skipped', reason: 'extreme-aspect-ratio' });

    const blank = createCanvas(128, 128).toBuffer('image/png');
    const lowEntropy = await preprocessVisionImage(blank, { maximumDimension: 256 });
    expect(lowEntropy).toMatchObject({ disposition: 'skipped', reason: 'low-entropy' });
  });
});

describe('Ollama vision provider', () => {
  it('validates /api/tags and sends deterministic structured /api/chat options', async () => {
    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return Response.json({ models: [{ name: 'llava:latest', digest: 'sha256:model' }] });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: 'llava:latest',
        stream: false,
        keep_alive: '30m',
        options: { temperature: 0, num_ctx: 8192 },
      });
      expect(body.format).toMatchObject({ type: 'object', additionalProperties: false });
      return Response.json({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            kind: 'table',
            markdown: '| A | B |',
            alt: 'A small table',
            confidence: 0.92,
          }),
        },
      });
    });
    const provider = new OllamaVisionProvider(
      { baseUrl: 'http://127.0.0.1:11434', model: 'llava:latest' },
      mockFetch,
    );
    await expect(provider.assertModelAvailable()).resolves.toMatchObject({
      name: 'llava:latest',
    });
    const processor = new VisionProcessor({ provider, initialBackoffMs: 0 });
    await expect(processor.analyse(request())).resolves.toMatchObject({
      disposition: 'analysed',
      kind: 'table',
      provider: 'ollama',
      cached: false,
    });
  });

  it('classifies missing models and malformed output without accepting it', async () => {
    const missing = new OllamaVisionProvider(
      { baseUrl: 'http://127.0.0.1:11434', model: 'missing' },
      async () => Response.json({ models: [] }),
    );
    await expect(missing.assertModelAvailable()).rejects.toMatchObject({
      code: 'vision-model-missing',
      classification: 'permanent',
    });

    const malformed = new OllamaVisionProvider(
      { baseUrl: 'http://127.0.0.1:11434', model: 'vision' },
      async () => Response.json({ message: { role: 'assistant', content: '{broken' } }),
    );
    const result = await new VisionProcessor({
      provider: malformed,
      maximumAttempts: 1,
    }).analyse(request());
    expect(result).toMatchObject({
      disposition: 'pending_vision',
      errorCode: 'vision-content-malformed',
    });
  });

  it('classifies rate limits and aborted calls as transient', async () => {
    const rateLimited = new OllamaVisionProvider(
      { baseUrl: 'http://127.0.0.1:11434', model: 'vision' },
      async () => new Response('busy', { status: 429 }),
    );
    await expect(
      rateLimited.analyse({
        bytes: testImage(),
        mediaType: 'image/png',
        sourceKind: 'document-image',
        pageNumber: null,
        imageId: 'rate-limit',
        prompt: 'test',
        schema: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(expect.objectContaining({ classification: 'transient' }));

    const timeoutProvider = new DeterministicFakeVisionProvider();
    timeoutProvider.analyse = async ({ signal }) =>
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    const timeout = await new VisionProcessor({
      provider: timeoutProvider,
      timeoutMs: 5,
      maximumAttempts: 1,
    }).analyse(request());
    expect(timeout).toMatchObject({ disposition: 'pending_vision' });
  });
});

describe('vision processing and extraction recovery', () => {
  it('never exceeds the configured provider concurrency', async () => {
    class ConcurrencyProbe extends DeterministicFakeVisionProvider {
      active = 0;
      peak = 0;

      override async analyse(input: Parameters<DeterministicFakeVisionProvider['analyse']>[0]) {
        this.active += 1;
        this.peak = Math.max(this.peak, this.active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return await super.analyse(input);
        } finally {
          this.active -= 1;
        }
      }
    }
    const provider = new ConcurrencyProbe();
    const processor = new VisionProcessor({ provider, maximumConcurrency: 2 });
    await Promise.all(
      [128, 136, 144, 152, 160].map((width) => processor.analyse(request(testImage(width, 96)))),
    );
    expect(provider.peak).toBe(2);
  });

  it('uses a global cache key without silo membership data', async () => {
    const entries = new Map<string, Awaited<ReturnType<VisionProcessor['analyse']>>>();
    const cache: VisionCachePort = {
      async get(key) {
        const found = entries.get(key.fingerprint);
        return found?.disposition === 'analysed' ? found : null;
      },
      async markDispatched() {
        return 'dispatch';
      },
      async put(key, _dispatchId, result) {
        entries.set(key.fingerprint, result);
      },
      async markFailed() {},
    };
    const provider = new DeterministicFakeVisionProvider();
    const analyse = vi.spyOn(provider, 'analyse');
    const processor = new VisionProcessor({ provider, cache });
    const first = await processor.analyse(request());
    const second = await processor.analyse(request());
    expect(first).toMatchObject({ disposition: 'analysed', cached: false });
    expect(second).toMatchObject({ disposition: 'analysed', cached: true });
    expect(analyse).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached results when the model revision changes', async () => {
    class RevisionProvider extends DeterministicFakeVisionProvider {
      constructor(override readonly modelRevision: string) {
        super();
      }
    }
    const entries = new Map<string, Awaited<ReturnType<VisionProcessor['analyse']>>>();
    const cache: VisionCachePort = {
      async get(key) {
        const found = entries.get(key.fingerprint);
        return found?.disposition === 'analysed' ? found : null;
      },
      async markDispatched() {
        return null;
      },
      async put(key, _dispatchId, result) {
        entries.set(key.fingerprint, result);
      },
      async markFailed() {},
    };
    const image = request();
    const revisionA = new VisionProcessor({ provider: new RevisionProvider('digest-a'), cache });
    const revisionB = new VisionProcessor({ provider: new RevisionProvider('digest-b'), cache });
    expect(await revisionA.analyse(image)).toMatchObject({ cached: false });
    expect(await revisionB.analyse(image)).toMatchObject({ cached: false });
    expect(await revisionA.analyse(image)).toMatchObject({ cached: true });
    expect(entries.size).toBe(2);
  });

  it('renders a scanned PDF page and injects searchable provenance Markdown', async () => {
    const processor = new VisionProcessor({ provider: new DeterministicFakeVisionProvider() });
    const extracted = await extractDocument(
      await readFile(fixture('pdf', 'scanned.pdf')),
      'pdf',
      {},
      processor,
    );
    expect(extracted.markdown).toContain('Vision fixture');
    expect(extracted.markdown).toContain('noderag:vision');
    expect(extracted.pages[0]).toMatchObject({ extraction: 'vision' });
    expect(extracted.pages[0]?.images[0]).toMatchObject({
      mediaType: 'image/png',
      disposition: 'analysed',
    });
  });
});
