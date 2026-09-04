DROP INDEX noderag.build_one_active_idx;

ALTER TABLE noderag.model_manifest
  ADD COLUMN manifest_digest text;

UPDATE noderag.model_manifest
SET manifest_digest = encode(sha256(convert_to(
  concat_ws(E'\n', name, source_revision, artifact_sha256, tokenizer_revision,
            quantization, dimensions::text, maximum_tokens::text, pooling,
            normalization, query_prefix, document_prefix, license),
  'UTF8')), 'hex');

ALTER TABLE noderag.model_manifest
  ALTER COLUMN manifest_digest SET NOT NULL,
  ADD CONSTRAINT model_manifest_digest_format_check
    CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT model_manifest_digest_unique UNIQUE (manifest_digest);

CREATE FUNCTION noderag.reject_model_manifest_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
     OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
     OR NEW.tokenizer_revision IS DISTINCT FROM OLD.tokenizer_revision
     OR NEW.quantization IS DISTINCT FROM OLD.quantization
     OR NEW.dimensions IS DISTINCT FROM OLD.dimensions
     OR NEW.maximum_tokens IS DISTINCT FROM OLD.maximum_tokens
     OR NEW.pooling IS DISTINCT FROM OLD.pooling
     OR NEW.normalization IS DISTINCT FROM OLD.normalization
     OR NEW.query_prefix IS DISTINCT FROM OLD.query_prefix
     OR NEW.document_prefix IS DISTINCT FROM OLD.document_prefix
     OR NEW.license IS DISTINCT FROM OLD.license
     OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest THEN
    RAISE EXCEPTION 'model manifests are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER model_manifest_immutable
BEFORE UPDATE ON noderag.model_manifest
FOR EACH ROW EXECUTE FUNCTION noderag.reject_model_manifest_mutation();

ALTER TABLE noderag.embedding_cache
  ALTER COLUMN embedding TYPE halfvec,
  ADD CONSTRAINT embedding_cache_dimensions_match
    CHECK (vector_dims(embedding) = dimensions);

ALTER TABLE noderag.build
  ADD COLUMN profile_digest text,
  ADD COLUMN model_digest text,
  ADD COLUMN dimensions integer,
  ADD COLUMN activation_kind text,
  ADD COLUMN proposal_id bigint,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN confirmed_by bigint REFERENCES noderag.principal(id),
  ADD COLUMN verification_summary jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN rollback_expires_at timestamptz;

UPDATE noderag.build b
SET profile_digest = encode(sha256(convert_to(
      concat_ws(E'\n', b.target_chars::text, b.overlap_chars::text,
                b.max_tokens::text, b.snap_window::text,
                b.heading_prefix::text, b.rules_version::text,
                b.model_manifest_id::text, b.query_prefix), 'UTF8')), 'hex'),
    model_digest = m.manifest_digest,
    dimensions = m.dimensions,
    activation_kind = 'same_model'
FROM noderag.model_manifest m
WHERE m.id = b.model_manifest_id;

