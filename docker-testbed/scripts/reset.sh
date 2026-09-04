#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/common.sh"

if [[ "${1:-}" != "--confirm-destroy-test-data" ]]; then
  echo "This deletes only the Docker testbed containers and database volume." >&2
  echo "Re-run with --confirm-destroy-test-data to continue." >&2
  exit 2
fi

docker_compose down --volumes --remove-orphans
echo "NodeRag testbed containers and database volume were removed."
