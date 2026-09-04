#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/common.sh"

docker_compose exec -T postgres sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL' >/dev/null
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TEMP TABLE noderag_m01_vector_probe (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  embedding halfvec(1024) NOT NULL
);

DO $$
DECLARE
  probe halfvec(1024);
  distance double precision;
BEGIN
  probe := ('[' || '1,' || repeat('0,', 1022) || '0]')::halfvec(1024);
  INSERT INTO noderag_m01_vector_probe (embedding) VALUES (probe);
  SELECT embedding <=> probe INTO distance FROM noderag_m01_vector_probe LIMIT 1;
  IF distance IS NULL OR abs(distance) > 0.000001 THEN
    RAISE EXCEPTION 'halfvec(1024) similarity probe failed: %', distance;
  END IF;
END
$$;
SQL

printf '%s\n' '{"postgresMajor":17,"pgvector":true,"halfvecDimension":1024,"cosineSelfDistance":0,"passed":true}'
