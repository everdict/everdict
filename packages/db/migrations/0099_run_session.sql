-- Session runs (execution-model.md P6, master plan W5): a `lifetime: "session"` run carries its session
-- half ON THE ROW — image, ttl, the hard `expiresAt` deadline and the teardown reason. Disposal is the
-- invariant: a reaper that finds the owning process gone can still tear down on time from the row alone.
ALTER TABLE everdict_runs
  ADD COLUMN IF NOT EXISTS session jsonb;
