-- 0063_create_recordings — additive (expand): the durable replay recording (docs/architecture/replay.md S4).
-- One row per run, keyed by the CP-minted runId (evd-run-<id> / evd-<scorecardId>-<caseId>). `tracks` accumulates
-- the environment/runtime track lanes as the runner pushes frames/logs during the run (append = a row-locked jsonb
-- append, so concurrent appends for the same run serialize); `seal` freezes t0 + effective_fidelity at finalize.
-- Byte-heavy frames are offloaded to object storage — this table holds only refs. Not workspace-scoped: the runId
-- is the key and retrieval goes through the (already workspace-scoped) run.
CREATE TABLE IF NOT EXISTS everdict_recordings (
  run_id             text PRIMARY KEY,
  tracks             jsonb NOT NULL DEFAULT '{}'::jsonb,
  t0                 bigint,
  env_kind           text,
  effective_fidelity text,
  dispatch           jsonb,
  sealed             boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
