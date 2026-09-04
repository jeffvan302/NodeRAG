CREATE TABLE noderag.silo (
  id smallserial PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint
);

CREATE TABLE noderag.principal (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('user', 'api_key')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES noderag.principal(id),
  deleted_at timestamptz
);
ALTER TABLE noderag.silo
  ADD CONSTRAINT silo_created_by_fkey FOREIGN KEY (created_by)
  REFERENCES noderag.principal(id);

CREATE TABLE noderag.app_user (
  principal_id bigint PRIMARY KEY REFERENCES noderag.principal(id) ON DELETE CASCADE,
  username text NOT NULL CHECK (username ~ '^[A-Za-z0-9._-]{3,64}$'),
  email text,
  password_hash text NOT NULL,
  server_admin boolean NOT NULL DEFAULT false,
  must_change boolean NOT NULL DEFAULT false,
  failed_logins integer NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_username_ci_idx ON noderag.app_user (lower(username));

CREATE TABLE noderag.api_key (
  principal_id bigint PRIMARY KEY REFERENCES noderag.principal(id) ON DELETE CASCADE,
  prefix text NOT NULL UNIQUE CHECK (prefix ~ '^[A-Za-z0-9]{8}$'),
  key_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(key_sha256) = 32),
  search_only boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  cidr_allow inet[],
  rate_per_min integer CHECK (rate_per_min BETWEEN 1 AND 60000),
  last_used_at timestamptz,
  last_used_ip inet,
  revoked_at timestamptz
);

