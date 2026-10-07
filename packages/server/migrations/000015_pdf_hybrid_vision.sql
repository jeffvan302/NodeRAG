ALTER TABLE noderag.vision_dispatch
  DROP CONSTRAINT vision_dispatch_request_kind_check,
  ADD CONSTRAINT vision_dispatch_request_kind_check
    CHECK (request_kind IN ('pdf-page', 'pdf-region', 'document-image', 'worksheet-image'));

ALTER TABLE noderag.vision_cache
  ADD COLUMN source_policy_revision text NOT NULL DEFAULT 'source-policy.none',
  ADD COLUMN layout_blocks jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(layout_blocks) = 'array');

DROP INDEX noderag.vision_cache_revision_identity_idx;
CREATE UNIQUE INDEX vision_cache_revision_identity_idx ON noderag.vision_cache (
  image_sha256, preprocessed_sha256, provider, model, provider_revision,
  model_revision, prompt_revision, schema_revision, preprocessing_revision,
  source_policy_revision
);

UPDATE noderag.settings
SET vision_prompt_revision = 'vision-transcription.v3-layout',
    vision_schema_revision = 'vision-result.v3-layout-blocks',
    updated_at = now()
WHERE id = 1;

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'pdf-hybrid-vision',
  '{"schemaVersion":15,"pdfExtractionVersion":"pdf-layout.v3-hybrid","layoutPolicyRevision":"native-layout.v1","confidencePolicyRevision":"pdf-confidence.v1","visionPromptRevision":"vision-transcription.v3-layout","visionSchemaRevision":"vision-result.v3-layout-blocks","cropPolicyRevision":"pdf-crop.v1-margin-015"}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
