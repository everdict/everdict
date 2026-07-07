-- Scorecard-execution timeline (steps) — an event array appended as the run progresses ({ts,phase,status,message,caseId?}).
-- To show "progress" in the web. Fetched only in get, alongside the heavy scorecard (omitted from lists). Just an added column, so additive (no preflight needed).
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS steps jsonb;