CREATE TABLE noderag.silo_grant (
  principal_id bigint NOT NULL REFERENCES noderag.principal(id) ON DELETE CASCADE,
  silo_id smallint NOT NULL REFERENCES noderag.silo(id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability IN ('read', 'upload', 'delete')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by bigint REFERENCES noderag.principal(id),
  PRIMARY KEY (principal_id, silo_id, capability)
);
CREATE INDEX silo_grant_silo_capability_idx
  ON noderag.silo_grant (silo_id, capability, principal_id);

CREATE TABLE noderag.session (
  token_sha256 bytea PRIMARY KEY CHECK (octet_length(token_sha256) = 32),
  csrf_sha256 bytea NOT NULL CHECK (octet_length(csrf_sha256) = 32),
  principal_id bigint NOT NULL REFERENCES noderag.principal(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  sliding_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip inet,
  user_agent text,
  CHECK (sliding_expires_at <= absolute_expires_at)
);
CREATE INDEX session_principal_active_idx
  ON noderag.session (principal_id, sliding_expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE noderag.encrypted_secret (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  name text NOT NULL,
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{16}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES noderag.principal(id),
  UNIQUE (provider, name)
);

CREATE TABLE noderag.model_manifest (
  id smallserial PRIMARY KEY,
  name text NOT NULL,
  source_revision text NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  tokenizer_revision text NOT NULL,
  quantization text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
  maximum_tokens integer NOT NULL CHECK (maximum_tokens BETWEEN 128 AND 32768),
  pooling text NOT NULL CHECK (pooling = 'last_token'),
  normalization text NOT NULL CHECK (normalization = 'l2'),
  query_prefix text NOT NULL,
  document_prefix text NOT NULL DEFAULT '' CHECK (document_prefix = ''),
  license text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, source_revision, quantization)
);
CREATE UNIQUE INDEX model_manifest_one_active_idx
  ON noderag.model_manifest (active) WHERE active;

CREATE TABLE noderag.settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  target_chars integer NOT NULL DEFAULT 2000 CHECK (target_chars BETWEEN 200 AND 8000),
  overlap_chars integer NOT NULL DEFAULT 300 CHECK (overlap_chars >= 0),
  max_tokens integer NOT NULL DEFAULT 1024 CHECK (max_tokens BETWEEN 128 AND 2048),
  snap_window numeric(4,3) NOT NULL DEFAULT 0.150 CHECK (snap_window BETWEEN 0 AND 0.500),
  heading_prefix boolean NOT NULL DEFAULT true,
  rules_version integer NOT NULL DEFAULT 1 CHECK (rules_version > 0),
  model_manifest_id smallint REFERENCES noderag.model_manifest(id),
  embed_threads integer NOT NULL DEFAULT 4 CHECK (embed_threads BETWEEN 1 AND 32),
  ingest_threads integer NOT NULL DEFAULT 2 CHECK (ingest_threads BETWEEN 1 AND 16),
  throttle_when_busy boolean NOT NULL DEFAULT true,
  ts_config regconfig NOT NULL DEFAULT 'simple',
  vision_enabled boolean NOT NULL DEFAULT true,
  ollama_base_url text,
  ollama_secret_id bigint REFERENCES noderag.encrypted_secret(id),
  ollama_model text,
  ollama_parallel integer NOT NULL DEFAULT 2 CHECK (ollama_parallel BETWEEN 1 AND 16),
  ollama_timeout_ms integer NOT NULL DEFAULT 60000 CHECK (ollama_timeout_ms >= 1000),
  max_image_px integer NOT NULL DEFAULT 1600 CHECK (max_image_px BETWEEN 256 AND 8192),
  default_mode text NOT NULL DEFAULT 'vector' CHECK (default_mode IN ('vector', 'keyword', 'hybrid')),
  ef_search integer NOT NULL DEFAULT 100 CHECK (ef_search BETWEEN 1 AND 2000),
  login_enabled boolean NOT NULL DEFAULT true,
  audit_retention_days integer NOT NULL DEFAULT 90 CHECK (audit_retention_days BETWEEN 1 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES noderag.principal(id),
  CHECK (overlap_chars <= target_chars / 2)
);

CREATE TABLE noderag.build (
  id smallserial PRIMARY KEY,
  state text NOT NULL DEFAULT 'building'
    CHECK (state IN ('building', 'active', 'superseded', 'failed', 'cancelled')),
  target_chars integer NOT NULL CHECK (target_chars BETWEEN 200 AND 8000),
  overlap_chars integer NOT NULL CHECK (overlap_chars >= 0),
  max_tokens integer NOT NULL CHECK (max_tokens BETWEEN 128 AND 2048),
  snap_window numeric(4,3) NOT NULL CHECK (snap_window BETWEEN 0 AND 0.500),
  heading_prefix boolean NOT NULL,
  rules_version integer NOT NULL CHECK (rules_version > 0),
  model_manifest_id smallint NOT NULL REFERENCES noderag.model_manifest(id),
  query_prefix text NOT NULL,
  reason text,
  chunk_count bigint,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  activated_at timestamptz,
  CHECK (overlap_chars <= target_chars / 2)
);

CREATE TABLE noderag.silo_build_state (
  silo_id smallint NOT NULL REFERENCES noderag.silo(id) ON DELETE CASCADE,
  build_id smallint NOT NULL REFERENCES noderag.build(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'building', 'indexing', 'ready', 'active', 'failed')),
  staging_table text,
  processed_documents bigint NOT NULL DEFAULT 0 CHECK (processed_documents >= 0),
  total_documents bigint CHECK (total_documents >= 0),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (silo_id, build_id)
);

CREATE TABLE noderag.source (
  id bigserial PRIMARY KEY,
  silo_id smallint NOT NULL REFERENCES noderag.silo(id) ON DELETE CASCADE,
  uri text NOT NULL,
  include_glob text[] NOT NULL DEFAULT '{}',
  exclude_glob text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  schedule_cron text,
  schedule_timezone text NOT NULL DEFAULT 'UTC',
  health_state text NOT NULL DEFAULT 'unknown'
    CHECK (health_state IN ('unknown', 'healthy', 'unavailable', 'denied', 'error')),
  health_checked_at timestamptz,
  health_error text,
  last_crawl_at timestamptz,
  next_crawl_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES noderag.principal(id),
  UNIQUE (silo_id, uri)
);

CREATE TABLE noderag.document (
  id bigserial PRIMARY KEY,
  silo_id smallint NOT NULL REFERENCES noderag.silo(id) ON DELETE CASCADE,
  source_id bigint REFERENCES noderag.source(id) ON DELETE SET NULL,
  name text NOT NULL,
  title text,
  extension text NOT NULL CHECK (extension IN ('pdf', 'docx', 'xlsx', 'txt', 'md')),
  mime_type text,
  relative_path text,
  byte_count bigint NOT NULL CHECK (byte_count >= 0),
  source_mtime timestamptz,
  original_sha256 bytea NOT NULL CHECK (octet_length(original_sha256) = 32),
  markdown_sha256 bytea CHECK (markdown_sha256 IS NULL OR octet_length(markdown_sha256) = 32),
  normalized_sha256 bytea CHECK (normalized_sha256 IS NULL OR octet_length(normalized_sha256) = 32),
  normalization text NOT NULL DEFAULT 'nfc' CHECK (normalization = 'nfc'),
  normalization_version integer NOT NULL DEFAULT 1 CHECK (normalization_version > 0),
  character_count integer CHECK (character_count >= 0),
  page_count integer CHECK (page_count >= 0),
  page_basis text NOT NULL DEFAULT 'none'
    CHECK (page_basis IN ('exact', 'sheet', 'rendered', 'explicit', 'none')),
  character_unit text NOT NULL DEFAULT 'utf16' CHECK (character_unit = 'utf16'),
  byte_unit text NOT NULL DEFAULT 'utf8' CHECK (byte_unit = 'utf8'),
  offsets_version integer NOT NULL DEFAULT 1 CHECK (offsets_version > 0),
  offsets_match_original boolean NOT NULL DEFAULT false,
  encoding text,
  encoding_confidence real CHECK (encoding_confidence BETWEEN 0 AND 1),
  source_state text NOT NULL DEFAULT 'present' CHECK (source_state IN ('present', 'missing')),
  missing_since timestamptz,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'extracting', 'awaiting_vision', 'ready', 'source_missing', 'failed', 'purging')),
  error_code text,
  error_detail text,
  uploaded_by bigint REFERENCES noderag.principal(id),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  indexed_at timestamptz,
  UNIQUE (silo_id, id),
  CHECK ((source_state = 'missing') = (missing_since IS NOT NULL))
);
CREATE INDEX document_silo_created_idx ON noderag.document (silo_id, created_at DESC);
CREATE INDEX document_silo_original_sha_idx ON noderag.document (silo_id, original_sha256);
CREATE INDEX document_source_presence_idx ON noderag.document (source_id, source_state);

