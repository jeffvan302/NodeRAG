#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture_root="$(cd -- "${script_dir}/../../fixtures/formats" && pwd)"
catalog="${fixture_root}/fixture-catalog.json"

python3 - "${fixture_root}" "${catalog}" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
with open(sys.argv[2], encoding="utf-8") as stream:
    catalog = json.load(stream)
assert catalog["privacy"] == "synthetic non-private fixtures only"
listed = set()
for item in catalog["fixtures"]:
    relative = Path(item["path"])
    assert not relative.is_absolute() and ".." not in relative.parts
    path = (root / relative).resolve()
    assert path.is_relative_to(root) and path.is_file()
    data = path.read_bytes()
    assert len(data) == item["sizeBytes"], item["path"]
    assert hashlib.sha256(data).hexdigest() == item["sha256"], item["path"]
    listed.add(relative.as_posix())
actual = {
    path.relative_to(root).as_posix()
    for path in root.rglob("*")
    if path.is_file() and path.name != "fixture-catalog.json"
}
assert listed == actual, {"unlisted": sorted(actual - listed), "missing": sorted(listed - actual)}
print(f"Verified {len(listed)} synthetic M01 fixtures and SHA-256 digests.")
PY
