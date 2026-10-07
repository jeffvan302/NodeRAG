#!/usr/bin/env bash
set -euo pipefail

upgrade_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${upgrade_script_dir}/.." && pwd)"
source "${repository_root}/docker-testbed/scripts/common.sh"
old_artifact="${1:-${repository_root}/spk/artifacts/noderag-1.0.0-26-x86_64.spk}"
new_artifact="${2:-${repository_root}/spk/artifacts/noderag-1.0.0-46-x86_64.spk}"
[[ -f "${old_artifact}" ]] || { echo "Revision 26 SPK is missing: ${old_artifact}" >&2; exit 66; }
[[ -f "${new_artifact}" ]] || { echo "Revision 46 SPK is missing: ${new_artifact}" >&2; exit 66; }

old_directory="$(cd -- "$(dirname -- "${old_artifact}")" && pwd)"
new_directory="$(cd -- "$(dirname -- "${new_artifact}")" && pwd)"
simulator_mount="${upgrade_script_dir}"
old_mount="${old_directory}"
new_mount="${new_directory}"
if [[ "${docker_transport}" == "windows-cli-interop" ]]; then
  simulator_mount="$(wslpath -w "${upgrade_script_dir}")"
  old_mount="$(wslpath -w "${old_directory}")"
  new_mount="$(wslpath -w "${new_directory}")"
fi

suffix="$$-${RANDOM}"
volume="noderag-c11-upgrade-${suffix}"
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
  --mount "type=bind,source=${old_mount},target=/old,readonly" \
  --mount "type=bind,source=${new_mount},target=/new,readonly" \
  --mount "type=bind,source=${simulator_mount},target=/simulator,readonly" \
  -e "NODERAG_OLD_SPK=/old/$(basename -- "${old_artifact}")" \
  -e "NODERAG_NEW_SPK=/new/$(basename -- "${new_artifact}")" \
  -e NODERAG_SIMULATOR=1 -e NODERAG_PREFLIGHT_MEMORY_KIB=8388608 \
  -e NODERAG_MIN_DISK_KIB=1024 -e NODERAG_TEST_EMBEDDER=1 \
  -e NODERAG_STORAGE_REBUILD_RESERVE_BYTES=0 \
  node@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 \
  bash /simulator/in-container-c11-upgrade.sh
