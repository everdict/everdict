-- Persist the submitted EvalCase on standalone runs (docs/architecture/batch-resilience.md — single-run
-- durability). Boot recovery used to tombstone queued/running standalone runs because the inline case body
-- lived only in the dead process's memory; with the spec persisted, recovery adopts the still-alive backend
-- job or re-dispatches faithfully. Additive.
ALTER TABLE everdict_runs ADD COLUMN IF NOT EXISTS case_spec jsonb;
