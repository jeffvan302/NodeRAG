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
      'web.fetch.v1',
      'files.list.v1',
      'files.read.v1',
      'files.create.v1',
      'files.mkdir.v1',
      'files.rename.v1',
      'files.copy.v1',
      'files.patch.v1'
    )
  );

ALTER TABLE noderag.chat_settings_revision
  ADD COLUMN artifact_max_file_bytes bigint NOT NULL DEFAULT 10485760
    CHECK (artifact_max_file_bytes BETWEEN 1024 AND 104857600),
  ADD COLUMN artifact_chat_quota_bytes bigint NOT NULL DEFAULT 268435456
    CHECK (artifact_chat_quota_bytes BETWEEN artifact_max_file_bytes AND 10737418240),
  ADD COLUMN markdown_external_images boolean NOT NULL DEFAULT false,
  ADD COLUMN log_segment_max_bytes integer NOT NULL DEFAULT 8388608
    CHECK (log_segment_max_bytes BETWEEN 1048576 AND 67108864),
  ADD COLUMN log_segment_max_age_minutes integer NOT NULL DEFAULT 1440
    CHECK (log_segment_max_age_minutes BETWEEN 5 AND 10080);

CREATE TABLE noderag.chat_artifact (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  relative_path text NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 1024),
  path_key text NOT NULL CHECK (length(path_key) BETWEEN 1 AND 1024),
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('file','directory')),
  mime_type text CHECK (
    (artifact_kind='directory' AND mime_type IS NULL) OR
    (artifact_kind='file' AND mime_type='text/markdown')
  ),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','deleted')),
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision BETWEEN 0 AND 1000000),
  current_sha256 bytea CHECK (
    (artifact_kind='directory' AND current_sha256 IS NULL) OR
    (artifact_kind='file' AND octet_length(current_sha256)=32)
  ),
  current_bytes bigint NOT NULL DEFAULT 0 CHECK (current_bytes BETWEEN 0 AND 104857600),
  created_by_principal_id bigint NOT NULL REFERENCES noderag.principal(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (
    (artifact_kind='directory' AND current_revision=0 AND current_bytes=0) OR
    (artifact_kind='file' AND current_revision >= 1)
  ),
  CHECK (
    (state='active' AND deleted_at IS NULL) OR
    (state='deleted' AND deleted_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX chat_artifact_active_path_idx
  ON noderag.chat_artifact (conversation_id,path_key)
  WHERE state='active';

CREATE INDEX chat_artifact_conversation_idx
  ON noderag.chat_artifact (conversation_id,state,path_key);

CREATE TABLE noderag.chat_artifact_revision (
  id uuid PRIMARY KEY,
  artifact_id uuid NOT NULL REFERENCES noderag.chat_artifact(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256)=32),
  byte_length bigint NOT NULL CHECK (byte_length BETWEEN 0 AND 104857600),
  storage_relative_path text NOT NULL CHECK (length(storage_relative_path) BETWEEN 1 AND 1024),
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('user','model','system')),
  created_by_principal_id bigint NOT NULL REFERENCES noderag.principal(id),
  message_id uuid REFERENCES noderag.chat_message(id) ON DELETE SET NULL,
  run_id uuid REFERENCES noderag.chat_run(id) ON DELETE SET NULL,
  tool_call_id uuid REFERENCES noderag.chat_tool_call(id) ON DELETE SET NULL,
  source_citations jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(source_citations)='array'),
  previous_revision_id uuid REFERENCES noderag.chat_artifact_revision(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_id,revision),
  UNIQUE (storage_relative_path),
  CHECK (
    (created_by_kind='model' AND run_id IS NOT NULL AND tool_call_id IS NOT NULL) OR
    created_by_kind <> 'model'
  )
);

CREATE INDEX chat_artifact_revision_conversation_idx
  ON noderag.chat_artifact_revision (conversation_id,created_at,id);

CREATE TRIGGER chat_artifact_revision_immutable
BEFORE UPDATE ON noderag.chat_artifact_revision
FOR EACH ROW EXECUTE FUNCTION noderag.prevent_chat_configuration_revision_mutation();

CREATE TABLE noderag.chat_log_segment (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  segment_number integer NOT NULL CHECK (segment_number BETWEEN 1 AND 1000000),
  state text NOT NULL CHECK (state IN ('active','sealed')),
  storage_relative_path text NOT NULL CHECK (length(storage_relative_path) BETWEEN 1 AND 1024),
  first_event_id bigint REFERENCES noderag.chat_event(id),
  last_event_id bigint REFERENCES noderag.chat_event(id),
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count BETWEEN 0 AND 10000000),
  byte_length bigint NOT NULL DEFAULT 0 CHECK (byte_length BETWEEN 0 AND 67108864),
  content_sha256 bytea CHECK (content_sha256 IS NULL OR octet_length(content_sha256)=32),
  previous_segment_sha256 bytea CHECK (
    previous_segment_sha256 IS NULL OR octet_length(previous_segment_sha256)=32
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  sealed_at timestamptz,
  UNIQUE (conversation_id,segment_number),
  UNIQUE (storage_relative_path),
  CHECK (
    (state='active' AND sealed_at IS NULL) OR
    (state='sealed' AND sealed_at IS NOT NULL AND content_sha256 IS NOT NULL)
  )
);

CREATE UNIQUE INDEX chat_log_segment_one_active_idx
  ON noderag.chat_log_segment (conversation_id)
  WHERE state='active';

INSERT INTO noderag.system_metadata (key,value)
VALUES (
  'chat-artifacts',
  '{"schemaVersion":26,"defaultMime":"text/markdown","shellAccess":false,"externalImagesDefault":false,"optimisticSha256Patches":true}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
