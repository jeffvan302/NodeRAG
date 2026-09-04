#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
testbed_dir="$(cd -- "${script_dir}/.." && pwd)"
source "${script_dir}/common.sh"

spksrc_commit="1f638f9f331d881b2fd5cb45bb24071e9f723400"
spksrc_image="ghcr.io/synocommunity/spksrc@sha256:31b66390e2357d5ab0be8c2e521dbc658a44afdfd50eb2e10346e5539f4e9811"
spksrc_volume="noderag-m01-spksrc-1f638f9f"
artifact_dir="${testbed_dir}/artifacts/m01/spksrc"
mkdir -p -- "${artifact_dir}"

artifact_mount="${artifact_dir}"
if [[ "${docker_transport}" == "windows-cli-interop" ]]; then
  artifact_mount="$(wslpath -w "${artifact_dir}")"
fi

"${docker_command[@]}" volume inspect "${spksrc_volume}" >/dev/null 2>&1 || \
  "${docker_command[@]}" volume create "${spksrc_volume}" >/dev/null

build_log="${artifact_dir}/build.log"
if ! "${docker_command[@]}" run --rm --platform linux/amd64 \
  --mount "type=volume,source=${spksrc_volume},target=/spksrc" \
  --mount "type=bind,source=${artifact_mount},target=/evidence" \
  --workdir /spksrc \
  -e "SPKSRC_COMMIT=${spksrc_commit}" \
  -e "SPKSRC_IMAGE=${spksrc_image}" \
  "${spksrc_image}" bash -lc '
    set -euo pipefail
    if [[ ! -d .git ]]; then
      git clone --filter=blob:none https://github.com/SynoCommunity/spksrc.git .
      git checkout --detach "${SPKSRC_COMMIT}"
    fi
    [[ "$(git rev-parse HEAD)" == "${SPKSRC_COMMIT}" ]]
    [[ -z "$(git status --short)" ]]
    make setup
    make -C cross/postgresql ARCH=x64 TCVERSION=7.2
    make -C cross/pgvector ARCH=x64 TCVERSION=7.2
    {
      git rev-parse HEAD
      grep -E "^(PKG_NAME|PKG_VERS|PKG_SHA256)" cross/postgresql/Makefile cross/pgvector/Makefile
      while IFS= read -r -d "" artifact; do
        printf "ARTIFACT %s\n" "${artifact}"
        file "${artifact}"
        sha256sum "${artifact}"
        if file "${artifact}" | grep -q "ELF"; then
          readelf -d "${artifact}" || true
        fi
      done < <(find cross/postgresql/work-x64-7.2 cross/pgvector/work-x64-7.2 \
        -type f \( -name postgres -o -name pg_config -o -name vector.so \) -print0 | sort -z)
    } > /evidence/artifact-manifest.txt
    python3 - <<PY
import json
from pathlib import Path

manifest = Path("/evidence/artifact-manifest.txt").read_text(encoding="utf-8")
Path("/evidence/summary.json").write_text(json.dumps({
    "spksrcCommit": "${SPKSRC_COMMIT}",
    "builderImage": "${SPKSRC_IMAGE}",
    "architecture": "x64",
    "toolchainVersion": "7.2",
    "postgresRecipe": "17.11",
    "pgvectorRecipe": "0.8.6",
    "artifactManifestPresent": "vector.so" in manifest and "postgres" in manifest,
    "passed": "vector.so" in manifest and "postgres" in manifest,
}, indent=2) + "\n", encoding="utf-8")
PY
  ' >"${build_log}" 2>&1; then
  tail -n 200 "${build_log}" >&2
  exit 1
fi
tail -n 80 "${build_log}"

python3 - "${artifact_dir}/summary.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    result = json.load(stream)
assert result.get("passed") is True
print("Pinned spksrc PostgreSQL and pgvector cross-builds passed.")
PY
