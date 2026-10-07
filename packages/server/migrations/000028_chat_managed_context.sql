ALTER TABLE noderag.chat_message
  ADD COLUMN context_state text NOT NULL DEFAULT 'active'
    CHECK (context_state IN ('active','folded')),
  ADD COLUMN pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN pinned_at timestamptz,
  ADD COLUMN pinned_by bigint REFERENCES noderag.principal(id),
  ADD COLUMN archived_segment_id uuid
    REFERENCES noderag.chat_log_segment(id) ON DELETE SET NULL,
  ADD CONSTRAINT chat_message_pin_state_valid CHECK (
    (pinned AND pinned_at IS NOT NULL AND pinned_by IS NOT NULL) OR
    (NOT pinned AND pinned_at IS NULL AND pinned_by IS NULL)
  );

CREATE INDEX chat_message_context_idx
  ON noderag.chat_message (conversation_id,context_state,sequence);

CREATE INDEX chat_message_pinned_idx
  ON noderag.chat_message (conversation_id,sequence)
  WHERE pinned;

ALTER TABLE noderag.chat_run
  ADD COLUMN context_capacity_tokens integer
    CHECK (context_capacity_tokens BETWEEN 1024 AND 10000000),
  ADD COLUMN context_capacity_source text NOT NULL DEFAULT 'unknown'
    CHECK (context_capacity_source IN (
      'administrator_override','provider_runtime','provider_configured',
      'provider_advertised','known_model_table','unknown'
    )),
  ADD COLUMN token_estimator_revision text NOT NULL DEFAULT 'chat-token-estimator.v1'
    CHECK (length(token_estimator_revision) BETWEEN 1 AND 120),
  ADD COLUMN estimated_input_tokens bigint NOT NULL DEFAULT 0
    CHECK (estimated_input_tokens >= 0),
  ADD COLUMN input_usage_source text NOT NULL DEFAULT 'unknown'
    CHECK (input_usage_source IN ('provider_exact','conservative_estimate','unknown'));

CREATE TABLE noderag.chat_context_compression_job (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  trigger_run_id uuid REFERENCES noderag.chat_run(id) ON DELETE SET NULL,
  mode text NOT NULL CHECK (mode IN ('automatic','manual','dry_run')),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','running','cancelling','completed','failed','cancelled')),
  context_revision_id bigint NOT NULL REFERENCES noderag.chat_context_settings_revision(id),
  source_last_message_sequence bigint NOT NULL CHECK (source_last_message_sequence >= 0),
  fold_through_sequence bigint CHECK (fold_through_sequence >= 0),
  prior_snapshot_id uuid,
  status_version bigint NOT NULL DEFAULT 0 CHECK (status_version >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  maximum_attempts integer NOT NULL DEFAULT 3 CHECK (maximum_attempts BETWEEN 1 AND 20),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 200),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  leased_until timestamptz,
  heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  progress_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  current_layer text CHECK (current_layer IS NULL OR current_layer IN ('prepare','l2','l3','commit')),
  safe_error_code text CHECK (
    safe_error_code IS NULL OR safe_error_code ~ '^[a-z][a-z0-9_-]{0,119}$'
  ),
  error_retryable boolean,
  settings_snapshot jsonb NOT NULL CHECK (jsonb_typeof(settings_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (lease_owner IS NULL AND leased_until IS NULL) OR
    (lease_owner IS NOT NULL AND leased_until IS NOT NULL)
  ),
  CHECK (fold_through_sequence IS NULL OR fold_through_sequence <= source_last_message_sequence)
);

CREATE UNIQUE INDEX chat_context_one_active_job_idx
  ON noderag.chat_context_compression_job (conversation_id)
  WHERE state IN ('queued','running','cancelling');

CREATE INDEX chat_context_compression_claim_idx
  ON noderag.chat_context_compression_job (state,created_at,id)
  WHERE state IN ('queued','running','cancelling');

CREATE TABLE noderag.chat_context_snapshot (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  job_id uuid NOT NULL UNIQUE
    REFERENCES noderag.chat_context_compression_job(id) ON DELETE RESTRICT,
  log_segment_id uuid REFERENCES noderag.chat_log_segment(id) ON DELETE SET NULL,
  prior_snapshot_id uuid REFERENCES noderag.chat_context_snapshot(id) ON DELETE RESTRICT,
  schema_revision text NOT NULL DEFAULT 'chat-context-snapshot.v1'
    CHECK (length(schema_revision) BETWEEN 1 AND 120),
  estimator_revision text NOT NULL CHECK (length(estimator_revision) BETWEEN 1 AND 120),
  source_first_sequence bigint NOT NULL CHECK (source_first_sequence >= 0),
  source_last_sequence bigint NOT NULL CHECK (source_last_sequence >= source_first_sequence),
  fold_through_sequence bigint NOT NULL
    CHECK (fold_through_sequence BETWEEN source_first_sequence AND source_last_sequence),
  recent_from_sequence bigint NOT NULL CHECK (recent_from_sequence >= 0),
  l1_message_ids uuid[] NOT NULL DEFAULT '{}',
  l1_sha256 bytea NOT NULL CHECK (octet_length(l1_sha256)=32),
  l2_summary text NOT NULL CHECK (length(l2_summary) <= 2000000),
  l2_sha256 bytea NOT NULL CHECK (octet_length(l2_sha256)=32),
  l3_state jsonb NOT NULL CHECK (jsonb_typeof(l3_state)='object'),
  l3_sha256 bytea NOT NULL CHECK (octet_length(l3_sha256)=32),
  source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256)=32),
  snapshot_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(snapshot_sha256)=32),
  context_tokens integer NOT NULL CHECK (context_tokens >= 0),
  minimum_integrity_passed boolean NOT NULL CHECK (minimum_integrity_passed),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_context_snapshot_conversation_idx
  ON noderag.chat_context_snapshot (conversation_id,created_at DESC,id DESC);

