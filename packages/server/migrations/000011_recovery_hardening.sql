ALTER TABLE noderag.backup_operation DROP CONSTRAINT backup_operation_state_check;

ALTER TABLE noderag.setup_state
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE noderag.backup_operation
  ADD CONSTRAINT backup_operation_state_check
  CHECK (state IN ('queued', 'running', 'verifying', 'succeeded', 'failed', 'cancelled')),
  ADD COLUMN product text NOT NULL DEFAULT 'full'
    CHECK (product IN ('full', 'portable')),
  ADD COLUMN archive_version integer NOT NULL DEFAULT 1 CHECK (archive_version = 1),
  ADD COLUMN archive_path text,
  ADD COLUMN sidecar_path text,
  ADD COLUMN archive_sha256 text CHECK (archive_sha256 IS NULL OR archive_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN archive_bytes bigint CHECK (archive_bytes IS NULL OR archive_bytes >= 0),
  ADD COLUMN volume_count integer CHECK (volume_count IS NULL OR volume_count > 0),
  ADD COLUMN verification_state text NOT NULL DEFAULT 'pending'
    CHECK (verification_state IN ('pending', 'verified', 'failed')),
  ADD COLUMN consistency_at timestamptz,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN encryption jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN include_models boolean NOT NULL DEFAULT false,
  ADD COLUMN failure_detail jsonb NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX backup_operation_one_active_idx
  ON noderag.backup_operation ((true))
  WHERE state IN ('queued', 'running', 'verifying');

ALTER TABLE noderag.restore_operation DROP CONSTRAINT restore_operation_state_check;
ALTER TABLE noderag.restore_operation
  ADD CONSTRAINT restore_operation_state_check
  CHECK (state IN ('queued', 'inspecting', 'ready', 'staging', 'verifying',
                   'activating', 'succeeded', 'failed', 'cancelled')),
  ADD COLUMN sidecar_path text,
  ADD COLUMN inspection jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN confirmation text,
  ADD COLUMN staging_path text,
  ADD COLUMN safety_backup_id bigint REFERENCES noderag.backup_operation(id),
  ADD COLUMN verification jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN started_at timestamptz,
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN failure_detail jsonb NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX restore_operation_one_active_idx
  ON noderag.restore_operation ((true))
  WHERE state IN ('queued', 'inspecting', 'ready', 'staging', 'verifying', 'activating');

CREATE TABLE noderag.restore_finding (
  id bigserial PRIMARY KEY,
  restore_id bigint NOT NULL REFERENCES noderag.restore_operation(id) ON DELETE CASCADE,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 160),
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX restore_finding_operation_idx ON noderag.restore_finding (restore_id, id);

CREATE TABLE noderag.maintenance_barrier (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  state text NOT NULL DEFAULT 'inactive'
    CHECK (state IN ('inactive', 'entering', 'quiesced')),
  kind text CHECK (kind IS NULL OR kind IN ('backup', 'restore', 'upgrade')),
  operation_id bigint,
  owner_token text,
  entered_at timestamptz,
  quiesced_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'inactive' AND kind IS NULL AND operation_id IS NULL AND owner_token IS NULL)
      OR (state <> 'inactive' AND kind IS NOT NULL AND operation_id IS NOT NULL
          AND owner_token IS NOT NULL))
);
INSERT INTO noderag.maintenance_barrier (id) VALUES (true);

CREATE TABLE noderag.backup_schedule (
  id smallserial PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 120),
  product text NOT NULL DEFAULT 'full' CHECK (product IN ('full', 'portable')),
  destination_id smallint NOT NULL REFERENCES noderag.storage_location(id),
  cadence text NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  utc_hour smallint NOT NULL CHECK (utc_hour BETWEEN 0 AND 23),
  utc_minute smallint NOT NULL CHECK (utc_minute BETWEEN 0 AND 59),
  utc_weekday smallint CHECK (utc_weekday IS NULL OR utc_weekday BETWEEN 0 AND 6),
  enabled boolean NOT NULL DEFAULT false,
  secret_provider text NOT NULL DEFAULT 'backup-schedule',
  secret_name text NOT NULL,
  secret_fingerprint text NOT NULL CHECK (secret_fingerprint ~ '^[a-f0-9]{16}$'),
  retain_count integer NOT NULL DEFAULT 7 CHECK (retain_count BETWEEN 1 AND 365),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_backup_id bigint REFERENCES noderag.backup_operation(id),
  last_result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES noderag.principal(id),
  CHECK ((cadence = 'daily' AND utc_weekday IS NULL)
      OR (cadence = 'weekly' AND utc_weekday IS NOT NULL))
);

CREATE TABLE noderag.upgrade_rehearsal (
  id bigserial PRIMARY KEY,
  from_version text NOT NULL,
  to_version text NOT NULL,
  from_postgres_major integer NOT NULL CHECK (from_postgres_major > 0),
  to_postgres_major integer NOT NULL CHECK (to_postgres_major > 0),
  migration_head text NOT NULL,
  state text NOT NULL DEFAULT 'planned'
    CHECK (state IN ('planned', 'preflight', 'backed_up', 'restoring', 'verifying',
                     'activated', 'rolled_back', 'succeeded', 'failed')),
  required_free_bytes bigint NOT NULL DEFAULT 0 CHECK (required_free_bytes >= 0),
  measured_free_bytes bigint CHECK (measured_free_bytes IS NULL OR measured_free_bytes >= 0),
  safety_backup_id bigint REFERENCES noderag.backup_operation(id),
  verification jsonb NOT NULL DEFAULT '{}',
  failure_detail jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz,
  finished_at timestamptz,
  requested_by bigint REFERENCES noderag.principal(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION noderag.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('app.restore_mode', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('app.audit_retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND pg_trigger_depth() > 1
     AND (NEW.id, NEW.occurred_at, NEW.principal_id, NEW.action, NEW.result,
          NEW.query_sha256, NEW.row_count, NEW.detail, NEW.source_ip, NEW.request_id)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.occurred_at, OLD.principal_id, OLD.action, OLD.result,
          OLD.query_sha256, OLD.row_count, OLD.detail, OLD.source_ip, OLD.request_id)
     AND (NEW.gateway_id IS NOT DISTINCT FROM OLD.gateway_id
          OR (OLD.gateway_id IS NOT NULL AND NEW.gateway_id IS NULL))
     AND (NEW.silo_id IS NOT DISTINCT FROM OLD.silo_id
          OR (OLD.silo_id IS NOT NULL AND NEW.silo_id IS NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END
$function$;

CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON noderag.audit_log
FOR EACH ROW EXECUTE FUNCTION noderag.reject_audit_mutation();

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'recovery-hardening',
  '{"schemaVersion":11,"milestone":"M13","archiveVersion":1,"postgresMajor":17}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
