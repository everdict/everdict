-- The owned trajectory store, rung 1 (execution-model P5 / native-observability N-O1): one sealed
-- trajectory per run, body in jsonb (the same bytes the run row embeds today — no size regression, no
-- presigned-URL evidence decay). ref is reserved for the object-storage rung (key-based, not URL-based).
CREATE TABLE IF NOT EXISTS everdict_trajectories (
  run_id text PRIMARY KEY,
  tenant text NOT NULL,
  source text NOT NULL,
  event_count integer NOT NULL,
  body jsonb NOT NULL,
  ref text,
  sealed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS everdict_trajectories_tenant_idx ON everdict_trajectories (tenant, sealed_at DESC);
