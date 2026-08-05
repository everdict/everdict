-- The workspace pulse reads the event log by TIME, and the log had no index that could serve that.
--
-- Every existing index on `everdict_platform_events` leads with `(tenant, seq)` — the reconcile cursor's shape,
-- which is the right one for "everything after what I last saw". The pulse asks a different question ("every
-- fact this workspace recorded in the last 30 days", grouped per day), and `seq` cannot answer it: the sequence
-- is monotonic with time, but nothing in the schema says so, so the planner has to read the tenant's whole log
-- and discard what falls outside the window. That is linear in how long the workspace has existed, on the
-- screen people open first.
--
-- Additive (no preflight), and `CREATE INDEX` rather than CONCURRENTLY for the usual reason: the migrator runs
-- a file as one implicit transaction block, and CONCURRENTLY cannot run inside one.
CREATE INDEX IF NOT EXISTS everdict_platform_events_tenant_created
  ON everdict_platform_events (tenant, created_at);
