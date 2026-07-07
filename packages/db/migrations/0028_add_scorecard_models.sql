-- The models a scorecard actually used (leaderboard model axis) — {observed:[],declared?,primary?}.
-- observed=observed from the trace, declared=declared in the spec, primary=group key. Lightweight, so unlike the heavy scorecard it's included in list too.
-- Just an added column, so additive (no preflight needed). Past records are NULL (=primary unknown; backfill is a follow-up).
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS models jsonb;
