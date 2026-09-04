import { createEmbedder, l2Norm } from "./model.mjs";

const embedder = await createEmbedder();
const queryText = `${embedder.manifest.queryPrefix}How are maintenance costs tracked?`;
const first = await embedder.embed(queryText);
const second = await embedder.embed(queryText);
const document = await embedder.embed("Maintenance costs are recorded by quarter and category.");

const maxRepeatDelta = first.vector.reduce(
  (maximum, value, index) => Math.max(maximum, Math.abs(value - second.vector[index])),
  0,
);
const allFinite = [...first.vector, ...document.vector].every(Number.isFinite);
const result = {
  node: process.version,
  architecture: process.arch,
  platform: process.platform,
  onnxRuntimeInputs: embedder.inputNames,
  onnxRuntimeOutputs: embedder.outputNames,
  modelPath: embedder.modelPath,
  modelRevision: embedder.manifest.sourceRevision,
  dimension: first.vector.length,
  queryTokens: first.tokenCount,
  documentTokens: document.tokenCount,
  loadMs: embedder.loadMs,
  firstInferenceMs: first.inferenceMs,
  repeatInferenceMs: second.inferenceMs,
  documentInferenceMs: document.inferenceMs,
  queryL2Norm: l2Norm(first.vector),
  documentL2Norm: l2Norm(document.vector),
  maxRepeatDelta,
  allFinite,
  outputName: first.outputName,
  outputShape: first.outputShape,
  passed:
    first.vector.length === embedder.manifest.dimension &&
    document.vector.length === embedder.manifest.dimension &&
    allFinite &&
    Math.abs(l2Norm(first.vector) - 1) < 1e-5 &&
    Math.abs(l2Norm(document.vector) - 1) < 1e-5 &&
    maxRepeatDelta < 1e-6,
};

console.log(JSON.stringify(result, null, 2));
if (!result.passed) {
  process.exitCode = 1;
}
