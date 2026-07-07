-- Promote run to a core primitive: a scorecard fans out a child run per case, and the scorecard references those runs.
-- (docs/architecture/run-as-primitive.md Step 2)
--   everdict_runs.parent_scorecard_id — the scorecard batch this run belongs to (if any). NULL = standalone (one-off) run.
--   everdict_runs.trigger            — run source (standalone|scorecard|schedule|mcp|front-door) — the activity-view source axis.
--   everdict_scorecards.run_ids      — array of child run ids fanned out by this batch (reference). A lightweight reference separate from the embedded scorecard.
-- All added columns, so additive (no preflight needed). Past records are NULL — existing runs are all treated as standalone.
-- The parent_scorecard_id index: used when the activity list excludes children (IS NULL) or queries only a batch's children (= id).
ALTER TABLE everdict_runs ADD COLUMN IF NOT EXISTS parent_scorecard_id text;
ALTER TABLE everdict_runs ADD COLUMN IF NOT EXISTS trigger text;
CREATE INDEX IF NOT EXISTS everdict_runs_parent_scorecard_id_idx ON everdict_runs (parent_scorecard_id);
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS run_ids jsonb;
