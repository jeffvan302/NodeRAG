#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/../.." && pwd)"
source "${script_dir}/common.sh"
action="${1:-status}"
artifact="${2:-${repository_root}/spk/artifacts/noderag-1.0.0-45-x86_64.spk}"
container="noderag-m14-soak-rc1"
volume="noderag-m14-soak-rc1-data"
evidence_directory="${repository_root}/docker-testbed/artifacts/m14"

case "${action}" in
  start|validate)
    [[ -f "${artifact}" ]] || { echo "M14 SPK candidate not found: ${artifact}" >&2; exit 66; }
    if "${docker_command[@]}" container inspect "${container}" >/dev/null 2>&1; then
      echo "The M14 soak container already exists; inspect or stop it before starting another." >&2
      exit 65
    fi
    mkdir -p -- "${evidence_directory}"
    artifact_directory="$(cd -- "$(dirname -- "${artifact}")" && pwd)"
    artifact_mount="${artifact_directory}"
    simulator_mount="${repository_root}/scripts"
    evidence_mount="${evidence_directory}"
    if [[ "${docker_transport}" == "windows-cli-interop" ]]; then
      artifact_mount="$(wslpath -w "${artifact_directory}")"
      simulator_mount="$(wslpath -w "${repository_root}/scripts")"
      evidence_mount="$(wslpath -w "${evidence_directory}")"
    fi
    artifact_sha256="$(sha256sum "${artifact}" | awk '{print $1}')"
    if [[ "${action}" == "validate" ]]; then
      soak_duration_seconds=90
      soak_interval_seconds=5
      allow_short=1
    else
      soak_duration_seconds="${NODERAG_M14_DURATION_SECONDS:-3600}"
      soak_interval_seconds="${NODERAG_M14_INTERVAL_SECONDS:-60}"
      allow_short="${NODERAG_M14_ALLOW_SHORT:-0}"
    fi
    "${docker_command[@]}" volume create "${volume}" >/dev/null
    "${docker_command[@]}" run --rm --mount "type=volume,source=${volume},target=/volume1" \
      alpine@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1 \
      sh -c 'mkdir -p /volume1/NodeRag && chown -R 1000:1000 /volume1/NodeRag && chmod 700 /volume1/NodeRag'
    "${docker_command[@]}" run --detach --name "${container}" --platform linux/amd64 \
      --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges \
      --tmpfs /work:rw,exec,uid=1000,gid=1000,mode=0700 \
      --mount "type=volume,source=${volume},target=/volume1" \
      --mount "type=bind,source=${artifact_mount},target=/input,readonly" \
      --mount "type=bind,source=${simulator_mount},target=/simulator,readonly" \
      --mount "type=bind,source=${evidence_mount},target=/evidence" \
      -e "NODERAG_SPK_INPUT=/input/$(basename -- "${artifact}")" \
      -e "NODERAG_M14_ARTIFACT_SHA256=${artifact_sha256}" \
      -e "NODERAG_M14_DURATION_SECONDS=${soak_duration_seconds}" \
      -e "NODERAG_M14_INTERVAL_SECONDS=${soak_interval_seconds}" \
      -e "NODERAG_M14_ALLOW_SHORT=${allow_short}" \
      node@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 \
      bash /simulator/in-container-m14-soak.sh
    echo "Started the M14 soak container ${container}."
    ;;
  status)
    "${docker_command[@]}" container inspect --format '{{.State.Status}} exit={{.State.ExitCode}} started={{.State.StartedAt}} finished={{.State.FinishedAt}}' "${container}"
    if [[ -f "${evidence_directory}/m14-soak-live.json" ]]; then
      node -e 'const p=require(process.argv[1]); console.log(JSON.stringify({startedAt:p.startedAt,completedAt:p.completedAt,passed:p.passed,failures:p.failures,workload:p.workload,samples:p.samples.length},null,2))' "${evidence_directory}/m14-soak-live.json"
    fi
    ;;
  logs)
    "${docker_command[@]}" logs --tail "${NODERAG_M14_LOG_LINES:-200}" "${container}"
    ;;
  stop)
    "${docker_command[@]}" container rm -f "${container}" >/dev/null 2>&1 || true
    echo "Stopped the M14 soak container. The evidence and disposable data volume were retained."
    ;;
  *)
    echo "Usage: bash docker-testbed/scripts/m14-soak.sh start|validate|status|logs|stop [artifact]" >&2
    exit 64
    ;;
esac
