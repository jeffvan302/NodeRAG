ALTER TABLE noderag.chat_tool_call DROP CONSTRAINT chat_tool_call_tool_name_check;

ALTER TABLE noderag.chat_tool_call
  ADD CONSTRAINT chat_tool_call_tool_name_check CHECK (
    tool_name IN (
      'research.list_sources.v1',
      'research.read_page.v1',
      'research.read_document.v1',
      'rag.search.v1',
      'document.read_markdown.v1',
      'web.search.v1',
      'web.fetch.v1'
    )
  );

CREATE UNIQUE INDEX chat_tool_call_web_request_once_idx
  ON noderag.chat_tool_call (run_id,tool_name,request_sha256)
  WHERE tool_name IN ('web.search.v1','web.fetch.v1');

CREATE TABLE noderag.chat_web_citation (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES noderag.chat_message(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES noderag.chat_run(id) ON DELETE CASCADE,
  tool_call_id uuid NOT NULL REFERENCES noderag.chat_tool_call(id) ON DELETE CASCADE,
  parent_citation_id uuid,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 9999),
  citation_label text NOT NULL CHECK (citation_label ~ '^W[1-9][0-9]{0,3}$'),
  source_kind text NOT NULL CHECK (source_kind IN ('search_result','fetched_page')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 1000),
  url text NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  canonical_url text NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 2048),
  hostname text NOT NULL CHECK (length(hostname) BETWEEN 1 AND 253),
  content_text text NOT NULL CHECK (length(content_text) BETWEEN 1 AND 120000),
  content_truncated boolean NOT NULL DEFAULT false,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256)=32),
  query_sha256 bytea NOT NULL CHECK (octet_length(query_sha256)=32),
  result_rank integer CHECK (result_rank BETWEEN 1 AND 10),
  links jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(links)='array'),
  provider_kind text NOT NULL DEFAULT 'ollama_cloud' CHECK (provider_kind='ollama_cloud'),
  provider_endpoint text NOT NULL CHECK (
    provider_endpoint IN (
      'https://ollama.com/api/web_search',
      'https://ollama.com/api/web_fetch'
    )
  ),
  provider_request_id text CHECK (
    provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 300
  ),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  retrieved_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id,citation_label),
  UNIQUE (message_id,ordinal),
  UNIQUE (tool_call_id,canonical_url,source_kind),
  CONSTRAINT chat_web_citation_parent_fk FOREIGN KEY (parent_citation_id)
    REFERENCES noderag.chat_web_citation(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (source_kind='search_result' AND parent_citation_id IS NULL AND result_rank IS NOT NULL AND
     provider_endpoint='https://ollama.com/api/web_search') OR
    (source_kind='fetched_page' AND parent_citation_id IS NOT NULL AND result_rank IS NULL AND
     provider_endpoint='https://ollama.com/api/web_fetch')
  )
);

CREATE INDEX chat_web_citation_message_idx
  ON noderag.chat_web_citation (message_id,citation_label);

CREATE INDEX chat_web_citation_run_idx
  ON noderag.chat_web_citation (run_id,source_kind,captured_at);

CREATE TRIGGER chat_web_citation_immutable
BEFORE UPDATE ON noderag.chat_web_citation
FOR EACH ROW EXECUTE FUNCTION noderag.prevent_chat_research_revision_mutation();

CREATE TABLE noderag.chat_web_usage_minute (
  connection_id bigint NOT NULL REFERENCES noderag.chat_provider_connection(id) ON DELETE CASCADE,
  minute_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 60000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id,minute_start),
  CHECK (date_trunc('minute',minute_start)=minute_start)
);

INSERT INTO noderag.system_metadata (key,value)
VALUES (
  'chat-web',
  '{"schemaVersion":25,"provider":"ollama_cloud","searchEndpoint":"https://ollama.com/api/web_search","fetchEndpoint":"https://ollama.com/api/web_fetch","localOllamaAccepted":false,"openAiBrowsingAccepted":false}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
