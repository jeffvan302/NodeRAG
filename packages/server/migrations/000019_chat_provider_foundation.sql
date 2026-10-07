CREATE TABLE noderag.chat_provider_connection (
  id bigserial PRIMARY KEY,
  provider_kind text NOT NULL UNIQUE
    CHECK (provider_kind IN ('ollama_cloud', 'openai_oauth')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  service_root text,
  enabled boolean NOT NULL DEFAULT false,
  credential_secret_id bigint REFERENCES noderag.encrypted_secret(id) ON DELETE SET NULL,
  generation_model text CHECK (generation_model IS NULL OR length(generation_model) BETWEEN 1 AND 180),
  max_parallel_calls integer NOT NULL DEFAULT 2 CHECK (max_parallel_calls BETWEEN 1 AND 32),
  requests_per_minute integer CHECK (requests_per_minute BETWEEN 1 AND 60000),
  tokens_per_minute integer CHECK (tokens_per_minute BETWEEN 1 AND 1000000000),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES noderag.principal(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES noderag.principal(id),
  CHECK (
    (provider_kind = 'ollama_cloud' AND service_root = 'https://ollama.com') OR
    (provider_kind = 'openai_oauth' AND service_root IS NULL)
  )
);

CREATE TABLE noderag.chat_provider_capability (
  connection_id bigint NOT NULL
    REFERENCES noderag.chat_provider_connection(id) ON DELETE CASCADE,
  capability text NOT NULL
    CHECK (capability IN ('generation', 'model_catalog', 'web_search', 'web_fetch')),
  status text NOT NULL DEFAULT 'untested'
    CHECK (status IN ('untested', 'healthy', 'failed', 'disabled')),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  safe_error_code text CHECK (
    safe_error_code IS NULL OR safe_error_code ~ '^[a-z][a-z0-9_-]{0,119}$'
  ),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  tested_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, capability),
  CHECK (
    (status = 'untested' AND tested_at IS NULL AND latency_ms IS NULL AND safe_error_code IS NULL) OR
    status <> 'untested'
  )
);

CREATE INDEX chat_provider_capability_status_idx
  ON noderag.chat_provider_capability (status, tested_at DESC);

CREATE TABLE noderag.chat_model_profile (
  id bigserial PRIMARY KEY,
  connection_id bigint NOT NULL
    REFERENCES noderag.chat_provider_connection(id) ON DELETE CASCADE,
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 180),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 240),
  reasoning_efforts text[] NOT NULL DEFAULT ARRAY['default']::text[]
    CHECK (
      cardinality(reasoning_efforts) BETWEEN 1 AND 8 AND
      reasoning_efforts <@ ARRAY[
        'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
      ]::text[]
    ),
  advertised_context_tokens integer
    CHECK (advertised_context_tokens BETWEEN 1 AND 10000000),
  configured_context_tokens integer
    CHECK (configured_context_tokens BETWEEN 1 AND 10000000),
  runtime_context_tokens integer
    CHECK (runtime_context_tokens BETWEEN 1 AND 10000000),
  maximum_output_tokens integer
    CHECK (maximum_output_tokens BETWEEN 1 AND 1000000),
  context_provenance text NOT NULL DEFAULT 'unknown'
    CHECK (context_provenance IN ('provider_catalog', 'provider_metadata', 'manual', 'unknown')),
  provenance_note text CHECK (provenance_note IS NULL OR length(provenance_note) <= 500),
  provider_metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(provider_metadata) = 'object'),
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES noderag.principal(id),
  UNIQUE (connection_id, model)
);

CREATE INDEX chat_model_profile_connection_name_idx
  ON noderag.chat_model_profile (connection_id, lower(model));

CREATE TABLE noderag.chat_entitlement (
  principal_id bigint PRIMARY KEY REFERENCES noderag.principal(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES noderag.principal(id)
);

INSERT INTO noderag.chat_entitlement (principal_id, enabled)
SELECT principal_id, server_admin
FROM noderag.app_user
ON CONFLICT (principal_id) DO NOTHING;

INSERT INTO noderag.chat_provider_connection
  (provider_kind, label, service_root, enabled, generation_model, max_parallel_calls)
VALUES
  ('ollama_cloud', 'Ollama Cloud', 'https://ollama.com', false, NULL, 2),
  ('openai_oauth', 'OpenAI OAuth', NULL, false, NULL, 2);

INSERT INTO noderag.chat_provider_capability (connection_id, capability)
SELECT connection.id, capability.name
FROM noderag.chat_provider_connection AS connection
CROSS JOIN (
  VALUES ('generation'), ('model_catalog'), ('web_search'), ('web_fetch')
) AS capability(name)
WHERE
  connection.provider_kind = 'ollama_cloud' OR
  capability.name IN ('generation', 'model_catalog');

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'chat-provider-foundation',
  '{"schemaVersion":19,"contract":"chat-provider.v1","ollamaCloudOnly":true,"featuresEnabled":false}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

