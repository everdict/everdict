-- Group kind (execution-model.md P1, decision O3): an experiment is a scorecard row with no scoring,
-- presented under a different name — the RunGroup generalizes ScorecardRecord in concept, the table is kept.
-- NULL = a scorecard (every pre-existing row); 'experiment' = phase-1-only ungraded fan-out.
ALTER TABLE everdict_scorecards
  ADD COLUMN IF NOT EXISTS kind text;
