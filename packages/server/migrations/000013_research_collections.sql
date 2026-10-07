CREATE TABLE noderag.research_collection (
  id bigserial PRIMARY KEY,
  owner_principal_id bigint NOT NULL REFERENCES noderag.principal(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX research_collection_owner_name_ci_idx
  ON noderag.research_collection (owner_principal_id, lower(name));
CREATE INDEX research_collection_owner_updated_idx
  ON noderag.research_collection (owner_principal_id, updated_at DESC, id DESC);

CREATE TABLE noderag.research_reference (
  id bigserial PRIMARY KEY,
  research_id bigint NOT NULL REFERENCES noderag.research_collection(id) ON DELETE CASCADE,
  silo_id smallint NOT NULL,
  document_id bigint NOT NULL,
  chunk_id bigint NOT NULL,
  chunk_ids bigint[] NOT NULL CHECK (cardinality(chunk_ids) BETWEEN 1 AND 8),
  passage_text text NOT NULL CHECK (length(passage_text) BETWEEN 1 AND 64000),
  heading_path text[] NOT NULL DEFAULT '{}',
  locator jsonb NOT NULL CHECK (jsonb_typeof(locator) = 'object'),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array'),
  query_text text NOT NULL CHECK (length(query_text) BETWEEN 1 AND 4000),
  search_mode text NOT NULL CHECK (search_mode IN ('vector', 'semantic', 'keyword', 'hybrid')),
  selected_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (silo_id, document_id)
    REFERENCES noderag.document(silo_id, id) ON DELETE CASCADE,
  UNIQUE (research_id, silo_id, document_id, chunk_id)
);
CREATE INDEX research_reference_collection_order_idx
  ON noderag.research_reference (research_id, selected_at, id);
CREATE INDEX research_reference_membership_idx
  ON noderag.research_reference (chunk_id, research_id);

INSERT INTO noderag.system_metadata (key, value)
VALUES (
  'research-collections',
  '{"schemaVersion":13,"crossKnowledgeSpaceReferences":true,"shortcut":"0"}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
