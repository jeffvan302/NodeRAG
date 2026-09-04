ALTER TABLE noderag.silo
  ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active', 'purging'));

ALTER TABLE noderag.source
  ADD COLUMN schedule_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN schedule_interval_minutes integer
    CHECK (schedule_interval_minutes IS NULL OR schedule_interval_minutes BETWEEN 1 AND 525600),
  ADD COLUMN operator_note text,
  ADD COLUMN crawl_generation bigint NOT NULL DEFAULT 0 CHECK (crawl_generation >= 0),
  ADD COLUMN last_success_at timestamptz,
  ADD COLUMN last_failure_at timestamptz,
  ADD COLUMN failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0);

ALTER TABLE noderag.document DROP CONSTRAINT document_source_state_check;
ALTER TABLE noderag.document
  ADD CONSTRAINT document_source_state_check
  CHECK (source_state IN ('present', 'missing', 'detached'));
ALTER TABLE noderag.document
  ADD COLUMN source_note text;
ALTER TABLE noderag.document_image
  ADD COLUMN vision_model text;
ALTER TABLE noderag.chunk
  ADD COLUMN structure_kind text,
  ADD COLUMN structure_kinds text[] NOT NULL DEFAULT '{}',
  ADD COLUMN continuation jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX document_source_relative_path_idx
  ON noderag.document (source_id, relative_path)
  WHERE source_id IS NOT NULL AND relative_path IS NOT NULL;

ALTER TABLE noderag.job DROP CONSTRAINT job_kind_check;
ALTER TABLE noderag.job
  ADD CONSTRAINT job_kind_check
  CHECK (kind IN ('crawl', 'extract', 'vision', 'chunk', 'embed', 'rebuild', 'purge', 'verify'));
ALTER TABLE noderag.job
  ADD COLUMN frozen_config jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN logical_attempt integer NOT NULL DEFAULT 0 CHECK (logical_attempt >= 0),
  ADD COLUMN lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN progress jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN retry_at timestamptz,
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN checkpoint jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN result jsonb,
  ADD COLUMN error_class text
    CHECK (error_class IS NULL OR error_class IN ('transient', 'permanent', 'cancelled', 'indeterminate')),
  ADD COLUMN structured_error jsonb;
CREATE INDEX job_expired_lease_idx ON noderag.job (leased_until, id)
  WHERE state = 'leased';
CREATE INDEX job_silo_event_scope_idx ON noderag.job (silo_id, id);
CREATE UNIQUE INDEX job_one_live_source_kind_idx
  ON noderag.job (source_id, kind)
  WHERE source_id IS NOT NULL
    AND state IN ('pending', 'leased', 'retry_wait', 'paused');

CREATE TABLE noderag.document_dispatch (
  document_id bigint PRIMARY KEY REFERENCES noderag.document(id) ON DELETE CASCADE,
  last_claimed_at timestamptz NOT NULL DEFAULT '-infinity'
);

CREATE TABLE noderag.integrity_finding (
  id bigserial PRIMARY KEY,
  silo_id smallint REFERENCES noderag.silo(id) ON DELETE CASCADE,
  document_id bigint,
  chunk_id bigint,
  category text NOT NULL CHECK (category IN (
    'locator_mismatch', 'page_mismatch', 'invalid_unicode',
    'missing_original', 'missing_markdown', 'original_hash_mismatch',
    'markdown_hash_mismatch', 'orphan_file', 'orphan_chunk',
    'invalid_embedding_cache_ref', 'invalid_vision_cache_ref'
  )),
  identity_key text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (category, identity_key)
);
CREATE INDEX integrity_finding_open_idx
  ON noderag.integrity_finding (silo_id, category, last_detected_at DESC)
  WHERE resolved_at IS NULL;

CREATE TABLE noderag.purge_operation (
  id bigserial PRIMARY KEY,
  target_kind text NOT NULL CHECK (target_kind IN ('document', 'silo')),
  silo_id smallint NOT NULL,
  document_id bigint,
  target_label text NOT NULL,
  extension text,
  requested_by bigint REFERENCES noderag.principal(id) ON DELETE SET NULL,
  stage text NOT NULL DEFAULT 'requested'
    CHECK (stage IN ('requested', 'marked', 'rows_removed', 'files_removed', 'completed', 'failed')),
  destroyed_counts jsonb NOT NULL DEFAULT '{}',
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((target_kind = 'document') = (document_id IS NOT NULL))
);
CREATE UNIQUE INDEX purge_one_active_document_idx
  ON noderag.purge_operation (document_id)
  WHERE document_id IS NOT NULL AND stage <> 'completed';
CREATE UNIQUE INDEX purge_one_active_silo_idx
  ON noderag.purge_operation (silo_id)
  WHERE target_kind = 'silo' AND stage <> 'completed';

CREATE TABLE noderag.resource_lease (
  resource text NOT NULL CHECK (resource IN ('cpu', 'embedding', 'hnsw')),
  slot smallint NOT NULL CHECK (slot >= 0),
  owner text,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  leased_until timestamptz,
  PRIMARY KEY (resource, slot)
);
INSERT INTO noderag.resource_lease (resource, slot)
VALUES ('cpu', 0), ('cpu', 1), ('embedding', 0), ('hnsw', 0);

CREATE OR REPLACE FUNCTION noderag.notify_job_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('noderag_job_event', NEW.id::text);
  RETURN NEW;
END
$$;
CREATE TRIGGER job_event_notify
  AFTER INSERT ON noderag.job_event
  FOR EACH ROW EXECUTE FUNCTION noderag.notify_job_event();
