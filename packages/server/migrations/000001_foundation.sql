CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS noderag;

CREATE TABLE IF NOT EXISTS noderag.system_metadata (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS noderag.migration_checksums (
  migration_id text PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO noderag.system_metadata (key, value)
VALUES ('foundation', '{"schemaVersion":1,"milestone":"M02"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
