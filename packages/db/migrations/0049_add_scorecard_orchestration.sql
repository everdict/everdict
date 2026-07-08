-- Orchestration inputs a batch needs to be re-driven after the fact (restart resume / retry-failed):
-- the selected Agent Judges, the inline judge model config, per-batch concurrency and transient-retry count.
-- Persisted at submit; without it an interrupted batch cannot be faithfully resumed (pre-existing records keep
-- the old tombstone path). Just an added column, so additive (no preflight needed).
-- Design: docs/architecture/batch-resilience.md
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS orchestration jsonb;
