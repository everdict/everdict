-- The execution WORLD a batch ran in, as a stored comparison axis (arch-review 20 P1).
--
-- `worldCohortOf` derives it at settle from the cases' own execution manifests, and the release comparison
-- reads it to say whether two evaluations were compared WITHIN one world or across two. The domain and the
-- settle path shipped without this column, so every derived cohort was dropped at the Postgres boundary: the
-- feature was green in memory and absent in production, which is the shape a test suite cannot see unless it
-- crosses the boundary itself.
--
-- Deliberately a LIST field, not a detail-only one: product readiness reads scorecards through `list`, so a
-- world that only appeared on `get` would be invisible exactly where it is consumed.
--
-- NULL is meaningful and stays meaningful: "no case reported a world" (a dispatch that died, an ingested
-- trace, a batch settled before this existed). Never a default — a defaulted world would claim a sameness
-- nobody observed, which is the one thing this axis exists to avoid.
ALTER TABLE everdict_scorecards
  ADD COLUMN IF NOT EXISTS world JSONB;
