-- 0210_trajectory_retention_and_window_indexes — additive: the two time-ordered questions the trajectory
-- ledger is asked, neither of which any existing index could serve.
--
-- Every index on `everdict_trajectories` today leads with `tenant`
-- (`(tenant, sealed_at DESC)`, `(tenant, kind, sealed_at DESC)`, `(tenant, owner, sealed_at DESC)`), which is
-- right for the browse page — it always knows whose workspace it is reading. RETENTION does not: it asks
-- "everything older than this cutoff, across every workspace", and with `tenant` in front the planner cannot
-- use any of them. So `expiredRuns`, `deleteOlderThan` and `payloadRefsOlderThan` each seq-scan the whole
-- ledger, once per call, on an hourly schedule, on the table that grows fastest in the product.
--
--   1. everdict_trajectories (sealed_at)          — the retention sweep's own predicate
--
-- The second index is the ingestion meter's. `ingestedSince` is called on the OTLP door's admission path, so
-- it runs once per exporter push; it now reads a plane's OWN seal stamp (a plane sealed inside the window is
-- ingestion inside the window, whatever its run's first seal was), which means it reads the SEGMENTS table by
-- (tenant, sealed_at) — a shape that table has never been indexed for.
--
--   2. everdict_trajectory_segments (tenant, sealed_at)
--
-- Additive (no preflight), and `CREATE INDEX` rather than CONCURRENTLY for the usual reason: the migrator
-- runs a file as one implicit transaction block, and CONCURRENTLY cannot run inside one.
CREATE INDEX IF NOT EXISTS everdict_trajectories_sealed_at_idx
  ON everdict_trajectories (sealed_at);

CREATE INDEX IF NOT EXISTS everdict_trajectory_segments_tenant_sealed_idx
  ON everdict_trajectory_segments (tenant, sealed_at);
