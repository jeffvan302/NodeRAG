ALTER TABLE noderag.gateway DROP CONSTRAINT gateway_port_check;
ALTER TABLE noderag.gateway
  ADD CONSTRAINT gateway_static_port_range_check
  CHECK (port IS NULL OR port BETWEEN 5300 AND 5319),
  ADD COLUMN last_bind_error text,
  ADD COLUMN bound_at timestamptz;

ALTER TABLE noderag.build DROP CONSTRAINT build_state_check;
ALTER TABLE noderag.build ADD CONSTRAINT build_state_check
  CHECK (state IN ('building', 'paused', 'active', 'superseded', 'failed', 'cancelled'));

CREATE TABLE noderag.storage_location (
  id smallserial PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 120),
  managed_path text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN ('documents', 'backup', 'temporary')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES noderag.principal(id)
);

CREATE TABLE noderag.backup_operation (
  id bigserial PRIMARY KEY,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  destination_id smallint REFERENCES noderag.storage_location(id),
  manifest jsonb NOT NULL DEFAULT '{}',
  error_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by bigint REFERENCES noderag.principal(id),
  finished_at timestamptz
);

CREATE TABLE noderag.restore_operation (
  id bigserial PRIMARY KEY,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'validating', 'ready', 'running', 'succeeded', 'failed', 'cancelled')),
  backup_id bigint REFERENCES noderag.backup_operation(id),
  source_manifest jsonb NOT NULL DEFAULT '{}',
  error_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by bigint REFERENCES noderag.principal(id),
  finished_at timestamptz
);

CREATE TABLE noderag.evaluation_case (
  id bigserial PRIMARY KEY,
  external_id text NOT NULL UNIQUE CHECK (length(external_id) BETWEEN 1 AND 120),
  silo_id smallint NOT NULL REFERENCES noderag.silo(id) ON DELETE CASCADE,
  query text NOT NULL CHECK (length(query) BETWEEN 1 AND 4000),
  relevant jsonb NOT NULL,
  notes text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES noderag.principal(id),
  CHECK (jsonb_typeof(relevant) = 'array')
);

CREATE TABLE noderag.evaluation_run (
  id bigserial PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('vector', 'keyword', 'hybrid')),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  config jsonb NOT NULL DEFAULT '{}',
  metrics jsonb NOT NULL DEFAULT '{}',
  case_count integer NOT NULL DEFAULT 0 CHECK (case_count >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES noderag.principal(id)
);

CREATE TABLE noderag.retrieval_diagnostic (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('ann_recall', 'rls_benchmark')),
  config jsonb NOT NULL,
  metrics jsonb NOT NULL,
  decision text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES noderag.principal(id)
);
CREATE INDEX retrieval_diagnostic_kind_created_idx
  ON noderag.retrieval_diagnostic (kind, created_at DESC);

INSERT INTO noderag.system_metadata (key, value)
VALUES ('retrieval-interfaces', '{"schemaVersion":6,"milestone":"M08","rrfK":60}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