CREATE TABLE noderag.document_page (
  document_id bigint NOT NULL,
  silo_id smallint NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  page_number integer,
  label text,
  character_start integer NOT NULL CHECK (character_start >= 0),
  character_end integer NOT NULL,
  byte_start integer NOT NULL CHECK (byte_start >= 0),
  byte_end integer NOT NULL,
  extraction text NOT NULL DEFAULT 'text' CHECK (extraction IN ('text', 'vision', 'mixed')),
  extraction_confidence real CHECK (extraction_confidence BETWEEN 0 AND 1),
  PRIMARY KEY (document_id, ordinal),
  FOREIGN KEY (silo_id, document_id) REFERENCES noderag.document(silo_id, id) ON DELETE CASCADE,
  CHECK (character_end >= character_start),
  CHECK (byte_end >= byte_start)
);
CREATE INDEX document_page_silo_idx ON noderag.document_page (silo_id, document_id, ordinal);

CREATE TABLE noderag.document_image (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL,
  silo_id smallint NOT NULL,
  page_ordinal integer NOT NULL CHECK (page_ordinal >= 0),
  sequence integer NOT NULL CHECK (sequence >= 0),
  image_sha256 bytea NOT NULL CHECK (octet_length(image_sha256) = 32),
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  byte_count bigint CHECK (byte_count >= 0),
  state text NOT NULL DEFAULT 'pending_vision'
    CHECK (state IN ('pending_vision', 'analysed', 'skipped', 'failed')),
  skip_reason text,
  FOREIGN KEY (silo_id, document_id) REFERENCES noderag.document(silo_id, id) ON DELETE CASCADE,
  UNIQUE (document_id, page_ordinal, sequence)
);
CREATE INDEX document_image_silo_idx ON noderag.document_image (silo_id, document_id);

