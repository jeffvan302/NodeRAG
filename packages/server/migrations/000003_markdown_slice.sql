CREATE UNIQUE INDEX build_one_active_idx
  ON noderag.build ((state)) WHERE state = 'active';

INSERT INTO noderag.build (
  state, target_chars, overlap_chars, max_tokens, snap_window,
  heading_prefix, rules_version, model_manifest_id, query_prefix,
  reason, completed_at, activated_at
)
SELECT
  'active', settings.target_chars, settings.overlap_chars, settings.max_tokens,
  settings.snap_window, settings.heading_prefix, settings.rules_version,
  manifest.id, manifest.query_prefix, 'initial Markdown vertical slice', now(), now()
FROM noderag.settings AS settings
JOIN noderag.model_manifest AS manifest ON manifest.id = settings.model_manifest_id
WHERE settings.id = 1
  AND NOT EXISTS (SELECT 1 FROM noderag.build WHERE state = 'active');

INSERT INTO noderag.silo_build_state (silo_id, build_id, state)
SELECT silo.id, build.id, 'active'
FROM noderag.silo
CROSS JOIN noderag.build
WHERE build.state = 'active'
ON CONFLICT (silo_id, build_id) DO NOTHING;

CREATE UNIQUE INDEX job_one_live_document_kind_idx
  ON noderag.job (document_id, kind)
  WHERE document_id IS NOT NULL
    AND state IN ('pending', 'leased', 'retry_wait', 'paused');
