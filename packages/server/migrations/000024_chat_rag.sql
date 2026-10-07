ALTER TABLE noderag.chat_tool_call DROP CONSTRAINT chat_tool_call_tool_name_check;

ALTER TABLE noderag.chat_tool_call
  ADD CONSTRAINT chat_tool_call_tool_name_check CHECK (
    tool_name IN (
      'research.list_sources.v1',
      'research.read_page.v1',
      'research.read_document.v1',
      'rag.search.v1',
      'document.read_markdown.v1'
    )
  ),
  ADD COLUMN request_sha256 bytea CHECK (
    request_sha256 IS NULL OR octet_length(request_sha256)=32
  ),
  ADD COLUMN duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  ADD COLUMN result_count integer CHECK (result_count IS NULL OR result_count >= 0),
  ADD COLUMN result_summary jsonb CHECK (
    result_summary IS NULL OR jsonb_typeof(result_summary)='object'
  );

CREATE UNIQUE INDEX chat_tool_call_rag_query_once_idx
  ON noderag.chat_tool_call (run_id,request_sha256)
  WHERE tool_name='rag.search.v1';

CREATE TABLE noderag.chat_rag_citation (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES noderag.chat_message(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES noderag.chat_run(id) ON DELETE CASCADE,
  tool_call_id uuid NOT NULL REFERENCES noderag.chat_tool_call(id) ON DELETE CASCADE,
  citation_label text NOT NULL CHECK (citation_label ~ '^S[1-9][0-9]{0,3}$'),
  silo_id smallint NOT NULL CHECK (silo_id > 0),
  silo_slug text NOT NULL CHECK (length(silo_slug) BETWEEN 1 AND 120),
  document_id bigint NOT NULL CHECK (document_id > 0),
  document_name text NOT NULL CHECK (length(document_name) BETWEEN 1 AND 1000),
  document_title text,
  document_format text NOT NULL CHECK (document_format IN ('pdf','docx','xlsx','txt','md')),
  document_path text,
  chunk_id bigint NOT NULL CHECK (chunk_id > 0),
  chunk_ids bigint[] NOT NULL CHECK (cardinality(chunk_ids) BETWEEN 1 AND 64),
  chunk_ids_truncated boolean NOT NULL DEFAULT false,
  passage_text text NOT NULL CHECK (length(passage_text) BETWEEN 1 AND 200000),
  passage_truncated boolean NOT NULL DEFAULT false,
  passage_character_start integer NOT NULL CHECK (passage_character_start >= 0),
  passage_character_end integer NOT NULL CHECK (passage_character_end >= passage_character_start),
  locator jsonb NOT NULL CHECK (jsonb_typeof(locator)='object'),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='array'),
  query_sha256 bytea NOT NULL CHECK (octet_length(query_sha256)=32),
  search_mode text NOT NULL CHECK (search_mode IN ('vector','semantic','keyword','hybrid')),
  original_sha256 bytea NOT NULL CHECK (octet_length(original_sha256)=32),
  markdown_sha256 bytea CHECK (markdown_sha256 IS NULL OR octet_length(markdown_sha256)=32),
  build_id bigint,
  model_manifest_digest text,
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256)=32),
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id,citation_label),
  UNIQUE (tool_call_id,silo_id,chunk_id)
);

CREATE INDEX chat_rag_citation_message_idx
  ON noderag.chat_rag_citation (message_id,citation_label);

CREATE INDEX chat_rag_citation_document_idx
  ON noderag.chat_rag_citation (silo_id,document_id,captured_at);

CREATE TRIGGER chat_rag_citation_immutable
BEFORE UPDATE ON noderag.chat_rag_citation
FOR EACH ROW EXECUTE FUNCTION noderag.prevent_chat_research_revision_mutation();

INSERT INTO noderag.system_metadata (key,value)
VALUES (
  'chat-rag',
  '{"schemaVersion":24,"currentScopePerCall":true,"directRetrievalService":true,"internetProvider":"ollama_cloud","internetEnabled":false,"localOllamaAccepted":false}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
