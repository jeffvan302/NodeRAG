CREATE TABLE noderag.chat_research_attachment_revision (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  previous_revision_id uuid REFERENCES noderag.chat_research_attachment_revision(id),
  collection_count integer NOT NULL CHECK (collection_count BETWEEN 1 AND 100),
  snapshot_item_count integer NOT NULL CHECK (snapshot_item_count BETWEEN 0 AND 500),
  hidden_item_count integer NOT NULL CHECK (hidden_item_count >= 0),
  context_character_limit integer NOT NULL CHECK (context_character_limit BETWEEN 1000 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint NOT NULL REFERENCES noderag.principal(id),
  UNIQUE (conversation_id, revision)
);

ALTER TABLE noderag.chat_conversation
  ADD COLUMN current_research_attachment_revision_id uuid
  REFERENCES noderag.chat_research_attachment_revision(id);

ALTER TABLE noderag.chat_run
  ADD COLUMN research_attachment_revision_id uuid
  REFERENCES noderag.chat_research_attachment_revision(id);

CREATE TABLE noderag.chat_research_attachment_collection (
  attachment_revision_id uuid NOT NULL
    REFERENCES noderag.chat_research_attachment_revision(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  source_research_id bigint REFERENCES noderag.research_collection(id) ON DELETE SET NULL,
  research_name text NOT NULL CHECK (length(research_name) BETWEEN 1 AND 120),
  source_updated_at timestamptz NOT NULL,
  total_item_count integer NOT NULL CHECK (total_item_count >= 0),
  visible_item_count integer NOT NULL CHECK (visible_item_count >= 0),
  PRIMARY KEY (attachment_revision_id, ordinal),
  UNIQUE (attachment_revision_id, source_research_id),
  CHECK (visible_item_count <= total_item_count)
);

CREATE TABLE noderag.chat_research_snapshot_item (
  id uuid PRIMARY KEY,
  attachment_revision_id uuid NOT NULL
    REFERENCES noderag.chat_research_attachment_revision(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  citation_label text NOT NULL CHECK (citation_label ~ '^R[1-9][0-9]{0,3}$'),
  source_research_id bigint REFERENCES noderag.research_collection(id) ON DELETE SET NULL,
  source_research_name text NOT NULL CHECK (length(source_research_name) BETWEEN 1 AND 120),
  source_reference_id bigint REFERENCES noderag.research_reference(id) ON DELETE SET NULL,
  silo_id smallint NOT NULL CHECK (silo_id > 0),
  silo_slug text NOT NULL CHECK (length(silo_slug) BETWEEN 1 AND 120),
  document_id bigint NOT NULL CHECK (document_id > 0),
  document_name text NOT NULL CHECK (length(document_name) BETWEEN 1 AND 1000),
  document_title text,
  document_format text NOT NULL CHECK (document_format IN ('pdf','docx','xlsx','txt','md')),
  document_path text,
  page_ordinal integer CHECK (page_ordinal IS NULL OR page_ordinal >= 0),
  chunk_id bigint NOT NULL CHECK (chunk_id > 0),
  chunk_ids bigint[] NOT NULL CHECK (cardinality(chunk_ids) BETWEEN 1 AND 8),
  locator jsonb NOT NULL CHECK (jsonb_typeof(locator)='object'),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='array'),
  query_text text NOT NULL CHECK (length(query_text) BETWEEN 1 AND 4000),
  search_mode text NOT NULL CHECK (search_mode IN ('vector','semantic','keyword','hybrid')),
  original_sha256 bytea NOT NULL CHECK (octet_length(original_sha256)=32),
  markdown_sha256 bytea CHECK (markdown_sha256 IS NULL OR octet_length(markdown_sha256)=32),
  reference_sha256 bytea NOT NULL CHECK (octet_length(reference_sha256)=32),
  source_selected_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attachment_revision_id, ordinal),
  UNIQUE (attachment_revision_id, citation_label),
  UNIQUE (attachment_revision_id, source_reference_id)
);

CREATE INDEX chat_research_snapshot_document_idx
  ON noderag.chat_research_snapshot_item (attachment_revision_id, silo_id, document_id, page_ordinal);

CREATE TABLE noderag.chat_citation (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES noderag.chat_message(id) ON DELETE CASCADE,
  attachment_revision_id uuid NOT NULL
    REFERENCES noderag.chat_research_attachment_revision(id) ON DELETE CASCADE,
  snapshot_item_id uuid NOT NULL REFERENCES noderag.chat_research_snapshot_item(id) ON DELETE CASCADE,
  citation_label text NOT NULL CHECK (citation_label ~ '^R[1-9][0-9]{0,3}$'),
  source_kind text NOT NULL DEFAULT 'research' CHECK (source_kind='research'),
  captured_status text NOT NULL DEFAULT 'active'
    CHECK (captured_status IN ('active','access_revoked','source_stale')),
  locator jsonb NOT NULL CHECK (jsonb_typeof(locator)='object'),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, snapshot_item_id)
);

