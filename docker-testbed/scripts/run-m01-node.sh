#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/common.sh"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <probe-script> [compose run arguments...]" >&2
  exit 2
fi

probe_script="$1"
shift
docker_compose --profile m01 run --rm --no-deps "$@" m01-node "src/${probe_script}"