CREATE TABLE noderag.chunk (
  id bigserial,
  silo_id smallint NOT NULL REFERENCES noderag.silo(id) ON DELETE CASCADE,
  document_id bigint NOT NULL,
  build_id smallint NOT NULL REFERENCES noderag.build(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  text text NOT NULL,
  page_start integer,
  page_end integer,
  character_start integer NOT NULL CHECK (character_start >= 0),
  character_end integer NOT NULL,
  byte_start integer NOT NULL CHECK (byte_start >= 0),
  byte_end integer NOT NULL,
  embedding halfvec(1024) NOT NULL,
  token_count integer NOT NULL CHECK (token_count > 0),
  heading_path text[],
  chunk_sha256 bytea NOT NULL CHECK (octet_length(chunk_sha256) = 32),
  part_of text,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, text)) STORED,
  PRIMARY KEY (silo_id, id),
  UNIQUE (silo_id, document_id, build_id, ordinal),
  FOREIGN KEY (silo_id, document_id) REFERENCES noderag.document(silo_id, id) ON DELETE CASCADE,
  CHECK (page_end IS NULL OR page_start IS NOT NULL),
  CHECK (page_end IS NULL OR page_end >= page_start),
  CHECK (character_end > character_start),
  CHECK (byte_end > byte_start)
) PARTITION BY LIST (silo_id);

CREATE TABLE noderag.job (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('crawl', 'extract', 'vision', 'chunk', 'embed', 'rebuild', 'purge')),
  source_id bigint REFERENCES noderag.source(id) ON DELETE CASCADE,
  document_id bigint REFERENCES noderag.document(id) ON DELETE CASCADE,
  silo_id smallint REFERENCES noderag.silo(id) ON DELETE CASCADE,
  build_id smallint REFERENCES noderag.build(id),
  priority smallint NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 9),
  payload jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'retry_wait', 'paused', 'succeeded', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  last_error_code text,
  last_error_detail text,
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  leased_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX job_claim_idx ON noderag.job (priority, run_after, id)
  WHERE state IN ('pending', 'retry_wait');
CREATE INDEX job_document_idx ON noderag.job (document_id, created_at DESC);

CREATE TABLE noderag.job_event (
  id bigserial PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES noderag.job(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  event_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, sequence)
);

CREATE TABLE noderag.embedding_cache (
  chunk_sha256 bytea NOT NULL CHECK (octet_length(chunk_sha256) = 32),
  model_manifest_id smallint NOT NULL REFERENCES noderag.model_manifest(id) ON DELETE CASCADE,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  embedding halfvec NOT NULL,
  refcount integer NOT NULL DEFAULT 0 CHECK (refcount >= 0),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_sha256, model_manifest_id)
);

CREATE TABLE noderag.vision_cache (
  image_sha256 bytea NOT NULL CHECK (octet_length(image_sha256) = 32),
  model text NOT NULL,
  kind text NOT NULL,
  markdown text NOT NULL,
  alt_text text NOT NULL,
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  elapsed_ms integer CHECK (elapsed_ms >= 0),
  refcount integer NOT NULL DEFAULT 0 CHECK (refcount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (image_sha256, model)
);

CREATE TABLE noderag.gateway (
  id smallserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  port integer UNIQUE CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  silo_ids smallint[] NOT NULL DEFAULT '{}',
  require_auth boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES noderag.principal(id)
);

CREATE TABLE noderag.audit_log (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  principal_id bigint REFERENCES noderag.principal(id),
  gateway_id smallint REFERENCES noderag.gateway(id) ON DELETE SET NULL,
  silo_id smallint REFERENCES noderag.silo(id) ON DELETE SET NULL,
  action text NOT NULL,
  result text NOT NULL CHECK (result IN ('ok', 'denied', 'error')),
  query_sha256 bytea CHECK (query_sha256 IS NULL OR octet_length(query_sha256) = 32),
  row_count integer CHECK (row_count >= 0),
  detail jsonb NOT NULL DEFAULT '{}',
  source_ip inet,
  request_id text
);
CREATE INDEX audit_log_occurred_idx ON noderag.audit_log (occurred_at DESC);
CREATE INDEX audit_log_principal_occurred_idx
  ON noderag.audit_log (principal_id, occurred_at DESC);

CREATE TABLE noderag.idempotency_record (
  principal_id bigint NOT NULL REFERENCES noderag.principal(id) ON DELETE CASCADE,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_headers jsonb,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (principal_id, operation, idempotency_key)
);
CREATE INDEX idempotency_expiry_idx ON noderag.idempotency_record (expires_at);

CREATE TABLE noderag.setup_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state text NOT NULL DEFAULT 'unconfigured'
    CHECK (state IN ('unconfigured', 'initializing', 'operational', 'maintenance',
                     'upgrade_required', 'database_ahead', 'degraded', 'unavailable')),
  setup_token_sha256 bytea CHECK (setup_token_sha256 IS NULL OR octet_length(setup_token_sha256) = 32),
  configured_at timestamptz,
  configured_by bigint REFERENCES noderag.principal(id),
  last_error text
);

