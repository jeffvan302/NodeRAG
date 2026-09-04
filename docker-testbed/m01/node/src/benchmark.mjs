import fs from "node:fs/promises";
import path from "node:path";
import { createEmbedder } from "./model.mjs";

async function readText(filePath) {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function percentile(sorted, fraction) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

const modelRoot = process.env.NODERAG_M01_MODEL_ROOT;
const variants = (process.env.NODERAG_M01_BENCHMARK_MODELS ?? "q8-avx2=onnx/model_quint8_avx2.onnx")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [name, relativePath] = entry.split("=", 2);
    return { name, modelPath: path.resolve(modelRoot, relativePath) };
  });
const threads = (process.env.NODERAG_M01_BENCHMARK_THREADS ?? "1,2,3,4,5,6,7,8,9,10,11,12")
  .split(",")
  .map(Number)
  .filter((value) => Number.isInteger(value) && value > 0);
const sequenceLengths = [256, 512, 1024];
const repetitions = Number(process.env.NODERAG_M01_BENCHMARK_REPETITIONS ?? 3);
const results = [];
const pressureBefore = {
  cpu: await readText("/proc/pressure/cpu"),
  memory: await readText("/proc/pressure/memory"),
  io: await readText("/proc/pressure/io"),
};

for (const variant of variants) {
  await fs.access(variant.modelPath);
  for (const threadCount of threads) {
    const embedder = await createEmbedder({ modelRoot, modelPath: variant.modelPath, threads: threadCount, maxTokens: 1024 });
    for (const maxTokens of sequenceLengths) {
      const text = "maintenance procedure inspection schedule archive search ".repeat(maxTokens * 2);
      await embedder.embed(text, { tokenLimit: maxTokens });
      const samples = [];
      let tokenCount = 0;
      let peakRssBytes = process.memoryUsage().rss;
      const cpuStarted = process.cpuUsage();
      const wallStarted = performance.now();
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const measurement = await embedder.embed(text, { tokenLimit: maxTokens });
        samples.push(measurement.inferenceMs);
        tokenCount = measurement.tokenCount;
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      }
      const wallMs = performance.now() - wallStarted;
      const cpuUsage = process.cpuUsage(cpuStarted);
      const cpuMs = (cpuUsage.user + cpuUsage.system) / 1000;
      samples.sort((left, right) => left - right);
      results.push({
        variant: variant.name,
        threads: threadCount,
        requestedMaxTokens: maxTokens,
        actualTokens: tokenCount,
        repetitions,
        loadMs: embedder.loadMs,
        p50Ms: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        minMs: samples[0],
        maxMs: samples.at(-1),
        peakRssBytes,
        cpuMs,
        wallMs,
        averageCpuCores: cpuMs / wallMs,
      });
    }
    await embedder.release();
  }
}

const pressureAfter = {
  cpu: await readText("/proc/pressure/cpu"),
  memory: await readText("/proc/pressure/memory"),
  io: await readText("/proc/pressure/io"),
};

console.log(
  JSON.stringify(
    {
      node: process.version,
      architecture: process.arch,
      provisional: true,
      dsmBenchmarkRequired: true,
      pressureBefore,
      pressureAfter,
      results,
      passed: results.length === variants.length * threads.length * sequenceLengths.length,
    },
    null,
    2,
  ),
);