CREATE INDEX chat_citation_message_idx
  ON noderag.chat_citation (message_id, citation_label);

CREATE TABLE noderag.chat_tool_call (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES noderag.chat_run(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 200),
  tool_name text NOT NULL CHECK (
    tool_name IN (
      'research.list_sources.v1',
      'research.read_page.v1',
      'research.read_document.v1'
    )
  ),
  arguments jsonb NOT NULL CHECK (jsonb_typeof(arguments)='object'),
  status text NOT NULL CHECK (status IN ('running','completed','failed')),
  result_sha256 bytea CHECK (result_sha256 IS NULL OR octet_length(result_sha256)=32),
  result_bytes integer CHECK (result_bytes IS NULL OR result_bytes >= 0),
  safe_error_code text CHECK (
    safe_error_code IS NULL OR safe_error_code ~ '^[a-z][a-z0-9_-]{0,119}$'
  ),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (run_id, call_id),
  UNIQUE (run_id, ordinal)
);

CREATE INDEX chat_tool_call_run_idx ON noderag.chat_tool_call (run_id, started_at, id);

ALTER TABLE noderag.chat_event DROP CONSTRAINT chat_event_event_type_check;
ALTER TABLE noderag.chat_event ADD CONSTRAINT chat_event_event_type_check CHECK (
  event_type IN (
    'run.queued', 'response.started', 'response.output_text.delta',
    'response.reasoning_summary.delta', 'response.tool_call', 'response.usage',
    'response.completed', 'response.failed', 'run.heartbeat', 'run.cancel_requested',
    'run.recovered'
  )
);

CREATE OR REPLACE FUNCTION noderag.prevent_chat_research_revision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('noderag.restore_mode', true) = 'on'
     OR current_setting('app.restore_mode', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'chat_research_revision_immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER chat_research_attachment_revision_immutable
BEFORE UPDATE ON noderag.chat_research_attachment_revision
FOR EACH ROW EXECUTE FUNCTION noderag.prevent_chat_research_revision_mutation();

CREATE TRIGGER chat_research_attachment_collection_immutable
BEFORE UPDATE ON noderag.chat_research_attachment_collection
FOR EACH ROW EXECUTE FUNCTION noderag.prevent_chat_research_revision_mutation();

CREATE TRIGGER chat_research_snapshot_item_immutable
BEFORE UPDATE ON noderag.chat_research_snapshot_item
FOR EACH ROW EXECUTE FUNCTION noderag.prevent_chat_research_revision_mutation();

INSERT INTO noderag.system_metadata (key,value)
VALUES (
  'chat-research',
  '{"schemaVersion":23,"immutableSnapshots":true,"currentGrantRecheck":true,"internetProvider":"ollama_cloud","localOllamaAccepted":false}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
