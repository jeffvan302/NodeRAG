CREATE TABLE noderag.storage_relocation_operation (
  id bigserial PRIMARY KEY,
  component text NOT NULL CHECK (component IN ('tablespace', 'documents', 'model', 'cache')),
  source_location_id smallint REFERENCES noderag.storage_location(id),
  destination_location_id smallint NOT NULL REFERENCES noderag.storage_location(id),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'maintenance', 'copying', 'verifying', 'activating',
                     'succeeded', 'rollback_required', 'failed', 'cancelled')),
  checkpoint jsonb NOT NULL DEFAULT '{}',
  manifest_sha256 bytea CHECK (manifest_sha256 IS NULL OR octet_length(manifest_sha256) = 32),
  old_data_retained boolean NOT NULL DEFAULT true,
  requested_by bigint NOT NULL REFERENCES noderag.principal(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_code text
);
CREATE INDEX storage_relocation_state_idx
  ON noderag.storage_relocation_operation (state, requested_at);

CREATE TABLE noderag.model_artifact (
  id bigserial PRIMARY KEY,
  model_manifest_id smallint REFERENCES noderag.model_manifest(id) ON DELETE SET NULL,
  artifact_name text NOT NULL,
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  bytes bigint NOT NULL CHECK (bytes > 0),
  acquisition text NOT NULL CHECK (acquisition IN ('download', 'manual_import')),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('partial', 'ready', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_name, sha256)
);

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'packageLifecycle',
  '{"schemaVersion":1,"milestone":"M10","postgresqlMajor":17,"tcpDefault":false}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
