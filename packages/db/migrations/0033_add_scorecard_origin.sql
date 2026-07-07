-- Scorecard trigger provenance: source(schedule|github-actions|api|web) + repo/sha/ref/prNumber/runUrl
-- + pinOverrides (submit-time ephemeral pins — records the PR image swap). Lightweight, so included in lists too.
-- Just an added column, so additive (no preflight needed). Past records are NULL.
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS origin jsonb;
