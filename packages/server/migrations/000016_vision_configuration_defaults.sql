ALTER TABLE noderag.settings
  ALTER COLUMN ollama_model SET DEFAULT 'minimax-m3:cloud',
  ALTER COLUMN ollama_parallel SET DEFAULT 2,
  ALTER COLUMN ollama_images_per_call SET DEFAULT 3,
  ALTER COLUMN ollama_timeout_ms SET DEFAULT 120000,
  ALTER COLUMN ollama_max_attempts SET DEFAULT 3,
  ALTER COLUMN max_image_px SET DEFAULT 1650;

UPDATE noderag.settings
SET ollama_model = COALESCE(ollama_model, 'minimax-m3:cloud'),
    ollama_images_per_call = CASE
      WHEN ollama_images_per_call = 5 THEN 3
      ELSE ollama_images_per_call
    END,
    ollama_timeout_ms = CASE
      WHEN ollama_timeout_ms = 60000 THEN 120000
      ELSE ollama_timeout_ms
    END,
    max_image_px = CASE
      WHEN max_image_px IN (1600, 2048) THEN 1650
      ELSE max_image_px
    END,
    updated_at = now()
WHERE id = 1;

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'vision-configuration-defaults',
  '{"schemaVersion":16,"model":"minimax-m3:cloud","parallelCalls":2,"imagesPerCall":3,"timeoutMs":120000,"maximumAttempts":3,"maximumImageDimension":1650,"blankCredentialBehavior":"reuse-encrypted-secret"}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
