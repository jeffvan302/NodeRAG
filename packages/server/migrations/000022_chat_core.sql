CREATE TABLE noderag.chat_conversation_configuration_revision (
  id bigserial PRIMARY KEY,
  revision_id uuid NOT NULL UNIQUE,
  settings_revision_id bigint NOT NULL REFERENCES noderag.chat_settings_revision(id),
  context_revision_id bigint NOT NULL REFERENCES noderag.chat_context_settings_revision(id),
  provider_connection_id bigint NOT NULL REFERENCES noderag.chat_provider_connection(id),
  provider_kind text NOT NULL CHECK (provider_kind IN ('ollama_cloud', 'openai_oauth')),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 180),
  reasoning_effort text NOT NULL
    CHECK (reasoning_effort ~ '^[a-z][a-z0-9_-]{0,31}$'),
  context_mode text NOT NULL CHECK (context_mode IN ('rolling', 'managed')),
  allow_research boolean NOT NULL DEFAULT false,
  allow_rag boolean NOT NULL DEFAULT false,
  allow_internet boolean NOT NULL DEFAULT false,
  tool_policy jsonb NOT NULL DEFAULT '{"research":false,"rag":false,"internet":false}'
    CHECK (jsonb_typeof(tool_policy) = 'object'),
  maximum_output_tokens integer CHECK (maximum_output_tokens BETWEEN 128 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint NOT NULL REFERENCES noderag.principal(id)
);

CREATE TABLE noderag.chat_conversation (
  id uuid PRIMARY KEY,
  owner_principal_id bigint NOT NULL REFERENCES noderag.principal(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  configuration_revision_id bigint NOT NULL
    REFERENCES noderag.chat_conversation_configuration_revision(id),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK (
    (state = 'active' AND archived_at IS NULL) OR
    (state = 'archived' AND archived_at IS NOT NULL)
  )
);

CREATE INDEX chat_conversation_owner_recency_idx
  ON noderag.chat_conversation (owner_principal_id, state, updated_at DESC, id);

CREATE TABLE noderag.chat_message (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  role text NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content text NOT NULL CHECK (length(content) <= 2000000),
  state text NOT NULL DEFAULT 'committed'
    CHECK (state IN ('committed', 'streaming', 'failed', 'cancelled')),
  reasoning_summary text CHECK (reasoning_summary IS NULL OR length(reasoning_summary) <= 1000000),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (conversation_id, sequence),
  CHECK (
    (state = 'streaming' AND completed_at IS NULL) OR
    (state <> 'streaming')
  )
);

CREATE INDEX chat_message_conversation_history_idx
  ON noderag.chat_message (conversation_id, sequence DESC);

CREATE TABLE noderag.chat_run (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  request_message_id uuid NOT NULL REFERENCES noderag.chat_message(id),
  response_message_id uuid NOT NULL REFERENCES noderag.chat_message(id),
  retry_of_run_id uuid REFERENCES noderag.chat_run(id),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled')),
  provider_kind text NOT NULL CHECK (provider_kind IN ('ollama_cloud', 'openai_oauth')),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 180),
  reasoning_effort text NOT NULL
    CHECK (reasoning_effort ~ '^[a-z][a-z0-9_-]{0,31}$'),
  context_mode text NOT NULL CHECK (context_mode IN ('rolling', 'managed')),
  configuration_revision_id bigint NOT NULL
    REFERENCES noderag.chat_conversation_configuration_revision(id),
  status_version bigint NOT NULL DEFAULT 0 CHECK (status_version >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  maximum_attempts integer NOT NULL DEFAULT 3 CHECK (maximum_attempts BETWEEN 1 AND 20),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 200),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  leased_until timestamptz,
  heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  provider_request_id text CHECK (
    provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 300
  ),
  safe_error_code text CHECK (
    safe_error_code IS NULL OR safe_error_code ~ '^[a-z][a-z0-9_-]{0,119}$'
  ),
  error_retryable boolean,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_input_tokens bigint NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (lease_owner IS NULL AND leased_until IS NULL) OR
    (lease_owner IS NOT NULL AND leased_until IS NOT NULL)
  )
);

CREATE UNIQUE INDEX chat_run_one_active_per_conversation_idx
  ON noderag.chat_run (conversation_id)
  WHERE status IN ('queued', 'running', 'cancelling');

CREATE INDEX chat_run_claim_idx
  ON noderag.chat_run (status, queued_at, id)
  WHERE status IN ('queued', 'running', 'cancelling');

CREATE TABLE noderag.chat_event (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES noderag.chat_run(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  event_type text NOT NULL CHECK (
    event_type IN (
      'run.queued', 'response.started', 'response.output_text.delta',
      'response.reasoning_summary.delta', 'response.usage', 'response.completed',
      'response.failed', 'run.heartbeat', 'run.cancel_requested', 'run.recovered'
    )
  ),
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  previous_sha256 bytea CHECK (previous_sha256 IS NULL OR octet_length(previous_sha256) = 32),
  event_sha256 bytea NOT NULL CHECK (octet_length(event_sha256) = 32),
  occurred_at timestamptz NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE INDEX chat_event_conversation_replay_idx
  ON noderag.chat_event (conversation_id, id);

CREATE TABLE noderag.chat_log_cursor (
  conversation_id uuid PRIMARY KEY REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  last_event_id bigint REFERENCES noderag.chat_event(id),
  last_event_sha256 bytea CHECK (
    last_event_sha256 IS NULL OR octet_length(last_event_sha256) = 32
  ),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE noderag.chat_usage_daily (
  principal_id bigint NOT NULL REFERENCES noderag.principal(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  run_count integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  PRIMARY KEY (principal_id, usage_date)
);

CREATE TRIGGER chat_conversation_configuration_revision_immutable
BEFORE UPDATE OR DELETE ON noderag.chat_conversation_configuration_revision
FOR EACH ROW EXECUTE FUNCTION noderag.prevent_chat_configuration_revision_mutation();

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'chat-core',
  '{"schemaVersion":22,"contract":"chat-core.v1","ollamaCloudOnly":true,"internetProvider":"ollama_cloud","toolsEnabled":false}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
