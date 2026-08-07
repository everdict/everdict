-- Multi-replica admission (track S1): the scheduler's per-tenant in-flight count is DERIVED from the run
-- ledger instead of a per-process map, so N api replicas stop admitting every tenant quota N times over. That
-- read (`status = 'running'` grouped by tenant) runs once per scheduler drain, and the envelope/session
-- counters already scan the same active slice — a partial index keeps all three off the full run table, whose
-- live rows are a tiny fraction of its history.
CREATE INDEX IF NOT EXISTS everdict_runs_active_admission_idx
  ON everdict_runs (tenant)
  WHERE status IN ('queued', 'running');