ALTER TABLE noderag.build
  ALTER COLUMN profile_digest SET NOT NULL,
  ALTER COLUMN model_digest SET NOT NULL,
  ALTER COLUMN dimensions SET NOT NULL,
  ALTER COLUMN activation_kind SET NOT NULL,
  ADD CONSTRAINT build_profile_digest_format_check CHECK (profile_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT build_model_digest_format_check CHECK (model_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT build_dimensions_check CHECK (dimensions BETWEEN 1 AND 16000),
  ADD CONSTRAINT build_activation_kind_check
    CHECK (activation_kind IN ('same_model', 'model_revision', 'dimension_change'));

CREATE FUNCTION noderag.reject_build_profile_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.target_chars IS DISTINCT FROM OLD.target_chars
     OR NEW.overlap_chars IS DISTINCT FROM OLD.overlap_chars
     OR NEW.max_tokens IS DISTINCT FROM OLD.max_tokens
     OR NEW.snap_window IS DISTINCT FROM OLD.snap_window
     OR NEW.heading_prefix IS DISTINCT FROM OLD.heading_prefix
     OR NEW.rules_version IS DISTINCT FROM OLD.rules_version
     OR NEW.model_manifest_id IS DISTINCT FROM OLD.model_manifest_id
     OR NEW.query_prefix IS DISTINCT FROM OLD.query_prefix
     OR NEW.profile_digest IS DISTINCT FROM OLD.profile_digest
     OR NEW.model_digest IS DISTINCT FROM OLD.model_digest
     OR NEW.dimensions IS DISTINCT FROM OLD.dimensions
     OR NEW.activation_kind IS DISTINCT FROM OLD.activation_kind
     OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id THEN
    RAISE EXCEPTION 'build inputs are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER build_profile_immutable
BEFORE UPDATE ON noderag.build
FOR EACH ROW EXECUTE FUNCTION noderag.reject_build_profile_mutation();

ALTER TABLE noderag.silo_build_state DROP CONSTRAINT silo_build_state_state_check;
ALTER TABLE noderag.silo_build_state
  ADD CONSTRAINT silo_build_state_state_check
    CHECK (state IN ('pending', 'building', 'paused', 'indexing', 'verifying',
                     'ready', 'active', 'failed', 'cancelled', 'rollback')),
  ADD COLUMN checkpoint_documents bigint NOT NULL DEFAULT 0 CHECK (checkpoint_documents >= 0),
  ADD COLUMN verification_id bigint,
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN rollback_table text,
  ADD CONSTRAINT silo_build_staging_table_check
    CHECK (staging_table IS NULL OR staging_table ~ '^chunk_stage_b[0-9]+_s[0-9]+$'),
  ADD CONSTRAINT silo_build_rollback_table_check
    CHECK (rollback_table IS NULL OR rollback_table ~ '^chunk_rollback_b[0-9]+_s[0-9]+$');

CREATE UNIQUE INDEX silo_one_active_build_idx
  ON noderag.silo_build_state (silo_id) WHERE state = 'active';

CREATE TABLE noderag.rebuild_proposal (
  id bigserial PRIMARY KEY,
  state text NOT NULL DEFAULT 'estimated'
    CHECK (state IN ('estimated', 'confirmed', 'expired', 'cancelled')),
  model_manifest_id smallint NOT NULL REFERENCES noderag.model_manifest(id),
  target_chars integer NOT NULL CHECK (target_chars BETWEEN 200 AND 8000),
  overlap_chars integer NOT NULL CHECK (overlap_chars >= 0),
  max_tokens integer NOT NULL CHECK (max_tokens BETWEEN 128 AND 2048),
  snap_window numeric(4,3) NOT NULL CHECK (snap_window BETWEEN 0 AND 0.500),
  heading_prefix boolean NOT NULL,
  rules_version integer NOT NULL CHECK (rules_version > 0),
  silo_ids smallint[] NOT NULL CHECK (cardinality(silo_ids) > 0),
  source_characters bigint NOT NULL CHECK (source_characters >= 0),
  expected_chunks bigint NOT NULL CHECK (expected_chunks >= 0),
  estimated_embedding_seconds bigint NOT NULL CHECK (estimated_embedding_seconds >= 0),
  estimated_vision_reuse bigint NOT NULL CHECK (estimated_vision_reuse >= 0),
  temporary_bytes bigint NOT NULL CHECK (temporary_bytes >= 0),
  required_free_bytes bigint NOT NULL CHECK (required_free_bytes >= temporary_bytes),
  available_bytes bigint NOT NULL CHECK (available_bytes >= 0),
  estimate_inputs jsonb NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint NOT NULL REFERENCES noderag.principal(id),
  confirmed_at timestamptz,
  confirmed_by bigint REFERENCES noderag.principal(id),
  CHECK (overlap_chars <= target_chars / 2)
);

ALTER TABLE noderag.build
  ADD CONSTRAINT build_proposal_fk
  FOREIGN KEY (proposal_id) REFERENCES noderag.rebuild_proposal(id);

CREATE TABLE noderag.build_document_checkpoint (
  build_id smallint NOT NULL REFERENCES noderag.build(id) ON DELETE CASCADE,
  silo_id smallint NOT NULL REFERENCES noderag.silo(id) ON DELETE CASCADE,
  document_id bigint NOT NULL,
  markdown_sha256 bytea NOT NULL CHECK (octet_length(markdown_sha256) = 32),
  embedded_text_digest bytea NOT NULL CHECK (octet_length(embedded_text_digest) = 32),
  model_manifest_digest text NOT NULL CHECK (model_manifest_digest ~ '^[a-f0-9]{64}$'),
  chunk_count integer NOT NULL CHECK (chunk_count >= 0),
  state text NOT NULL CHECK (state IN ('complete', 'failed')),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (build_id, silo_id, document_id),
  FOREIGN KEY (silo_id, document_id)
    REFERENCES noderag.document(silo_id, id) ON DELETE CASCADE
);

CREATE TABLE noderag.build_verification (
  id bigserial PRIMARY KEY,
  build_id smallint NOT NULL REFERENCES noderag.build(id) ON DELETE CASCADE,
  silo_id smallint NOT NULL REFERENCES noderag.silo(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('passed', 'failed')),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  document_count bigint NOT NULL CHECK (document_count >= 0),
  expected_documents bigint NOT NULL CHECK (expected_documents >= 0),
  current_documents bigint NOT NULL CHECK (current_documents >= 0),
  source_mismatches bigint NOT NULL CHECK (source_mismatches >= 0),
  locator_mismatches bigint NOT NULL CHECK (locator_mismatches >= 0),
  null_or_nonfinite_vectors bigint NOT NULL CHECK (null_or_nonfinite_vectors >= 0),
  dimension_mismatches bigint NOT NULL CHECK (dimension_mismatches >= 0),
  exact_ann_recall double precision CHECK (exact_ann_recall BETWEEN 0 AND 1),
  checks jsonb NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  verified_by bigint REFERENCES noderag.principal(id),
  UNIQUE (build_id, silo_id, id)
);

ALTER TABLE noderag.silo_build_state
  ADD CONSTRAINT silo_build_verification_fk
  FOREIGN KEY (build_id, silo_id, verification_id)
  REFERENCES noderag.build_verification(build_id, silo_id, id);

CREATE TABLE noderag.build_activation_history (
  id bigserial PRIMARY KEY,
  build_id smallint NOT NULL REFERENCES noderag.build(id),
  activation_kind text NOT NULL
    CHECK (activation_kind IN ('same_model', 'model_revision', 'dimension_change', 'rollback')),
  previous_builds jsonb NOT NULL,
  activated_silos smallint[] NOT NULL,
  parent_before text,
  parent_after text,
  state text NOT NULL DEFAULT 'rollback_available'
    CHECK (state IN ('rollback_available', 'rolled_back', 'cleanup_authorized', 'cleaned')),
  activated_at timestamptz NOT NULL DEFAULT now(),
  activated_by bigint NOT NULL REFERENCES noderag.principal(id),
  rolled_back_at timestamptz,
  cleanup_authorized_at timestamptz,
  cleaned_at timestamptz
);

CREATE TABLE noderag.build_cleanup (
  id bigserial PRIMARY KEY,
  activation_id bigint NOT NULL REFERENCES noderag.build_activation_history(id),
  state text NOT NULL DEFAULT 'authorized'
    CHECK (state IN ('authorized', 'running', 'paused', 'failed', 'completed')),
  destructive_confirmation text NOT NULL,
  checkpoint jsonb NOT NULL DEFAULT '{}',
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by bigint NOT NULL REFERENCES noderag.principal(id),
  completed_at timestamptz,
  UNIQUE (activation_id)
);

INSERT INTO noderag.system_metadata (key, value)
VALUES ('zero-downtime-rebuilds',
        '{"schemaVersion":9,"milestone":"M11","partialBuildSearchable":false,"checkpointDiscardSeparate":true}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
