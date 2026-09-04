#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/common.sh"

docker_compose down --remove-orphans
echo "NodeRag testbed stopped. The database volume was preserved."
