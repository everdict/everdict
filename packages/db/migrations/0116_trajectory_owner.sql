-- Whose evidence a trajectory is. Personal executions — an agent turn (a conversation the session store has
-- always kept owner-scoped) and a sandbox shell — sealed their transcript into a ledger that only knew the
-- TENANT, so Settings › Traces handed every member's chat to the whole workspace through a different door.
-- The owner rides the row so a browse page can stay private without joining the run ledger, and so the filter
-- runs BEFORE the LIMIT (a page filtered afterwards would be short).
-- NULL = the workspace's evidence (evals, OTLP-door arrivals, materialized imports) — unchanged, visible to all.
ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS owner text;

-- Backfill: evidence sealed before the column existed is exactly the evidence that is leaking now. The rule is
-- `runAudience` (@everdict/domain) restated over the run ledger — personal kinds, owner = origin.actor else
-- created_by. Rows with no run (OTLP arrivals, imports) and ownerless personal runs stay NULL, which is what
-- the domain says about them too.
UPDATE everdict_trajectories t
SET owner = COALESCE(r.origin->>'actor', r.created_by)
FROM everdict_runs r
WHERE r.id = t.run_id
  AND t.owner IS NULL
  AND r.kind IN ('agent', 'sandbox')
  AND COALESCE(r.origin->>'actor', r.created_by) IS NOT NULL;

-- The browse query is (tenant, sealed_at DESC) with the owner predicate beside it.
CREATE INDEX IF NOT EXISTS everdict_trajectories_owner_idx ON everdict_trajectories (tenant, owner, sealed_at DESC);
