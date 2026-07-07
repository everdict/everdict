-- Saved scorecard-analysis View (docs/architecture/scorecard-analysis-views.md) — a named AnalysisConfig
-- saved/shared in a workspace (private|shared). config is opaque jsonb (the web validates its shape). Re-runs live, so no snapshot is stored.
CREATE TABLE IF NOT EXISTS everdict_views (
  id         text PRIMARY KEY,
  tenant     text NOT NULL,
  name       text NOT NULL,
  config     jsonb NOT NULL,
  visibility text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Query path: the workspace's shared views + my private views (newest first).
CREATE INDEX IF NOT EXISTS idx_everdict_views_tenant ON everdict_views (tenant, visibility, created_at DESC);
