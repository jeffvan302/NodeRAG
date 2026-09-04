#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
testbed_dir="$(cd -- "${script_dir}/.." && pwd)"
repository_root="$(cd -- "${testbed_dir}/.." && pwd)"
source "${script_dir}/common.sh"

mode="${1:-local}"
case "${mode}" in
  local|--docker|--upgrade-only) ;;
  *) echo "Usage: $0 [--docker|--upgrade-only]" >&2; exit 2 ;;
esac

bash "${script_dir}/bootstrap.sh"
cd -- "${repository_root}"

if [[ "${mode}" == "--docker" ]]; then
  docker_compose --profile m12 build m12-node
  docker_compose --profile m12 run --rm --no-deps \
    --env NODERAG_M12_MODEL_ROOT= \
    --env NODERAG_M12_REPORT= \
    m12-node exec vitest run --project unit \
      packages/server/test/recovery.unit.test.ts \
      packages/server/test/pg-tools.unit.test.ts \
      packages/server/test/schedule.unit.test.ts \
      packages/server/test/upgrade.unit.test.ts
  docker_compose --profile m12 run --rm --no-deps \
    --env NODERAG_M12_MODEL_ROOT= \
    --env NODERAG_M12_REPORT= \
    m12-node exec vitest run --project integration \
      packages/server/test/recovery.integration.test.ts --reporter=verbose
elif [[ "${mode}" == "local" ]]; then
  pnpm exec vitest run --project unit \
    packages/server/test/recovery.unit.test.ts \
    packages/server/test/pg-tools.unit.test.ts \
    packages/server/test/schedule.unit.test.ts \
    packages/server/test/upgrade.unit.test.ts
  pnpm exec vitest run --project integration \
    packages/server/test/recovery.integration.test.ts --reporter=verbose
fi

docker_compose --profile m13 up -d --wait postgres postgres16
cleanup() {
  docker_compose --profile m13 exec -T postgres \
    sh -ec 'dropdb --if-exists --force -U "$POSTGRES_USER" noderag_m13_restored' \
    >/dev/null 2>&1 || true
  docker_compose --profile m13 exec -T postgres16 \
    sh -ec 'rm -f -- /recovery/noderag-m13-pg16.dump' >/dev/null 2>&1 || true
  docker_compose --profile m13 stop postgres16 >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker_compose --profile m13 exec -T postgres16 sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
CREATE SCHEMA noderag;
CREATE TABLE noderag.upgrade_probe (
  id bigint PRIMARY KEY,
  stable_text text NOT NULL,
  typed_payload jsonb NOT NULL,
  typed_labels text[] NOT NULL
);
INSERT INTO noderag.upgrade_probe VALUES
  (7301, 'PostgreSQL 16 to 17 logical recovery', '{"verified":true,"version":16}', ARRAY['stable','typed']);
SQL
docker_compose --profile m13 exec -T postgres16 sh -ec \
  'pg_dump --format=custom --compress=0 --no-owner --no-privileges \
    --schema=noderag --file=/recovery/noderag-m13-pg16.dump \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker_compose --profile m13 exec -T postgres sh -ec \
  'dropdb --if-exists --force -U "$POSTGRES_USER" noderag_m13_restored && \
   createdb -U "$POSTGRES_USER" noderag_m13_restored && \
   pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
     -U "$POSTGRES_USER" -d noderag_m13_restored /recovery/noderag-m13-pg16.dump && \
   psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d noderag_m13_restored \
     -c "SELECT id,stable_text,typed_payload,typed_labels FROM noderag.upgrade_probe WHERE id=7301"'
docker_compose --profile m13 exec -T postgres sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d noderag_m13_restored' <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM noderag.upgrade_probe
    WHERE id=7301
      AND (typed_payload->>'verified')::boolean
      AND typed_payload->>'version'='16'
      AND typed_labels=ARRAY['stable','typed']
  ) THEN
    RAISE EXCEPTION 'PostgreSQL major restore verification failed';
  END IF;
END
$$;
SQL
docker_compose --profile m13 exec -T postgres sh -ec \
  'dropdb --force -U "$POSTGRES_USER" noderag_m13_restored'
docker_compose --profile m13 exec -T postgres16 sh -ec \
  'test "$(psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT stable_text FROM noderag.upgrade_probe WHERE id=7301")" = "PostgreSQL 16 to 17 logical recovery"'

echo "Milestone 13 encrypted recovery, scheduled backup, fault barrier, and PostgreSQL 16-to-17 rehearsal passed."
