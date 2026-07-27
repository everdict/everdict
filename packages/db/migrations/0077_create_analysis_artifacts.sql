-- Analysis artifacts — durable declarative outputs (chart/table/report specs) the Everdict agent emits during an
-- analysis conversation; later pinnable to a View (Studio) or produced by a scheduled report.
-- docs/architecture/analysis-studio.md V2. spec is opaque jsonb (validated per kind at the emission boundary).
CREATE TABLE IF NOT EXISTS everdict_analysis_artifacts (
  id         text PRIMARY KEY,
  tenant     text NOT NULL,
  kind       text NOT NULL,
  title      text NOT NULL,
  session_id text NOT NULL,
  view_id    text,
  pinned     boolean NOT NULL DEFAULT false,
  spec       jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_everdict_analysis_artifacts_session
  ON everdict_analysis_artifacts (tenant, session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_everdict_analysis_artifacts_view
  ON everdict_analysis_artifacts (tenant, view_id, created_at DESC);
