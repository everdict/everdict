-- The scoring STAGE — where a pass accumulates judgments before it owns them
-- (docs/architecture/scoring-plane-revisions.md, expand step).
--
-- Today a pass writes judgments straight onto the live plane (child run rows), which is why reader and writer
-- share one mutable structure and why every guard around it exists: the pass marker (the plane is mid-rewrite),
-- strip-first (it still holds the previous pass's output), the child-write fence (a superseded writer could
-- still reach it), pass-keyed artifacts, the settle CAS. Staging per pass makes a stale writer's output land
-- somewhere nobody points at, which is not a hazard — just garbage a sweep collects.
--
-- EXPAND ONLY: nothing reads this yet. Writers will dual-write (stage + carrier) so a rollback loses nothing,
-- and only the contract step makes the stage the source a finalize promotes from. Keyed by the PASS, so two
-- passes targeting the same revision cannot see each other's work — the same reason artifacts are pass-keyed.
CREATE TABLE IF NOT EXISTS everdict_scoring_stage (
  scorecard_id TEXT        NOT NULL,
  pass_id      TEXT        NOT NULL,
  case_key     TEXT        NOT NULL,  -- caseId#trial, the child key the score plane is addressed by
  scores       JSONB       NOT NULL,
  written_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scorecard_id, pass_id, case_key)
);

-- The sweep's access path: "everything this pass staged" (promotion) and "everything this scorecard staged"
-- (cleanup after a settle or an abandonment).
CREATE INDEX IF NOT EXISTS everdict_scoring_stage_scorecard_idx
  ON everdict_scoring_stage (scorecard_id, pass_id);
