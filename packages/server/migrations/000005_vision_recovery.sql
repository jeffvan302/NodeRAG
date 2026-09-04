ALTER TABLE noderag.settings
  ADD COLUMN ollama_model_revision text,
  ADD COLUMN ollama_keep_alive text NOT NULL DEFAULT '30m',
  ADD COLUMN ollama_num_ctx integer NOT NULL DEFAULT 8192
    CHECK (ollama_num_ctx BETWEEN 1024 AND 131072),
  ADD COLUMN ollama_max_attempts integer NOT NULL DEFAULT 3
    CHECK (ollama_max_attempts BETWEEN 1 AND 10),
  ADD COLUMN vision_prompt_revision text NOT NULL DEFAULT 'vision-transcription.v1',
  ADD COLUMN vision_schema_revision text NOT NULL DEFAULT 'vision-result.v1',
  ADD COLUMN vision_preprocessing_revision text NOT NULL DEFAULT 'vision-preprocess.v1',
  ADD COLUMN vision_activated_at timestamptz,
  ADD COLUMN vision_sample_elapsed_ms integer CHECK (vision_sample_elapsed_ms >= 0);

ALTER TABLE noderag.vision_cache
  ADD COLUMN cache_key bytea,
  ADD COLUMN preprocessed_sha256 bytea CHECK (
    preprocessed_sha256 IS NULL OR octet_length(preprocessed_sha256) = 32
  ),
  ADD COLUMN provider text NOT NULL DEFAULT 'legacy',
  ADD COLUMN provider_revision text NOT NULL DEFAULT 'legacy',
  ADD COLUMN model_revision text NOT NULL DEFAULT 'legacy',
  ADD COLUMN prompt_revision text NOT NULL DEFAULT 'legacy',
  ADD COLUMN schema_revision text NOT NULL DEFAULT 'legacy',
  ADD COLUMN preprocessing_revision text NOT NULL DEFAULT 'legacy';
UPDATE noderag.vision_cache SET cache_key = image_sha256 WHERE cache_key IS NULL;
ALTER TABLE noderag.vision_cache
  ALTER COLUMN cache_key SET NOT NULL,
  DROP CONSTRAINT vision_cache_pkey,
  ADD PRIMARY KEY (cache_key);
CREATE UNIQUE INDEX vision_cache_revision_identity_idx ON noderag.vision_cache (
  image_sha256, preprocessed_sha256, provider, model, provider_revision,
  model_revision, prompt_revision, schema_revision, preprocessing_revision
);

ALTER TABLE noderag.document_image
  ADD COLUMN external_id text,
  ADD COLUMN media_type text,
  ADD COLUMN storage_path text,
  ADD COLUMN cache_key bytea REFERENCES noderag.vision_cache(cache_key) ON DELETE SET NULL,
  ADD COLUMN preprocessed_sha256 bytea CHECK (
    preprocessed_sha256 IS NULL OR octet_length(preprocessed_sha256) = 32
  ),
  ADD COLUMN vision_provider text,
  ADD COLUMN vision_kind text CHECK (
    vision_kind IS NULL OR vision_kind IN (
      'table', 'chart', 'diagram', 'screenshot', 'photo', 'formula', 'logo', 'decorative'
    )
  ),
  ADD COLUMN vision_markdown text,
  ADD COLUMN vision_alt text,
  ADD COLUMN vision_confidence real CHECK (vision_confidence BETWEEN 0 AND 1),
  ADD COLUMN provider_revision text,
  ADD COLUMN model_revision text,
  ADD COLUMN prompt_revision text,
  ADD COLUMN schema_revision text,
  ADD COLUMN preprocessing_revision text,
  ADD COLUMN dispatched_at timestamptz,
  ADD COLUMN analysed_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);

CREATE TABLE noderag.vision_dispatch (
  id bigserial PRIMARY KEY,
  cache_key bytea NOT NULL CHECK (octet_length(cache_key) = 32),
  image_sha256 bytea NOT NULL CHECK (octet_length(image_sha256) = 32),
  request_kind text NOT NULL CHECK (
    request_kind IN ('pdf-page', 'document-image', 'worksheet-image')
  ),
  page_number integer,
  image_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  state text NOT NULL DEFAULT 'dispatched'
    CHECK (state IN ('dispatched', 'validated', 'failed')),
  error_code text,
  dispatched_at timestamptz NOT NULL,
  settled_at timestamptz,
  CHECK ((state = 'dispatched') = (settled_at IS NULL))
);
CREATE INDEX vision_dispatch_cache_idx ON noderag.vision_dispatch (cache_key, dispatched_at DESC);
CREATE INDEX vision_dispatch_open_idx ON noderag.vision_dispatch (dispatched_at)
  WHERE state = 'dispatched';