INSERT INTO noderag.model_manifest (
  name, source_revision, artifact_sha256, tokenizer_revision, quantization,
  dimensions, maximum_tokens, pooling, normalization, query_prefix,
  document_prefix, license, active
) VALUES (
  'Qwen3-Embedding-0.6B',
  'bd58e9fd4b0467770da53678d8da25481c0f959b',
  'a7eda29cc374b01ae75eb1af1ab65c3c61a64c43f39f16e08c6e37c075dcbf4d',
  'bd58e9fd4b0467770da53678d8da25481c0f959b',
  'q8-avx2', 1024, 1024, 'last_token', 'l2',
  E'Instruct: Given a user search query, retrieve relevant passages that answer the query\nQuery: ',
  '', 'Apache-2.0', true
);

INSERT INTO noderag.setup_state (id, state) VALUES (1, 'unconfigured');
INSERT INTO noderag.settings (id, model_manifest_id)
SELECT 1, id FROM noderag.model_manifest WHERE active;

CREATE FUNCTION noderag.current_silo_ids() RETURNS smallint[]
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('app.silo_ids', true), '') = '' THEN ARRAY[]::smallint[]
    ELSE current_setting('app.silo_ids', true)::smallint[]
  END
$$;

ALTER TABLE noderag.source ENABLE ROW LEVEL SECURITY;
ALTER TABLE noderag.source FORCE ROW LEVEL SECURITY;
CREATE POLICY source_silo_scope ON noderag.source
  USING (silo_id = ANY (noderag.current_silo_ids()))
  WITH CHECK (silo_id = ANY (noderag.current_silo_ids()));

ALTER TABLE noderag.document ENABLE ROW LEVEL SECURITY;
ALTER TABLE noderag.document FORCE ROW LEVEL SECURITY;
CREATE POLICY document_silo_scope ON noderag.document
  USING (silo_id = ANY (noderag.current_silo_ids()))
  WITH CHECK (silo_id = ANY (noderag.current_silo_ids()));

ALTER TABLE noderag.document_page ENABLE ROW LEVEL SECURITY;
ALTER TABLE noderag.document_page FORCE ROW LEVEL SECURITY;
CREATE POLICY document_page_silo_scope ON noderag.document_page
  USING (silo_id = ANY (noderag.current_silo_ids()))
  WITH CHECK (silo_id = ANY (noderag.current_silo_ids()));

ALTER TABLE noderag.document_image ENABLE ROW LEVEL SECURITY;
ALTER TABLE noderag.document_image FORCE ROW LEVEL SECURITY;
CREATE POLICY document_image_silo_scope ON noderag.document_image
  USING (silo_id = ANY (noderag.current_silo_ids()))
  WITH CHECK (silo_id = ANY (noderag.current_silo_ids()));

ALTER TABLE noderag.chunk ENABLE ROW LEVEL SECURITY;
ALTER TABLE noderag.chunk FORCE ROW LEVEL SECURITY;
CREATE POLICY chunk_silo_scope ON noderag.chunk
  USING (silo_id = ANY (noderag.current_silo_ids()))
  WITH CHECK (silo_id = ANY (noderag.current_silo_ids()));
