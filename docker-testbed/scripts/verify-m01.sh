#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
testbed_dir="$(cd -- "${script_dir}/.." && pwd)"
artifact_dir="${testbed_dir}/artifacts/m01"
full=false
if [[ "${1:-}" == "--full" ]]; then
  full=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--full]" >&2
  exit 2
fi

mkdir -p -- "${artifact_dir}"
bash "${script_dir}/up.sh"
bash "${script_dir}/fetch-m01-models.sh"
bash "${script_dir}/build-m01-node.sh"
bash "${script_dir}/verify-m01-fixtures.sh"
bash "${script_dir}/verify-m01-spksrc-pin.sh"
bash "${script_dir}/verify-pgvector-1024.sh" >"${artifact_dir}/pgvector.json"
bash "${script_dir}/probe-m01-storage.sh" >"${artifact_dir}/storage.json"

for probe in \
  inventory-container.mjs \
  validate-dsm-contracts.mjs \
  simulate-lifecycle.mjs \
  probe-argon2.mjs \
  probe-extraction.mjs \
  probe-ollama.mjs \
  probe-onnx.mjs \
  probe-second-session.mjs; do
  bash "${script_dir}/run-m01-node.sh" "${probe}" >"${artifact_dir}/${probe%.mjs}.json"
done

python3 - "${artifact_dir}" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
files = sorted(root.glob("*.json"))
required = {
    "inventory-container.json",
    "pgvector.json",
    "probe-argon2.json",
    "probe-extraction.json",
    "probe-ollama.json",
    "probe-onnx.json",
    "probe-second-session.json",
    "simulate-lifecycle.json",
    "storage.json",
    "validate-dsm-contracts.json",
}
available = {path.name for path in files}
missing = required - available
assert not missing, f"Missing M01 results: {sorted(missing)}"
for path in files:
    if path.name == "benchmark.json":
        continue
    with path.open(encoding="utf-8") as stream:
        result = json.load(stream)
    assert result.get("passed") is True, f"M01 probe failed: {path.name}"
print(f"Validated {len(required)} required M01 probe results.")
PY

if [[ "${full}" == "true" ]]; then
  bash "${script_dir}/run-m01-benchmark.sh"
fi

echo "Milestone 1 Docker feasibility probes passed."
