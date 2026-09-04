#!/usr/bin/env bash
set -euo pipefail

patterns='(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{36,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)'
if git grep -I -n -E "${patterns}" -- ':!docs/RailwayRagDocs/**'; then
  echo "A tracked file matches a high-confidence credential pattern." >&2
  exit 1
fi

for forbidden in .env .env.local docker-testbed/.secrets/postgres_password; do
  if git ls-files --error-unmatch "${forbidden}" >/dev/null 2>&1; then
    echo "Forbidden secret-bearing path is tracked: ${forbidden}" >&2
    exit 1
  fi
done
echo "Tracked-file secret and forbidden-path checks passed."
