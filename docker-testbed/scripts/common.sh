#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
testbed_dir="$(cd -- "${script_dir}/.." && pwd)"
compose_project_dir="${testbed_dir}"
compose_file="${testbed_dir}/compose.yaml"
docker_command=(docker)
docker_transport="native-wsl"

if ! docker info >/dev/null 2>&1; then
  if command -v docker.exe >/dev/null 2>&1 && docker.exe info >/dev/null 2>&1; then
    command -v wslpath >/dev/null 2>&1 || {
      echo "Docker Desktop interop requires wslpath." >&2
      exit 1
    }
    docker_command=(docker.exe)
    docker_transport="windows-cli-interop"
    compose_project_dir="$(wslpath -w "${testbed_dir}")"
    compose_file="$(wslpath -w "${compose_file}")"
  else
    echo "No reachable Docker engine was found from WSL." >&2
    echo "Enable Docker Desktop WSL integration or make docker.exe available through WSL interop." >&2
    exit 1
  fi
fi

docker_compose() {
  "${docker_command[@]}" compose --project-directory "${compose_project_dir}" -f "${compose_file}" "$@"
}
