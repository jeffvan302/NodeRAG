ALTER TABLE noderag.evaluation_case
  ADD COLUMN query_class text NOT NULL DEFAULT 'semantic'
    CHECK (query_class IN (
      'semantic', 'exact_identifier', 'exact_name', 'error_code', 'quoted_phrase',
      'cross_page', 'table', 'vision', 'multilingual', 'unicode'
    )),
  ADD COLUMN expected_format text
    CHECK (expected_format IN ('pdf', 'docx', 'xlsx', 'txt', 'md')),
  ADD COLUMN answerable boolean NOT NULL DEFAULT true,
  ADD COLUMN curation_state text NOT NULL DEFAULT 'draft'
    CHECK (curation_state IN ('draft', 'approved', 'rejected')),
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_by bigint REFERENCES noderag.principal(id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_by bigint REFERENCES noderag.principal(id);

CREATE TABLE noderag.evaluation_corpus_snapshot (
  id bigserial PRIMARY KEY,
  corpus_id text NOT NULL,
  manifest_digest text NOT NULL UNIQUE CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  document_count integer NOT NULL CHECK (document_count > 0),
  case_count integer NOT NULL CHECK (case_count BETWEEN 1 AND 10000),
  frozen_at timestamptz NOT NULL DEFAULT now(),
  frozen_by bigint REFERENCES noderag.principal(id)
);

CREATE TABLE noderag.evaluation_settings_revision (
  id bigserial PRIMARY KEY,
  settings_digest text NOT NULL UNIQUE CHECK (settings_digest ~ '^[a-f0-9]{64}$'),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  environment jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(environment) = 'object'),
  accepted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES noderag.principal(id)
);

ALTER TABLE noderag.evaluation_run
  ADD COLUMN workload text NOT NULL DEFAULT 'idle'
    CHECK (workload IN ('idle', 'ingest')),
  ADD COLUMN corpus_snapshot_id bigint REFERENCES noderag.evaluation_corpus_snapshot(id),
  ADD COLUMN settings_revision_id bigint REFERENCES noderag.evaluation_settings_revision(id),
  ADD COLUMN commit_sha text CHECK (commit_sha IS NULL OR commit_sha ~ '^[a-f0-9]{40}$'),
  ADD COLUMN migration_head text,
  ADD COLUMN build_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(build_snapshot) = 'object'),
  ADD COLUMN model_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(model_snapshot) = 'object'),
  ADD COLUMN thresholds jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(thresholds) = 'object'),
  ADD COLUMN failure_code text,
  ADD COLUMN lease_owner text,
  ADD COLUMN leased_until timestamptz;

CREATE INDEX evaluation_run_claim_idx
  ON noderag.evaluation_run (state, created_at, id)
  WHERE state = 'queued';

CREATE TABLE noderag.evaluation_observation (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES noderag.evaluation_run(id) ON DELETE CASCADE,
  case_id bigint NOT NULL REFERENCES noderag.evaluation_case(id) ON DELETE CASCADE,
  elapsed_ms numeric(12,3) NOT NULL CHECK (elapsed_ms >= 0),
  hits jsonb NOT NULL CHECK (jsonb_typeof(hits) = 'array'),
  gains smallint[] NOT NULL,
  leakage_count integer NOT NULL DEFAULT 0 CHECK (leakage_count >= 0),
  locator_mismatch_count integer NOT NULL DEFAULT 0 CHECK (locator_mismatch_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, case_id)
);

CREATE TABLE noderag.evaluation_baseline (
  id bigserial PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('vector', 'keyword', 'hybrid')),
  workload text NOT NULL CHECK (workload IN ('idle', 'ingest')),
  run_id bigint NOT NULL REFERENCES noderag.evaluation_run(id),
  metrics_digest text NOT NULL CHECK (metrics_digest ~ '^[a-f0-9]{64}$'),
  active boolean NOT NULL DEFAULT true,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  accepted_by bigint NOT NULL REFERENCES noderag.principal(id)
);
CREATE UNIQUE INDEX evaluation_baseline_one_active_idx
  ON noderag.evaluation_baseline (mode, workload)
  WHERE active;

CREATE TABLE noderag.evaluation_alert (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES noderag.evaluation_run(id) ON DELETE CASCADE,
  baseline_id bigint REFERENCES noderag.evaluation_baseline(id),
  severity text NOT NULL CHECK (severity IN ('warning', 'failure')),
  code text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object'),
  acknowledged_at timestamptz,
  acknowledged_by bigint REFERENCES noderag.principal(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evaluation_alert_open_idx
  ON noderag.evaluation_alert (created_at DESC)
  WHERE acknowledged_at IS NULL;

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'evaluation-baselines',
  '{"schemaVersion":12,"milestone":"M12","relevanceUnit":"document-page-sheet-sha256"}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
