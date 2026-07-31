-- Multi-plane trajectories (native-observability): a run's evidence is the sum of its EMITTERS — the
-- agent's own record, the orchestrator's account of where it ran, and any service under test pushing its
-- own OTel spans through the door. Each emitter seals ONCE into its own row, so a late plane is added
-- BESIDE the others instead of rewriting their bytes ("evidence is never rewritten" stays literally true)
-- and a topology run whose services emit before the agent settles keeps both records.
--
-- Additive: the existing table stays the trajectory's header + FIRST segment (its body is untouched).
-- `emitter` is NULL on pre-existing rows and reads as the row's `source`.
ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS emitter text;
ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS t0 timestamptz;
-- Denormalized sum of the side segments' events, so a browse page and the ingestion meter read one row.
ALTER TABLE everdict_trajectories ADD COLUMN IF NOT EXISTS segment_event_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS everdict_trajectory_segments (
  run_id text NOT NULL REFERENCES everdict_trajectories (run_id) ON DELETE CASCADE,
  emitter text NOT NULL,
  tenant text NOT NULL,
  source text NOT NULL,
  event_count integer NOT NULL,
  body jsonb NOT NULL,
  -- Absolute anchor this segment's relative `t` counts from — the cross-plane alignment axis.
  t0 timestamptz,
  sealed_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, emitter)
);
