ALTER TABLE noderag.chat_model_profile
  DROP CONSTRAINT chat_model_profile_reasoning_efforts_check;

ALTER TABLE noderag.chat_model_profile
  ADD CONSTRAINT chat_model_profile_reasoning_efforts_check CHECK (
    cardinality(reasoning_efforts) BETWEEN 1 AND 16 AND
    array_to_string(reasoning_efforts, ',') ~
      '^[a-z][a-z0-9_-]{0,31}(,[a-z][a-z0-9_-]{0,31})*$'
  );

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'chat-openai-oauth',
  '{"schemaVersion":20,"credentialMode":"encrypted-device-code-cache","browserTokensAccepted":false,"chatExecutionEnabled":false}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

