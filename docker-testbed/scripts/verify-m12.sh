#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
testbed_dir="$(cd -- "${script_dir}/.." && pwd)"
repository_root="$(cd -- "${testbed_dir}/.." && pwd)"
source "${script_dir}/common.sh"
real=false
if [[ "${1:-}" == "--real" ]]; then
  real=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--real]" >&2
  exit 2
fi

cd -- "${repository_root}"
if [[ "${real}" == "true" ]]; then
  bash "${script_dir}/fetch-m01-models.sh" --benchmarks
  mkdir -p -- "${testbed_dir}/artifacts/m12"
  rm -f -- \
    "${testbed_dir}/artifacts/m12/m12-docker-q8.json" \
    "${testbed_dir}/artifacts/m12/m12-docker-q4.json"
  NODERAG_M12_MODEL_VARIANT=q8 NODERAG_M12_REPORT_NAME=unused.json \
    docker_compose --profile m12 \
      run --rm --no-deps \
        --env NODERAG_M12_MODEL_ROOT= \
        --env NODERAG_M12_REPORT= \
        m12-node evaluation:m12
  docker_compose --profile m12 \
      run --rm --no-deps \
        --env NODERAG_M12_MODEL_VARIANT=q8 \
        --env NODERAG_M12_REPORT=/artifacts/m12-docker-q8.json \
        m12-node exec vitest run --project integration \
        packages/server/test/m12-evaluation.integration.test.ts
  docker_compose --profile m12 \
      run --rm --no-deps \
        --env NODERAG_M12_MODEL_VARIANT=q4 \
        --env NODERAG_M12_REPORT=/artifacts/m12-docker-q4.json \
        m12-node exec vitest run --project integration \
        packages/server/test/m12-evaluation.integration.test.ts
  docker_compose --profile m12 \
    run --rm --no-deps \
      --env NODERAG_M12_MODEL_ROOT= \
      --env NODERAG_M12_REPORT= \
      m12-node exec node scripts/summarize-m12-evaluation.mjs \
        /artifacts/m12-docker-q8.json \
        /artifacts/m12-docker-q4.json
else
  node scripts/verify-m12-corpus.mjs
  pnpm exec vitest run --project unit \
    packages/server/test/evaluation.unit.test.ts \
    packages/server/test/retrieval.unit.test.ts
  pnpm exec vitest run --project integration \
    packages/server/test/m12-evaluation.integration.test.ts \
    packages/server/test/retrieval-diagnostics.integration.test.ts
fi

echo "Milestone 12 corpus, metrics, locator, ANN, RLS, and evaluation gates passed."
