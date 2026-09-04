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
fixtures_mount="${repository_root}/fixtures/formats"
if [[ "${docker_transport}" == "windows-cli-interop" ]]; then
  artifact_mount="$(wslpath -w "${artifact_directory}")"
  simulator_mount="$(wslpath -w "${m02_script_dir}")"
  fixtures_mount="$(wslpath -w "${repository_root}/fixtures/formats")"
fi

simulation_suffix="$$-${RANDOM}"
network_name="noderag-m05-${simulation_suffix}"
database_name="noderag-m05-db-${simulation_suffix}"
database_password="m05-package-simulation-only"
cleanup_simulation() {
  "${docker_command[@]}" rm -f "${database_name}" >/dev/null 2>&1 || true
  "${docker_command[@]}" network rm "${network_name}" >/dev/null 2>&1 || true
}
trap cleanup_simulation EXIT
"${docker_command[@]}" network create "${network_name}" >/dev/null
"${docker_command[@]}" run -d --name "${database_name}" --network "${network_name}" \
  -e POSTGRES_DB=noderag_package -e POSTGRES_USER=noderag -e POSTGRES_PASSWORD="${database_password}" \
  pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f \
  >/dev/null
for _ in $(seq 1 60); do
  if "${docker_command[@]}" exec "${database_name}" pg_isready -U noderag -d noderag_package >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
"${docker_command[@]}" exec "${database_name}" pg_isready -U noderag -d noderag_package >/dev/null

"${docker_command[@]}" run --rm --platform linux/amd64 \
  --user 1000:1000 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network "${network_name}" \
  --tmpfs /work:rw,exec,uid=1000,gid=1000,mode=0700 \
  --mount "type=bind,source=${artifact_mount},target=/input,readonly" \
  --mount "type=bind,source=${simulator_mount},target=/simulator,readonly" \
  --mount "type=bind,source=${fixtures_mount},target=/fixtures,readonly" \
  -e "NODERAG_SPK_INPUT=/input/${artifact_name}" \
  -e "NODERAG_PACKAGE_DB_HOST=${database_name}" \
  -e "NODERAG_PACKAGE_DB_PASSWORD=${database_password}" \
  -e NODERAG_TEST_EMBEDDER=1 \
  -e NODERAG_SOURCE_ROOTS=/work/watch-base \
  node@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 \
  bash /simulator/in-container-m02-spk-sim.sh
