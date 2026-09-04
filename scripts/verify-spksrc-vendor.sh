#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/.." && pwd)"
vendor="${repository_root}/spk/vendor/spksrc"
expected="1f638f9f331d881b2fd5cb45bb24071e9f723400"

[[ -d "${vendor}/.git" || -f "${vendor}/.git" ]] || {
  echo "spksrc submodule is absent; run git submodule update --init --depth 1." >&2
  exit 66
}
actual="$(git -C "${vendor}" rev-parse HEAD)"
[[ "${actual}" == "${expected}" ]] || {
  echo "spksrc pin mismatch: expected ${expected}, got ${actual}" >&2
  exit 1
}
# The Windows checkout uses autocrlf while this verifier runs through WSL.
# Normalize both LF and CRLF worktrees before deciding whether source changed.
[[ -z "$(git -c core.autocrlf=true -C "${vendor}" status --short)" ]] || {
  echo "spksrc submodule has local changes." >&2
  exit 1
}
grep -q "${expected}" "${repository_root}/docker-testbed/m01/spksrc-pin.json"
echo "Vendored spksrc submodule matches the Milestone 1 pin."
