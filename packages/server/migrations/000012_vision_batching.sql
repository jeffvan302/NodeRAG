ALTER TABLE noderag.settings
  ADD COLUMN ollama_images_per_call integer NOT NULL DEFAULT 5
    CHECK (ollama_images_per_call BETWEEN 1 AND 16);

UPDATE noderag.settings
SET vision_prompt_revision = 'vision-transcription.v2',
    vision_schema_revision = 'vision-result.v2',
    updated_at = now();

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'vision-batching',
  '{"schemaVersion":12,"maximumImagesPerCallDefault":5}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
