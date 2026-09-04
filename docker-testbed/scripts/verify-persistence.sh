#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/common.sh"

marker="m00-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}"

docker_compose exec -T postgres sh -ec \
  'psql -v ON_ERROR_STOP=1 -v marker="$1" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' sh "${marker}" <<'SQL'
CREATE SCHEMA IF NOT EXISTS noderag_testbed;
CREATE TABLE IF NOT EXISTS noderag_testbed.persistence_probe (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  marker text NOT NULL
);
INSERT INTO noderag_testbed.persistence_probe (singleton, marker)
VALUES (true, :'marker')
ON CONFLICT (singleton) DO UPDATE SET marker = EXCLUDED.marker;
SQL

docker_compose stop postgres
# Reconcile the service through `up` instead of issuing a one-shot `start`.
# On loaded CI hosts, Docker can report a successful start while a stop event is
# still settling; `up -d` reasserts the desired running state before the
# readiness probe below.
docker_compose up -d postgres
bash "${script_dir}/verify.sh"

actual_marker="$(
  docker_compose exec -T postgres sh -ec \
    'psql -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT marker FROM noderag_testbed.persistence_probe WHERE singleton = true"'
)"

if [[ "${actual_marker}" != "${marker}" ]]; then
  echo "Database persistence probe failed." >&2
  exit 1
fi

echo "NodeRag testbed persistence passed across a PostgreSQL stop/start cycle."
