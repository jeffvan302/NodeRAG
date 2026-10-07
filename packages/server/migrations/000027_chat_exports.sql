ALTER TABLE noderag.chat_settings_revision
  ADD COLUMN export_max_output_bytes bigint NOT NULL DEFAULT 67108864
    CHECK (export_max_output_bytes BETWEEN 1048576 AND 536870912),
  ADD COLUMN export_timeout_ms integer NOT NULL DEFAULT 120000
    CHECK (export_timeout_ms BETWEEN 10000 AND 900000),
  ADD COLUMN export_maximum_attempts integer NOT NULL DEFAULT 2
    CHECK (export_maximum_attempts BETWEEN 1 AND 5);

CREATE TABLE noderag.chat_export_job (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES noderag.chat_artifact(id) ON DELETE CASCADE,
  artifact_revision_id uuid NOT NULL REFERENCES noderag.chat_artifact_revision(id),
  source_revision integer NOT NULL CHECK (source_revision BETWEEN 1 AND 1000000),
  source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256)=32),
  requested_by_principal_id bigint NOT NULL REFERENCES noderag.principal(id),
  output_format text NOT NULL CHECK (output_format IN ('docx','pdf')),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','running','retry_wait','succeeded','failed','cancelled')),
  progress_percent integer NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  phase text NOT NULL DEFAULT 'queued'
    CHECK (phase IN ('queued','parsing','rendering','validating','publishing','complete')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  maximum_attempts integer NOT NULL CHECK (maximum_attempts BETWEEN 1 AND 5),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 10000 AND 900000),
  maximum_output_bytes bigint NOT NULL CHECK (maximum_output_bytes BETWEEN 1048576 AND 536870912),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 200),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  leased_until timestamptz,
  heartbeat_at timestamptz,
  run_after timestamptz NOT NULL DEFAULT now(),
  cancel_requested_at timestamptz,
  normalized_model_sha256 bytea CHECK (
    normalized_model_sha256 IS NULL OR octet_length(normalized_model_sha256)=32
  ),
  generator_revision text NOT NULL CHECK (length(generator_revision) BETWEEN 1 AND 120),
  format_policy_revision text NOT NULL CHECK (length(format_policy_revision) BETWEEN 1 AND 120),
  output_relative_path text CHECK (
    output_relative_path IS NULL OR length(output_relative_path) BETWEEN 1 AND 2048
  ),
  output_filename text CHECK (output_filename IS NULL OR length(output_filename) BETWEEN 1 AND 240),
  output_mime_type text CHECK (
    output_mime_type IS NULL OR output_mime_type IN (
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  ),
  output_sha256 bytea CHECK (output_sha256 IS NULL OR octet_length(output_sha256)=32),
  output_bytes bigint CHECK (output_bytes IS NULL OR output_bytes BETWEEN 1 AND 536870912),
  warnings jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings)='array'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_-]{0,119}$'),
  error_detail text CHECK (error_detail IS NULL OR length(error_detail) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (state='succeeded' AND progress_percent=100 AND phase='complete' AND
      output_relative_path IS NOT NULL AND output_filename IS NOT NULL AND
      output_mime_type IS NOT NULL AND output_sha256 IS NOT NULL AND output_bytes IS NOT NULL AND
      finished_at IS NOT NULL AND error_code IS NULL) OR
    state <> 'succeeded'
  ),
  CHECK (
    (state IN ('failed','cancelled') AND finished_at IS NOT NULL) OR
    state NOT IN ('failed','cancelled')
  )
);

CREATE INDEX chat_export_job_claim_idx
  ON noderag.chat_export_job (run_after,created_at,id)
  WHERE state IN ('queued','retry_wait','running');

CREATE INDEX chat_export_job_conversation_idx
  ON noderag.chat_export_job (conversation_id,created_at DESC,id DESC);

CREATE TABLE noderag.chat_export_event (
  id bigserial PRIMARY KEY,
  export_job_id uuid NOT NULL REFERENCES noderag.chat_export_job(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence BETWEEN 0 AND 1000000),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_-]{0,119}$'),
  detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (export_job_id,sequence)
);

CREATE TRIGGER chat_export_event_immutable
BEFORE UPDATE OR DELETE ON noderag.chat_export_event
FOR EACH ROW EXECUTE FUNCTION noderag.prevent_chat_configuration_revision_mutation();

CREATE TABLE noderag.chat_artifact_ingestion (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES noderag.chat_artifact(id) ON DELETE CASCADE,
  artifact_revision_id uuid NOT NULL REFERENCES noderag.chat_artifact_revision(id),
  export_job_id uuid REFERENCES noderag.chat_export_job(id) ON DELETE SET NULL,
  source_format text NOT NULL CHECK (source_format IN ('markdown','docx','pdf')),
  source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256)=32),
  silo_id smallint NOT NULL REFERENCES noderag.silo(id),
  document_id bigint REFERENCES noderag.document(id) ON DELETE SET NULL,
  ingestion_job_id bigint REFERENCES noderag.job(id) ON DELETE SET NULL,
  requested_by_principal_id bigint NOT NULL REFERENCES noderag.principal(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_format='markdown' AND export_job_id IS NULL) OR source_format <> 'markdown'),
  CHECK ((source_format IN ('docx','pdf') AND export_job_id IS NOT NULL) OR source_format='markdown')
);

CREATE INDEX chat_artifact_ingestion_conversation_idx
  ON noderag.chat_artifact_ingestion (conversation_id,created_at DESC,id DESC);

CREATE UNIQUE INDEX chat_artifact_ingestion_document_idx
  ON noderag.chat_artifact_ingestion (document_id)
  WHERE document_id IS NOT NULL;

INSERT INTO noderag.system_metadata (key,value)
VALUES (
  'chat-exports',
  '{"schemaVersion":27,"documentModel":"chat-document.v1","generatorRevision":"chat-export.v1","formatPolicyRevision":"safe-office-pdf.v1","macros":false,"activeContent":false,"externalRelationships":false}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
