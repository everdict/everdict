-- Scorecard partial-run (subset) marker — which subset of the dataset this batch ran
-- ({total, selected, ids?, tags?, limit?}). NULL = full run. Lightweight, so included in the list SELECT too.
-- Just an added column, so additive (no preflight needed).
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS subset jsonb;
