ALTER TABLE noderag.chat_model_profile
  ADD COLUMN administrator_context_tokens integer
    CHECK (administrator_context_tokens BETWEEN 1024 AND 10000000),
  ADD COLUMN administrator_output_tokens integer
    CHECK (administrator_output_tokens BETWEEN 128 AND 1000000),
  ADD COLUMN administrator_note text
    CHECK (administrator_note IS NULL OR length(administrator_note) BETWEEN 1 AND 500);

CREATE TABLE noderag.chat_known_model_capacity (
  provider_kind text NOT NULL
    CHECK (provider_kind IN ('ollama_cloud', 'openai_oauth')),
  model_pattern text NOT NULL CHECK (length(model_pattern) BETWEEN 1 AND 180),
  revision text NOT NULL CHECK (length(revision) BETWEEN 1 AND 120),
  context_tokens integer NOT NULL CHECK (context_tokens BETWEEN 1024 AND 10000000),
  maximum_output_tokens integer CHECK (maximum_output_tokens BETWEEN 128 AND 1000000),
  source_note text NOT NULL CHECK (length(source_note) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_kind, model_pattern, revision)
);

CREATE TABLE noderag.chat_context_settings_revision (
  id bigserial PRIMARY KEY,
  revision_id uuid NOT NULL UNIQUE,
  rolling_turn_limit integer NOT NULL CHECK (rolling_turn_limit BETWEEN 1 AND 500),
  input_reserve_tokens integer NOT NULL CHECK (input_reserve_tokens BETWEEN 0 AND 1000000),
  output_reserve_tokens integer NOT NULL CHECK (output_reserve_tokens BETWEEN 128 AND 1000000),
  pinned_instruction_reserve_tokens integer NOT NULL
    CHECK (pinned_instruction_reserve_tokens BETWEEN 0 AND 1000000),
  tool_result_reserve_tokens integer NOT NULL
    CHECK (tool_result_reserve_tokens BETWEEN 0 AND 1000000),
  managed_enabled boolean NOT NULL DEFAULT false,
  managed_trigger_percent numeric(5,2) NOT NULL
    CHECK (managed_trigger_percent BETWEEN 25 AND 95),
  managed_keep_recent_turns integer NOT NULL
    CHECK (managed_keep_recent_turns BETWEEN 1 AND 100),
  l1_pin_limit_tokens integer NOT NULL CHECK (l1_pin_limit_tokens BETWEEN 0 AND 1000000),
  l2_connection_id bigint REFERENCES noderag.chat_provider_connection(id),
  l2_model text CHECK (l2_model IS NULL OR length(l2_model) BETWEEN 1 AND 180),
  l2_reasoning_effort text CHECK (
    l2_reasoning_effort IS NULL OR l2_reasoning_effort ~ '^[a-z][a-z0-9_-]{0,31}$'
  ),
  l2_instructions text CHECK (l2_instructions IS NULL OR length(l2_instructions) <= 20000),
  l2_output_target_tokens integer CHECK (l2_output_target_tokens BETWEEN 128 AND 1000000),
  l3_connection_id bigint REFERENCES noderag.chat_provider_connection(id),
  l3_model text CHECK (l3_model IS NULL OR length(l3_model) BETWEEN 1 AND 180),
  l3_reasoning_effort text CHECK (
    l3_reasoning_effort IS NULL OR l3_reasoning_effort ~ '^[a-z][a-z0-9_-]{0,31}$'
  ),
  l3_instructions text CHECK (l3_instructions IS NULL OR length(l3_instructions) <= 20000),
  l3_output_target_tokens integer CHECK (l3_output_target_tokens BETWEEN 128 AND 1000000),
  l3_state_schema jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(l3_state_schema) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES noderag.principal(id),
  CHECK (
    NOT managed_enabled OR (
      l2_connection_id IS NOT NULL AND l2_model IS NOT NULL AND l2_reasoning_effort IS NOT NULL AND
      l2_instructions IS NOT NULL AND l2_output_target_tokens IS NOT NULL AND
      l3_connection_id IS NOT NULL AND l3_model IS NOT NULL AND l3_reasoning_effort IS NOT NULL AND
      l3_instructions IS NOT NULL AND l3_output_target_tokens IS NOT NULL
    )
  )
);

CREATE TABLE noderag.chat_context_component_test (
  context_revision_id bigint NOT NULL
    REFERENCES noderag.chat_context_settings_revision(id) ON DELETE CASCADE,
  layer text NOT NULL CHECK (layer IN ('l2', 'l3')),
  status text NOT NULL CHECK (status IN ('untested', 'healthy', 'failed')),
  safe_error_code text CHECK (
    safe_error_code IS NULL OR safe_error_code ~ '^[a-z][a-z0-9_-]{0,119}$'
  ),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  tested_at timestamptz,
  PRIMARY KEY (context_revision_id, layer),
  CHECK (
    (status = 'untested' AND tested_at IS NULL AND safe_error_code IS NULL) OR status <> 'untested'
  )
);

