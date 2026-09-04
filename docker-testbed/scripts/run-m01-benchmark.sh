#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
testbed_dir="$(cd -- "${script_dir}/.." && pwd)"
artifact_dir="${testbed_dir}/artifacts/m01"
artifact_file="${artifact_dir}/benchmark.json"

mkdir -p -- "${artifact_dir}"
bash "${script_dir}/fetch-m01-models.sh" --benchmarks
bash "${script_dir}/build-m01-node.sh"
bash "${script_dir}/run-m01-node.sh" benchmark.mjs \
  -e "NODERAG_M01_BENCHMARK_MODELS=q8-avx2=onnx/model_quint8_avx2.onnx,q4f16=onnx/model_q4f16.onnx,fp16=onnx/model_fp16.onnx" \
  -e "NODERAG_M01_BENCHMARK_THREADS=1,2,3,4,5,6,7,8,9,10,11,12" \
  -e "NODERAG_M01_BENCHMARK_REPETITIONS=${NODERAG_M01_BENCHMARK_REPETITIONS:-3}" \
  >"${artifact_file}"

python3 - "${artifact_file}" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    result = json.load(stream)
expected_variants = {"q8-avx2", "q4f16", "fp16"}
expected_threads = set(range(1, 13))
expected_tokens = {256, 512, 1024}
rows = result.get("results", [])
assert result.get("passed") is True
assert len(rows) == len(expected_variants) * len(expected_threads) * len(expected_tokens)
assert {row["variant"] for row in rows} == expected_variants
assert {row["threads"] for row in rows} == expected_threads
assert {row["actualTokens"] for row in rows} == expected_tokens
assert all(row["peakRssBytes"] < 8 * 1024**3 for row in rows)
print(f"Validated {len(rows)} benchmark cells in {sys.argv[1]}.")
PY
