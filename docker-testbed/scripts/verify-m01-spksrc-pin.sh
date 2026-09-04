#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
testbed_dir="$(cd -- "${script_dir}/.." && pwd)"
pin_file="${testbed_dir}/m01/spksrc-pin.json"
repo_dir="${testbed_dir}/runtime/spksrc"
commit="1f638f9f331d881b2fd5cb45bb24071e9f723400"

if [[ ! -d "${repo_dir}/.git" ]]; then
  mkdir -p -- "${repo_dir}"
  git -C "${repo_dir}" init --quiet
  git -C "${repo_dir}" remote add origin https://github.com/SynoCommunity/spksrc.git
  git -C "${repo_dir}" fetch --quiet --depth=1 origin "${commit}"
  git -C "${repo_dir}" checkout --quiet --detach FETCH_HEAD
fi

[[ "$(git -C "${repo_dir}" rev-parse HEAD)" == "${commit}" ]]

python3 - "${pin_file}" "${repo_dir}" <<'PY'
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    pin = json.load(stream)
root = Path(sys.argv[2])
for recipe in pin["recipes"]:
    def blob(name):
        return subprocess.check_output(
            ["git", "-C", str(root), "show", f"{pin['commit']}:{recipe['path']}/{name}"]
        )
    makefile = blob("Makefile")
    digests = blob("digests")
    assert hashlib.sha256(makefile).hexdigest() == recipe["makefileSha256"]
    assert hashlib.sha256(digests).hexdigest() == recipe["digestsFileSha256"]
    version_match = re.search(r"^PKG_VERS\s*=\s*(\S+)", makefile.decode(), re.MULTILINE)
    assert version_match and version_match.group(1) == recipe["version"]
    assert recipe["sourceSha256"] in digests.decode()
print(f"Verified {len(pin['recipes'])} recipes at spksrc {pin['commit']}.")
PY
