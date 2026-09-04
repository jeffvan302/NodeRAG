#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/common.sh"

docker_compose --profile m01 run --rm --no-deps m01-node src/probe-storage.mjs