CREATE TRIGGER chat_context_snapshot_immutable
BEFORE UPDATE ON noderag.chat_context_snapshot
FOR EACH ROW EXECUTE FUNCTION noderag.prevent_chat_configuration_revision_mutation();

ALTER TABLE noderag.chat_run
  ADD COLUMN context_snapshot_id uuid
    REFERENCES noderag.chat_context_snapshot(id) ON DELETE SET NULL;

CREATE TABLE noderag.chat_context_compression_event (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  job_id uuid NOT NULL REFERENCES noderag.chat_context_compression_job(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  event_type text NOT NULL CHECK (event_type IN (
    'compression.queued','compression.started','compression.progress',
    'compression.cancel_requested','compression.recovered',
    'compression.completed','compression.failed','compression.cancelled'
  )),
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload)='object'),
  previous_sha256 bytea CHECK (previous_sha256 IS NULL OR octet_length(previous_sha256)=32),
  event_sha256 bytea NOT NULL CHECK (octet_length(event_sha256)=32),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id,sequence)
);

CREATE TABLE noderag.chat_archive_manifest_revision (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  prior_revision_id uuid REFERENCES noderag.chat_archive_manifest_revision(id) ON DELETE RESTRICT,
  schema_revision text NOT NULL DEFAULT 'chat-archive-manifest.v1'
    CHECK (length(schema_revision) BETWEEN 1 AND 120),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  manifest_sha256 bytea NOT NULL CHECK (octet_length(manifest_sha256)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id,manifest_sha256)
);

CREATE INDEX chat_archive_manifest_conversation_idx
  ON noderag.chat_archive_manifest_revision (conversation_id,created_at DESC,id DESC);

CREATE TRIGGER chat_archive_manifest_immutable
BEFORE UPDATE ON noderag.chat_archive_manifest_revision
FOR EACH ROW EXECUTE FUNCTION noderag.prevent_chat_configuration_revision_mutation();

ALTER TABLE noderag.chat_log_segment
  ADD COLUMN storage_encoding text NOT NULL DEFAULT 'identity'
    CHECK (storage_encoding IN ('identity','gzip')),
  ADD COLUMN uncompressed_byte_length bigint CHECK (uncompressed_byte_length >= 0),
  ADD COLUMN uncompressed_sha256 bytea CHECK (
    uncompressed_sha256 IS NULL OR octet_length(uncompressed_sha256)=32
  ),
  ADD COLUMN manifest_revision_id uuid
    REFERENCES noderag.chat_archive_manifest_revision(id) ON DELETE SET NULL;

CREATE TABLE noderag.chat_import_operation (
  id uuid PRIMARY KEY,
  requested_by bigint NOT NULL REFERENCES noderag.principal(id),
  source_manifest_sha256 bytea NOT NULL CHECK (octet_length(source_manifest_sha256)=32),
  source_schema_revision text NOT NULL CHECK (length(source_schema_revision) BETWEEN 1 AND 120),
  requested_owner_map jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(requested_owner_map)='object'),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','validating','quarantined','completed','failed')),
  safe_error_code text CHECK (
    safe_error_code IS NULL OR safe_error_code ~ '^[a-z][a-z0-9_-]{0,119}$'
  ),
  diagnostics jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(diagnostics)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (requested_by,source_manifest_sha256)
);

CREATE TABLE noderag.chat_import_event (
  event_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES noderag.chat_import_operation(id) ON DELETE CASCADE,
  source_event_id uuid,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload)='object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id,source_event_id)
);

CREATE TABLE noderag.chat_import_conflict (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES noderag.chat_import_operation(id) ON DELETE CASCADE,
  conflict_kind text NOT NULL CHECK (conflict_kind IN (
    'partial_segment','checksum_mismatch','owner_unmapped','owner_conflict',
    'future_schema','duplicate_content','unsafe_path'
  )),
  source_relative_path text CHECK (
    source_relative_path IS NULL OR length(source_relative_path) BETWEEN 1 AND 1024
  ),
  safe_detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(safe_detail)='object'),
  quarantined_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO noderag.system_metadata (key,value)
VALUES (
  'chat-managed-context',
  '{"schemaVersion":28,"snapshotContract":"chat-context-snapshot.v1","estimator":"chat-token-estimator.v1","archiveManifest":"chat-archive-manifest.v1","originalMessagesDeleted":false,"ollamaCloudOnly":true,"internetProvider":"ollama_cloud"}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
