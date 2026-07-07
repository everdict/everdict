-- The judge model(s) that scored this run — the leaderboard 'grader' axis (separate from the model axis = the LLM the harness used).
-- Array of distinct judge-model strings. Lightweight, so unlike the heavy scorecard it's included in list too (fair-comparison filter/display).
-- Just an added column, so additive (no preflight needed). Past records are NULL.
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS judge_models jsonb;
