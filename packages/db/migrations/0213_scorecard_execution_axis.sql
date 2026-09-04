-- THE EXECUTION AXIS (docs/architecture/in-place-case-retry-spec.md) — the sibling of mig 0144 + 0147,
-- which gave the JUDGMENT axis its append-only revision ledger and its live-pass marker. Until now a case
-- that died on infrastructure could only be re-run by forking a whole new scorecard, so one experiment's
-- evidence split across two ids that no diff, trend, leaderboard or gate joins.
--
--   executions      the append-only execution revision ledger — which pass replaced which attempts, and why
--   case_attempts   the SUPERSEDED attempts, whole CaseResult each. Heavy, detail-only: it is read with
--                   `scorecard` and never in a list, which is why it is its own column rather than nested
--                   inside that one (a list projection must be able to leave it on disk).
--   execution_pass  the LIVE retry pass — the same job `scoring_pass` does one axis over: the cross-replica
--                   one-retry-at-a-time guard, and the boundary that says the plane belongs to no completed
--                   revision yet. NULL = no pass since the last settle.
--   retry_summary   the light count a LIST can afford (distinct cases re-executed, attempts spent),
--                   derivable from case_attempts, which is exactly why it is stored separately.
--
-- Additive; no backfill. A record with no executions has run every case exactly once, which is what every
-- row written before this says by carrying nothing.
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS executions jsonb;
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS case_attempts jsonb;
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS execution_pass jsonb;
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS retry_summary jsonb;
