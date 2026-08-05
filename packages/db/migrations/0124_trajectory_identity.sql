-- What a piece of evidence IS. The ledger's browse surface (Settings › Traces) drew every row as
-- `<run id> · run · N events`, so an agent conversation, an eval case, a sandbox shell and an OTLP arrival
-- were indistinguishable — a member looking for the trace of the agent they just ran could not tell which
-- row was theirs, which reads exactly like "my traces aren't there".
--
-- `kind` is the run family (the RUN_KINDS vocabulary: eval · agent · command · sandbox · analysis), `label`
-- is the human handle (the conversation's title, the case id, the harness). Both are DENORMALIZED onto the
-- row for the same reason `owner` is (mig 0116): a browse page must not join the run ledger to be readable,
-- the trajectory store has a ClickHouse implementation with no run table beside it at all, and a filter has
-- to run BEFORE the LIMIT or the page comes back short. NULL = evidence that arrived without a run to name
-- it; `source` still says how it got here.
ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS label text;

-- Backfill from the run ledger — the same join mig 0116 used for the owner. An eval is named by its case (the
-- thing that was evaluated), everything else by its harness id, and an agent turn by the conversation it
-- belongs to, which is the only name a member would recognize.
UPDATE everdict_trajectories t
SET kind = r.kind,
    label = CASE
      WHEN r.kind = 'eval' AND r.case_id <> '' THEN r.case_id
      WHEN r.kind = 'agent' THEN (
        SELECT s.title FROM everdict_agent_sessions s
        WHERE s.id = r.origin->>'sessionId' AND s.tenant = r.tenant
      )
      WHEN r.harness_id <> '' THEN r.harness_id
      ELSE NULL
    END
FROM everdict_runs r
WHERE r.id = t.run_id AND t.kind IS NULL;

-- The browse query is (tenant, sealed_at DESC); the kind filter sits beside it.
CREATE INDEX IF NOT EXISTS everdict_trajectories_kind_idx ON everdict_trajectories (tenant, kind, sealed_at DESC);
