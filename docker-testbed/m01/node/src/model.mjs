import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { AutoTokenizer } from "@huggingface/transformers";
import * as ort from "onnxruntime-node";

function asBigInt64(data) {
  if (data instanceof BigInt64Array) {
    return data;
  }
  return BigInt64Array.from(data, (value) => BigInt(value));
}

function asNumber(value) {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function createPositionIds(maskData, dims) {
  const [batch, sequence] = dims;
  const output = new BigInt64Array(batch * sequence);
  for (let row = 0; row < batch; row += 1) {
    let position = 0;
    for (let column = 0; column < sequence; column += 1) {
      const index = row * sequence + column;
      if (asNumber(maskData[index]) > 0) {
        output[index] = BigInt(position);
        position += 1;
      }
    }
  }
  return output;
}

function emptyPastTensor(metadata, maskDims) {
  const dims = metadata.shape.map((dimension) => {
    if (Number.isInteger(dimension)) return dimension;
    if (/batch/i.test(dimension)) return maskDims[0];
    if (/past.*sequence/i.test(dimension)) return 0;
    throw new Error(`Unsupported dynamic cache dimension: ${dimension}`);
  });
  if (!dims.includes(0)) {
    throw new Error(`Expected an empty cache tensor shape, received: ${dims.join("x")}`);
  }
  const typedArray = metadata.type === "float16" ? new Uint16Array(0) : new Float32Array(0);
  return new ort.Tensor(metadata.type, typedArray, dims);
}

function normalize(vector) {
  let squared = 0;
  for (const value of vector) {
    squared += value * value;
  }
  const norm = Math.sqrt(squared);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error(`Invalid embedding norm: ${norm}`);
  }
  return vector.map((value) => value / norm);
}

function float16ToNumber(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function tensorSliceAsNumbers(tensor, start = 0, end = tensor.data.length) {
  const slice = tensor.data.slice(start, end);
  if (tensor.type === "float16" && slice instanceof Uint16Array) {
    return Array.from(slice, float16ToNumber);
  }
  return Array.from(slice, Number);
}

function poolLastToken(output, attentionMask, expectedDimension) {
  if (output.dims.length === 2) {
    const [batch, dimension] = output.dims;
    if (batch !== 1 || dimension !== expectedDimension) {
      throw new Error(`Unexpected pooled output shape: ${output.dims.join("x")}`);
    }
    return normalize(tensorSliceAsNumbers(output));
  }

  if (output.dims.length !== 3) {
    throw new Error(`Unexpected ONNX output rank: ${output.dims.join("x")}`);
  }
  const [batch, sequence, dimension] = output.dims;
  if (batch !== 1 || dimension !== expectedDimension) {
    throw new Error(`Unexpected hidden-state output shape: ${output.dims.join("x")}`);
  }

  let lastIndex = sequence - 1;
  if (asNumber(attentionMask.data[sequence - 1]) === 0) {
    lastIndex = -1;
    for (let index = 0; index < sequence; index += 1) {
      if (asNumber(attentionMask.data[index]) > 0) {
        lastIndex = index;
      }
    }
  }
  if (lastIndex < 0) {
    throw new Error("Tokenizer produced an empty attention mask.");
  }
  const offset = lastIndex * dimension;
  return normalize(tensorSliceAsNumbers(output, offset, offset + dimension));
}

export async function loadManifest(manifestPath = "/opt/noderag/m01/model-manifest.json") {
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}

export async function createEmbedder({
  modelRoot = process.env.NODERAG_M01_MODEL_ROOT,
  modelPath,
  threads = Number(process.env.NODERAG_M01_THREADS ?? 1),
  maxTokens = Number(process.env.NODERAG_M01_MAX_TOKENS ?? 1024),
} = {}) {
  if (!modelRoot) {
    throw new Error("NODERAG_M01_MODEL_ROOT is required.");
  }
  const manifest = await loadManifest();
  const resolvedModelPath = modelPath ?? path.join(modelRoot, manifest.files.find((file) => file.variant === manifest.defaultVariant).path);
  const tokenizer = await AutoTokenizer.from_pretrained(modelRoot, {
    local_files_only: true,
    padding_side: "left",
  });

  const loadStarted = performance.now();
  const session = await ort.InferenceSession.create(resolvedModelPath, {
    executionMode: "sequential",
    graphOptimizationLevel: "all",
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionProviders: ["cpu"],
  });
  const loadMs = performance.now() - loadStarted;
  const embeddingOutputName =
    session.outputNames.find((name) => /last_hidden_state|token_embeddings/i.test(name)) ??
    session.outputNames[0];

  async function embed(text, { tokenLimit = maxTokens } = {}) {
    const tokenized = await tokenizer([text], {
      padding: true,
      truncation: true,
      max_length: tokenLimit,
    });
    const ids = tokenized.input_ids;
    const mask = tokenized.attention_mask;
    const feeds = {};
    for (const [inputIndex, inputName] of session.inputNames.entries()) {
      if (inputName === "input_ids") {
        feeds[inputName] = new ort.Tensor("int64", asBigInt64(ids.data), ids.dims);
      } else if (inputName === "attention_mask") {
        feeds[inputName] = new ort.Tensor("int64", asBigInt64(mask.data), mask.dims);
      } else if (inputName === "position_ids") {
        feeds[inputName] = new ort.Tensor("int64", createPositionIds(mask.data, mask.dims), mask.dims);
      } else if (/^past_key_values\.\d+\.(key|value)$/.test(inputName)) {
        feeds[inputName] = emptyPastTensor(session.inputMetadata[inputIndex], mask.dims);
      } else {
        throw new Error(`Unsupported ONNX input: ${inputName}`);
      }
    }

    const started = performance.now();
    const results = await session.run(feeds, [embeddingOutputName]);
    const inferenceMs = performance.now() - started;
    const outputName = embeddingOutputName;
    const vector = poolLastToken(results[outputName], mask, manifest.dimension);
    const tokenCount = Array.from(mask.data, asNumber).filter((value) => value > 0).length;
    return { vector, tokenCount, inferenceMs, outputName, outputShape: results[outputName].dims };
  }

  return {
    embed,
    loadMs,
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    manifest,
    modelPath: resolvedModelPath,
    threads,
    maxTokens,
    async release() {
      await session.release();
    },
  };
}

export function l2Norm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}
