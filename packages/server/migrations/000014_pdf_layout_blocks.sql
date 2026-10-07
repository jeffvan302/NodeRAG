CREATE TABLE noderag.document_block (
  document_id bigint NOT NULL,
  silo_id smallint NOT NULL,
  page_ordinal integer NOT NULL CHECK (page_ordinal >= 0),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind text NOT NULL CHECK (
    kind IN (
      'title', 'heading', 'paragraph', 'list-item', 'table', 'caption',
      'footnote', 'header', 'footer', 'code', 'unknown'
    )
  ),
  source text NOT NULL CHECK (source IN ('text', 'vision', 'mixed')),
  native_text text NOT NULL,
  markdown text NOT NULL,
  reading_order integer NOT NULL CHECK (reading_order >= 0),
  bound_x real,
  bound_y real,
  bound_width real,
  bound_height real,
  character_start integer NOT NULL CHECK (character_start >= 0),
  character_end integer NOT NULL,
  byte_start integer NOT NULL CHECK (byte_start >= 0),
  byte_end integer NOT NULL,
  text_confidence real NOT NULL CHECK (text_confidence BETWEEN 0 AND 1),
  reading_order_confidence real NOT NULL CHECK (reading_order_confidence BETWEEN 0 AND 1),
  structure_confidence real NOT NULL CHECK (structure_confidence BETWEEN 0 AND 1),
  combined_confidence real NOT NULL CHECK (combined_confidence BETWEEN 0 AND 1),
  warning_codes text[] NOT NULL DEFAULT '{}',
  confidence_components jsonb NOT NULL DEFAULT '{}' CHECK (
    jsonb_typeof(confidence_components) = 'object'
  ),
  parser_revision text NOT NULL,
  layout_policy_revision text NOT NULL,
  confidence_policy_revision text NOT NULL,
  vision_prompt_revision text,
  vision_schema_revision text,
  preprocessing_revision text,
  model_revision text,
  PRIMARY KEY (document_id, page_ordinal, ordinal),
  FOREIGN KEY (document_id, page_ordinal)
    REFERENCES noderag.document_page(document_id, ordinal) ON DELETE CASCADE,
  FOREIGN KEY (silo_id, document_id)
    REFERENCES noderag.document(silo_id, id) ON DELETE CASCADE,
  CHECK (character_end >= character_start),
  CHECK (byte_end >= byte_start),
  CHECK (
    (bound_x IS NULL AND bound_y IS NULL AND bound_width IS NULL AND bound_height IS NULL)
    OR (
      bound_x BETWEEN 0 AND 1 AND bound_y BETWEEN 0 AND 1
      AND bound_width BETWEEN 0 AND 1 AND bound_height BETWEEN 0 AND 1
      AND bound_x + bound_width <= 1.0001
      AND bound_y + bound_height <= 1.0001
    )
  )
);

CREATE INDEX document_block_silo_document_idx
  ON noderag.document_block (silo_id, document_id, page_ordinal, reading_order);
CREATE INDEX document_block_low_confidence_idx
  ON noderag.document_block (silo_id, combined_confidence)
  WHERE combined_confidence < 0.82;

ALTER TABLE noderag.document_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE noderag.document_block FORCE ROW LEVEL SECURITY;
CREATE POLICY document_block_silo_scope ON noderag.document_block
  USING (silo_id = ANY (noderag.current_silo_ids()))
  WITH CHECK (silo_id = ANY (noderag.current_silo_ids()));

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'pdf-layout-blocks',
  '{"schemaVersion":14,"pdfExtractionVersion":"pdf-layout.v1-shadow","layoutPolicyRevision":"page-shadow.v1","confidencePolicyRevision":"page-confidence.v1"}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
