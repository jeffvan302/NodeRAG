ALTER TABLE noderag.setup_state
  ADD COLUMN setup_token_issued_at timestamptz,
  ADD COLUMN setup_token_expires_at timestamptz,
  ADD COLUMN setup_step text NOT NULL DEFAULT 'verify-token'
    CHECK (setup_step IN ('verify-token', 'administrator', 'sign-in', 'storage',
                         'model', 'calibration', 'vision', 'sources', 'complete')),
  ADD COLUMN setup_progress smallint NOT NULL DEFAULT 0
    CHECK (setup_progress BETWEEN 0 AND 100),
  ADD COLUMN recovery_code_sha256 bytea
    CHECK (recovery_code_sha256 IS NULL OR octet_length(recovery_code_sha256) = 32);

CREATE TABLE noderag.setup_event (
  sequence bigserial PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('token-issued', 'administrator-created',
                                                  'step-completed', 'setup-complete',
                                                  'setup-error')),
  step text NOT NULL,
  progress smallint NOT NULL CHECK (progress BETWEEN 0 AND 100),
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX setup_event_created_idx ON noderag.setup_event (created_at DESC, sequence DESC);
