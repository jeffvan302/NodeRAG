CREATE TABLE noderag.chat_file (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES noderag.chat_conversation(id) ON DELETE CASCADE,
  original_filename text NOT NULL CHECK (
    length(original_filename) BETWEEN 1 AND 255 AND
    original_filename !~ '[/\\]' AND
    original_filename !~ '[[:cntrl:]]'
  ),
  extension text NOT NULL CHECK (extension IN ('png','jpg','gif','webp')),
  mime_type text NOT NULL CHECK (
    (extension='png' AND mime_type='image/png') OR
    (extension='jpg' AND mime_type='image/jpeg') OR
    (extension='gif' AND mime_type='image/gif') OR
    (extension='webp' AND mime_type='image/webp')
  ),
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256)=32),
  byte_length bigint NOT NULL CHECK (byte_length BETWEEN 1 AND 104857600),
  storage_relative_path text NOT NULL UNIQUE CHECK (
    storage_relative_path ~ '^[0-9a-f-]{36}\.(png|jpg|gif|webp)$'
  ),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','deleted')),
  created_by_principal_id bigint NOT NULL REFERENCES noderag.principal(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (
    (state='active' AND deleted_at IS NULL) OR
    (state='deleted' AND deleted_at IS NOT NULL)
  )
);

CREATE INDEX chat_file_conversation_idx
  ON noderag.chat_file (conversation_id,state,created_at,id);

INSERT INTO noderag.system_metadata (key,value)
VALUES (
  'chat-files',
  '{"schemaVersion":29,"urlContract":"/chat/{chatId}/file/{fileId}.{extension}","public":false,"allowedTypes":["image/png","image/jpeg","image/gif","image/webp"]}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
