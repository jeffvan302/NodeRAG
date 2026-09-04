#!/usr/bin/env bash
set -euo pipefail

m02_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${m02_script_dir}/.." && pwd)"
source "${repository_root}/docker-testbed/scripts/common.sh"
artifact="${1:-${repository_root}/spk/artifacts/noderag-0.2.0-1-x86_64.spk}"
[[ -f "${artifact}" ]] || { echo "Thin SPK not found: ${artifact}" >&2; exit 66; }

artifact_directory="$(cd -- "$(dirname -- "${artifact}")" && pwd)"
artifact_name="$(basename -- "${artifact}")"
artifact_mount="${artifact_directory}"
simulator_mount="${m02_script_dir}"
if [[ "${docker_transport}" == "windows-cli-interop" ]]; then
  artifact_mount="$(wslpath -w "${artifact_directory}")"
  simulator_mount="$(wslpath -w "${m02_script_dir}")"
fi

"${docker_command[@]}" run --rm --platform linux/amd64 \
  --user 1000:1000 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network none \
  --tmpfs /work:rw,exec,uid=1000,gid=1000,mode=0700 \
  --mount "type=bind,source=${artifact_mount},target=/input,readonly" \
  --mount "type=bind,source=${simulator_mount},target=/simulator,readonly" \
  -e "NODERAG_SPK_INPUT=/input/${artifact_name}" \
  node@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 \
  bash /simulator/in-container-m02-spk-sim.sh
