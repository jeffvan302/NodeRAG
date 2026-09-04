import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Embedder, EmbedderModel } from '@noderag/shared';
import type { Tensor as OrtTensor } from 'onnxruntime-node';

export interface EmbeddingRuntime extends Embedder {
  readonly dimensions: number;
  close(): Promise<void>;
}

export const defaultModelManifestDigest =
  'a3e6f76a9d02f5e3fcd88491aab3ad3622739e785e8847d0e098362bf7640aaf';

const normalized = (vector: readonly number[]): readonly number[] => {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(length) || length === 0) throw new Error('Embedding has an invalid norm.');
  return vector.map((value) => value / length);
};

const deterministicTokens = (text: string): readonly string[] =>
  text
    .normalize('NFC')
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu) ?? [''];

export const createDeterministicRuntime = (
  dimensions = 1024,
  baseManifestDigest = defaultModelManifestDigest,
): EmbeddingRuntime => ({
  dimensions,
  async countTokens(texts) {
    return texts.map((text) => deterministicTokens(text).length);
  },
  async embed(texts, maxTokens, _priority, model) {
    const started = performance.now();
    const tokenCounts = texts.map((text) => deterministicTokens(text).length);
    if (tokenCounts.some((count) => count > maxTokens)) throw new Error('TOKEN_LIMIT');
    const selectedDimensions = model?.dimensions ?? dimensions;
    const salt =
      model === undefined || model.manifestDigest === baseManifestDigest
        ? undefined
        : model.manifestDigest;
    const vectors = texts.map((text) => {
      const vector = new Array<number>(selectedDimensions).fill(0);
      for (const token of deterministicTokens(text)) {
        const hash = createHash('sha256');
        if (salt !== undefined) hash.update(salt).update('\0');
        const digest = hash.update(token).digest();
        const index = digest.readUInt32BE(0) % selectedDimensions;
        vector[index] = (vector[index] ?? 0) + 1;
      }
      return normalized(vector);
    });
    return { vectors, tokenCounts, elapsedMilliseconds: performance.now() - started };
  },
  async close() {},
});

const asBigInt64 = (data: ArrayLike<number | bigint>): BigInt64Array =>
  data instanceof BigInt64Array ? data : BigInt64Array.from(data, (value) => BigInt(value));

const asNumber = (value: number | bigint): number => Number(value);

const createPositionIds = (maskData: ArrayLike<number | bigint>, dimensions: readonly number[]) => {
  const batch = dimensions[0] ?? 0;
  const sequence = dimensions[1] ?? 0;
  const output = new BigInt64Array(batch * sequence);
  for (let row = 0; row < batch; row += 1) {
    let position = 0;
    for (let column = 0; column < sequence; column += 1) {
      const index = row * sequence + column;
      if (asNumber(maskData[index] ?? 0) > 0) {
        output[index] = BigInt(position);
        position += 1;
      }
    }
  }
  return output;
};

const float16ToNumber = (bits: number): number => {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
};

