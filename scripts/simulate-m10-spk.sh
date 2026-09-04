#!/usr/bin/env bash
set -euo pipefail

m10_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${m10_script_dir}/.." && pwd)"
source "${repository_root}/docker-testbed/scripts/common.sh"
artifact="${1:-${repository_root}/spk/artifacts/noderag-0.2.0-1-x86_64-production.spk}"
[[ -f "${artifact}" ]] || exit 66
artifact_directory="$(cd -- "$(dirname -- "${artifact}")" && pwd)"
artifact_mount="${artifact_directory}"
simulator_mount="${m10_script_dir}"
fixtures_mount="${repository_root}/fixtures/formats"
if [[ "${docker_transport}" == "windows-cli-interop" ]]; then
  artifact_mount="$(wslpath -w "${artifact_directory}")"
  simulator_mount="$(wslpath -w "${m10_script_dir}")"
  fixtures_mount="$(wslpath -w "${repository_root}/fixtures/formats")"
fi
suffix="$$-${RANDOM}"
volume="noderag-m10-volume-${suffix}"
cleanup() { "${docker_command[@]}" volume rm -f "${volume}" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"${docker_command[@]}" volume create "${volume}" >/dev/null
"${docker_command[@]}" run --rm --mount "type=volume,source=${volume},target=/volume1" \
  alpine@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1 \
  sh -c 'mkdir -p /volume1/NodeRag && chown -R 1000:1000 /volume1/NodeRag && chmod 700 /volume1/NodeRag'
"${docker_command[@]}" run --rm --platform linux/amd64 --user 1000:1000 --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /work:rw,exec,uid=1000,gid=1000,mode=0700 \
  --mount "type=volume,source=${volume},target=/volume1" \
  --mount "type=bind,source=${artifact_mount},target=/input,readonly" \
  --mount "type=bind,source=${simulator_mount},target=/simulator,readonly" \
  --mount "type=bind,source=${fixtures_mount},target=/fixtures,readonly" \
  -e "NODERAG_SPK_INPUT=/input/$(basename -- "${artifact}")" \
  -e NODERAG_SIMULATOR=1 -e NODERAG_PREFLIGHT_MEMORY_KIB=8388608 \
  -e NODERAG_MIN_DISK_KIB=1024 -e NODERAG_TEST_EMBEDDER=1 \
  -e NODERAG_SOURCE_ROOTS=/work/watch-base \
  -e NODERAG_MODEL_IMPORT_ROOTS=/work/watch-base \
  -e NODERAG_STORAGE_REBUILD_RESERVE_BYTES=0 \
  node@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 \
  bash /simulator/in-container-m02-spk-sim.sh