CREATE TABLE noderag.chat_settings_revision (
  id bigserial PRIMARY KEY,
  revision_id uuid NOT NULL UNIQUE,
  context_revision_id bigint NOT NULL REFERENCES noderag.chat_context_settings_revision(id),
  default_connection_id bigint REFERENCES noderag.chat_provider_connection(id),
  default_model text CHECK (default_model IS NULL OR length(default_model) BETWEEN 1 AND 180),
  default_reasoning_effort text NOT NULL
    CHECK (default_reasoning_effort ~ '^[a-z][a-z0-9_-]{0,31}$'),
  default_context_mode text NOT NULL CHECK (default_context_mode IN ('rolling', 'managed')),
  default_allow_research boolean NOT NULL DEFAULT false,
  default_allow_rag boolean NOT NULL DEFAULT false,
  default_allow_internet boolean NOT NULL DEFAULT false,
  markdown_only boolean NOT NULL DEFAULT true CHECK (markdown_only),
  run_timeout_ms integer NOT NULL CHECK (run_timeout_ms BETWEEN 10000 AND 1800000),
  maximum_tool_calls integer NOT NULL CHECK (maximum_tool_calls BETWEEN 0 AND 100),
  maximum_parallel_runs_per_user integer NOT NULL
    CHECK (maximum_parallel_runs_per_user BETWEEN 1 AND 32),
  daily_run_quota integer CHECK (daily_run_quota BETWEEN 1 AND 1000000),
  daily_input_token_quota bigint CHECK (daily_input_token_quota BETWEEN 1000 AND 1000000000000),
  daily_output_token_quota bigint CHECK (daily_output_token_quota BETWEEN 1000 AND 1000000000000),
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  archive_after_days integer NOT NULL CHECK (archive_after_days BETWEEN 1 AND retention_days),
  storage_requested_path text CHECK (
    storage_requested_path IS NULL OR length(storage_requested_path) BETWEEN 1 AND 4096
  ),
  storage_resolved_path text CHECK (
    storage_resolved_path IS NULL OR length(storage_resolved_path) BETWEEN 1 AND 4096
  ),
  storage_manifest_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES noderag.principal(id),
  CHECK (
    (default_connection_id IS NULL AND default_model IS NULL) OR
    (default_connection_id IS NOT NULL AND default_model IS NOT NULL)
  ),
  CHECK (
    (storage_requested_path IS NULL AND storage_resolved_path IS NULL AND storage_manifest_id IS NULL) OR
    (storage_requested_path IS NOT NULL AND storage_resolved_path IS NOT NULL AND storage_manifest_id IS NOT NULL)
  )
);

CREATE TABLE noderag.chat_configuration_current (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  context_revision_id bigint NOT NULL REFERENCES noderag.chat_context_settings_revision(id),
  settings_revision_id bigint NOT NULL REFERENCES noderag.chat_settings_revision(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES noderag.principal(id)
);

CREATE FUNCTION noderag.prevent_chat_configuration_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('noderag.restore_mode', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'chat_configuration_revision_immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER chat_context_settings_revision_immutable
BEFORE UPDATE OR DELETE ON noderag.chat_context_settings_revision
FOR EACH ROW EXECUTE FUNCTION noderag.prevent_chat_configuration_revision_mutation();

CREATE TRIGGER chat_settings_revision_immutable
BEFORE UPDATE OR DELETE ON noderag.chat_settings_revision
FOR EACH ROW EXECUTE FUNCTION noderag.prevent_chat_configuration_revision_mutation();

INSERT INTO noderag.chat_context_settings_revision (
  revision_id, rolling_turn_limit, input_reserve_tokens, output_reserve_tokens,
  pinned_instruction_reserve_tokens, tool_result_reserve_tokens, managed_enabled,
  managed_trigger_percent, managed_keep_recent_turns, l1_pin_limit_tokens
) VALUES (
  '00000000-0000-4000-8000-000000000003', 12, 1024, 4096, 2048, 8192,
  false, 75, 8, 4096
);

INSERT INTO noderag.chat_settings_revision (
  revision_id, context_revision_id, default_reasoning_effort, default_context_mode,
  default_allow_research, default_allow_rag, default_allow_internet, markdown_only,
  run_timeout_ms, maximum_tool_calls, maximum_parallel_runs_per_user,
  daily_run_quota, daily_input_token_quota, daily_output_token_quota,
  retention_days, archive_after_days
) SELECT
  '00000000-0000-4000-8000-000000000004', context.id, 'default', 'rolling',
  false, false, false, true, 120000, 8, 2, 100, 1000000, 250000, 365, 30
FROM noderag.chat_context_settings_revision AS context
WHERE context.revision_id='00000000-0000-4000-8000-000000000003';

INSERT INTO noderag.chat_configuration_current (
  singleton, context_revision_id, settings_revision_id
) SELECT true, context.id, settings.id
FROM noderag.chat_context_settings_revision AS context
CROSS JOIN noderag.chat_settings_revision AS settings
WHERE context.revision_id='00000000-0000-4000-8000-000000000003'
  AND settings.revision_id='00000000-0000-4000-8000-000000000004';

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'chat-configuration',
  '{"schemaVersion":21,"settingsContract":"chat-settings.v1","chatExecutionEnabled":false,"ollamaCloudOnly":true,"internetProvider":"ollama_cloud"}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