export const createOnnxRuntime = async (options: {
  readonly modelRoot: string;
  readonly modelPath: string;
  readonly dimensions: number;
  readonly threads: number;
  readonly manifestDigest?: string;
}): Promise<EmbeddingRuntime> => {
  const [{ Tokenizer }, ort, tokenizerJson, tokenizerConfig] = await Promise.all([
    import('@huggingface/tokenizers'),
    import('onnxruntime-node'),
    readFile(join(options.modelRoot, 'tokenizer.json'), 'utf8').then(JSON.parse),
    readFile(join(options.modelRoot, 'tokenizer_config.json'), 'utf8').then(JSON.parse),
  ]);
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  const session = await ort.InferenceSession.create(options.modelPath, {
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
    intraOpNumThreads: options.threads,
    interOpNumThreads: 1,
    executionProviders: ['cpu'],
  });
  const outputName =
    session.outputNames.find((name) => /last_hidden_state|token_embeddings/i.test(name)) ??
    session.outputNames[0];
  if (outputName === undefined) throw new Error('The ONNX model has no output.');

  const tokenize = (text: string) => {
    const encoded = tokenizer.encode(text);
    return {
      input_ids: { data: encoded.ids, dims: [1, encoded.ids.length] },
      attention_mask: { data: encoded.attention_mask, dims: [1, encoded.ids.length] },
    };
  };

  const countOne = async (text: string): Promise<number> => {
    const tokenized = tokenize(text);
    return Array.from(tokenized.attention_mask.data, asNumber).filter((value) => value > 0).length;
  };

  const assertModel = (model?: EmbedderModel): void => {
    if (model !== undefined && model.dimensions !== options.dimensions) {
      throw new Error('EMBEDDER_MODEL_DIMENSION_MISMATCH');
    }
    if (
      model !== undefined &&
      options.manifestDigest !== undefined &&
      model.manifestDigest !== options.manifestDigest
    ) {
      throw new Error('EMBEDDER_MODEL_UNAVAILABLE');
    }
  };

  const embedOne = async (text: string, maxTokens: number) => {
    const tokenized = tokenize(text);
    const ids = tokenized.input_ids;
    const mask = tokenized.attention_mask;
    const tokenCount = Array.from(mask.data, asNumber).filter((value) => value > 0).length;
    if (tokenCount > maxTokens) throw new Error('TOKEN_LIMIT');
    const feeds: Record<string, OrtTensor> = {};
    for (const inputName of session.inputNames) {
      if (inputName === 'input_ids') {
        feeds[inputName] = new ort.Tensor('int64', asBigInt64(ids.data), [...ids.dims]);
      } else if (inputName === 'attention_mask') {
        feeds[inputName] = new ort.Tensor('int64', asBigInt64(mask.data), [...mask.dims]);
      } else if (inputName === 'position_ids') {
        feeds[inputName] = new ort.Tensor('int64', createPositionIds(mask.data, mask.dims), [
          ...mask.dims,
        ]);
      } else if (/^past_key_values\.\d+\.(key|value)$/.test(inputName)) {
        const metadata = session.inputMetadata.find((value) => value.name === inputName);
        if (metadata === undefined || !metadata.isTensor) {
          throw new Error(`Missing tensor metadata for ${inputName}.`);
        }
        const shape = metadata.shape.map((dimension) => {
          if (typeof dimension === 'number') return dimension;
          if (/batch/i.test(dimension)) return mask.dims[0] ?? 1;
          if (/past.*sequence/i.test(dimension)) return 0;
          throw new Error(`Unsupported dynamic cache dimension: ${dimension}`);
        });
        if (metadata.type !== 'float16' && metadata.type !== 'float32') {
          throw new Error(`Unsupported cache tensor type: ${metadata.type}`);
        }
        const data = metadata.type === 'float16' ? new Uint16Array(0) : new Float32Array(0);
        feeds[inputName] = new ort.Tensor(metadata.type, data, shape);
      } else {
        throw new Error(`Unsupported ONNX input: ${inputName}`);
      }
    }
    const result = (await session.run(feeds, [outputName]))[outputName];
    if (
      result === undefined ||
      !('dims' in result) ||
      !('data' in result) ||
      result.dims.length !== 3
    ) {
      throw new Error('Expected a rank-three ONNX hidden-state output.');
    }
    const sequence = result.dims[1] ?? 0;
    const dimension = result.dims[2] ?? 0;
    if (result.dims[0] !== 1 || dimension !== options.dimensions) {
      throw new Error(`Unexpected ONNX output shape: ${result.dims.join('x')}`);
    }
    let last = sequence - 1;
    if (asNumber(mask.data[last] ?? 0) === 0) {
      last = Array.from(mask.data, asNumber).findLastIndex((value) => value > 0);
    }
    if (last < 0) throw new Error('Tokenizer produced an empty attention mask.');
    const start = last * dimension;
    const data = result.data as unknown as ArrayLike<number> & {
      slice(start: number, end: number): ArrayLike<number>;
    };
    const raw = Array.from(data.slice(start, start + dimension), (value) =>
      result.type === 'float16' ? float16ToNumber(Number(value)) : Number(value),
    );
    return { vector: normalized(raw), tokenCount };
  };

  return {
    dimensions: options.dimensions,
    async countTokens(texts, _priority, model) {
      assertModel(model);
      return Promise.all(texts.map(countOne));
    },
    async embed(texts, maxTokens, _priority, model) {
      assertModel(model);
      const started = performance.now();
      const results = [];
      for (const text of texts) results.push(await embedOne(text, maxTokens));
      return {
        vectors: results.map((result) => result.vector),
        tokenCounts: results.map((result) => result.tokenCount),
        elapsedMilliseconds: performance.now() - started,
      };
    },
    async close() {
      await session.release();
    },
  };
};
