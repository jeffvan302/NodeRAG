ALTER TABLE noderag.research_reference
  ADD COLUMN page_ordinal integer;

ALTER TABLE noderag.research_reference
  ADD CONSTRAINT research_reference_page_ordinal_check
  CHECK (page_ordinal IS NULL OR page_ordinal >= 0);

ALTER TABLE noderag.research_reference
  DROP CONSTRAINT research_reference_research_id_silo_id_document_id_chunk_id_key;

CREATE UNIQUE INDEX research_reference_passage_unique_idx
  ON noderag.research_reference (research_id, silo_id, document_id, chunk_id)
  WHERE page_ordinal IS NULL;

CREATE UNIQUE INDEX research_reference_page_unique_idx
  ON noderag.research_reference (research_id, silo_id, document_id, page_ordinal)
  WHERE page_ordinal IS NOT NULL;

CREATE INDEX research_reference_document_page_idx
  ON noderag.research_reference (research_id, document_id, page_ordinal)
  WHERE page_ordinal IS NOT NULL;

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'research-collections',
  '{"schemaVersion":18,"crossKnowledgeSpaceReferences":true,"pageReferences":true,"shortcut":"0"}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
