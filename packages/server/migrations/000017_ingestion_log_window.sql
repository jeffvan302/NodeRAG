CREATE INDEX job_event_created_at_idx
  ON noderag.job_event (created_at DESC, id DESC);

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'ingestion-log-window',
  '{"schemaVersion":17,"windowHours":24,"maximumReturnedEvents":2000}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
