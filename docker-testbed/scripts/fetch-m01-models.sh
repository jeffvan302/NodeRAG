#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
testbed_dir="$(cd -- "${script_dir}/.." && pwd)"
manifest="${testbed_dir}/m01/model-manifest.json"
model_root="${testbed_dir}/runtime/models/qwen3-embedding-0.6b/bd58e9fd4b0467770da53678d8da25481c0f959b"
include_benchmarks=false
if [[ "${1:-}" == "--benchmarks" ]]; then
  include_benchmarks=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--benchmarks]" >&2
  exit 2
fi

command -v curl >/dev/null 2>&1 || {
  echo "curl is required to fetch pinned M01 model artifacts." >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "python3 is required to parse the M01 model manifest." >&2
  exit 1
}

mkdir -p -- "${model_root}"

python3 - "${manifest}" <<'PY' | while IFS=$'\t' read -r relative_path size_bytes sha256 url; do
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    manifest = json.load(stream)
for item in manifest["files"]:
    if item.get("required"):
        print(item["path"], item["sizeBytes"], item["sha256"], item["url"], sep="\t")
PY
  destination="${model_root}/${relative_path}"
  mkdir -p -- "$(dirname -- "${destination}")"
  if [[ -f "${destination}" ]]; then
    actual_size="$(stat -c '%s' "${destination}")"
    actual_sha="$(sha256sum "${destination}" | cut -d' ' -f1)"
    if [[ "${actual_size}" == "${size_bytes}" && "${actual_sha}" == "${sha256}" ]]; then
      echo "Verified cached ${relative_path}."
      continue
    fi
  fi

  echo "Fetching pinned ${relative_path} (${size_bytes} bytes)."
  curl --location --fail --retry 5 --retry-delay 2 --continue-at - --output "${destination}" "${url}"
  actual_size="$(stat -c '%s' "${destination}")"
  actual_sha="$(sha256sum "${destination}" | cut -d' ' -f1)"
  [[ "${actual_size}" == "${size_bytes}" ]] || {
    echo "Size verification failed for ${relative_path}." >&2
    exit 1
  }
  [[ "${actual_sha}" == "${sha256}" ]] || {
    echo "SHA-256 verification failed for ${relative_path}." >&2
    exit 1
  }
done

if [[ "${include_benchmarks}" == "true" ]]; then
  python3 - "${manifest}" <<'PY' | while IFS=$'\t' read -r relative_path size_bytes sha256 url; do
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    manifest = json.load(stream)
for item in manifest["benchmarkCandidates"]:
    print(item["path"], item["sizeBytes"], item["sha256"], item["url"], sep="\t")
    if item.get("externalDataPath"):
        print(
            item["externalDataPath"],
            item["externalDataSizeBytes"],
            item["externalDataSha256"],
            item["externalDataUrl"],
            sep="\t",
        )
PY
    destination="${model_root}/${relative_path}"
    mkdir -p -- "$(dirname -- "${destination}")"
    if [[ -f "${destination}" ]]; then
      actual_size="$(stat -c '%s' "${destination}")"
      actual_sha="$(sha256sum "${destination}" | cut -d' ' -f1)"
      if [[ "${actual_size}" == "${size_bytes}" && "${actual_sha}" == "${sha256}" ]]; then
        echo "Verified cached ${relative_path}."
        continue
      fi
    fi

    echo "Fetching pinned benchmark artifact ${relative_path} (${size_bytes} bytes)."
    curl --location --fail --retry 5 --retry-delay 2 --continue-at - --output "${destination}" "${url}"
    actual_size="$(stat -c '%s' "${destination}")"
    actual_sha="$(sha256sum "${destination}" | cut -d' ' -f1)"
    [[ "${actual_size}" == "${size_bytes}" ]] || {
      echo "Size verification failed for ${relative_path}." >&2
      exit 1
    }
    [[ "${actual_sha}" == "${sha256}" ]] || {
      echo "SHA-256 verification failed for ${relative_path}." >&2
      exit 1
    }
  done
fi

echo "Pinned M01 Qwen artifacts are present and verified."
