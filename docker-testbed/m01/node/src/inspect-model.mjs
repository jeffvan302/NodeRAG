import path from "node:path";
import * as ort from "onnxruntime-node";

const modelRoot = process.env.NODERAG_M01_MODEL_ROOT;
const paths = (process.env.NODERAG_M01_INSPECT_MODELS ?? "onnx/model_q4f16.onnx,onnx/model_fp16.onnx")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const results = [];
for (const relativePath of paths) {
  const session = await ort.InferenceSession.create(path.resolve(modelRoot, relativePath), {
    executionProviders: ["cpu"],
  });
  results.push({
    path: relativePath,
    inputNames: session.inputNames,
    inputMetadata: session.inputMetadata,
    outputNames: session.outputNames,
    outputMetadata: session.outputMetadata,
  });
  await session.release();
}
console.log(JSON.stringify(results, null, 2));
