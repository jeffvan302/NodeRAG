#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/common.sh"

bash "${script_dir}/bootstrap.sh"
docker_compose up -d
bash "${script_dir}/verify.sh"
