#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/common.sh"

for attempt in $(seq 1 30); do
  if docker_compose exec -T postgres sh -ec 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    break
  fi

  if [[ "${attempt}" == "30" ]]; then
    echo "PostgreSQL did not become ready within the test window." >&2
    docker_compose logs --no-color postgres >&2
    exit 1
  fi

  sleep 2
done

docker_compose exec -T postgres sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'pgvector extension is not installed';
  END IF;
END
$$;

CREATE TEMP TABLE noderag_testbed_probe (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  embedding halfvec(3) NOT NULL
);

INSERT INTO noderag_testbed_probe (embedding) VALUES ('[1,2,3]');

DO $$
DECLARE
  distance double precision;
BEGIN
  SELECT embedding <=> '[1,2,3]'::halfvec
    INTO distance
    FROM noderag_testbed_probe
    LIMIT 1;

  IF distance IS NULL OR abs(distance) > 0.000001 THEN
    RAISE EXCEPTION 'halfvec similarity probe failed: %', distance;
  END IF;
END
$$;
SQL

echo "NodeRag testbed is healthy: PostgreSQL and pgvector halfvec queries passed."
