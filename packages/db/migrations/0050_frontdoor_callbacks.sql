-- Store-backed front-door callback rendezvous (docs/architecture/completion-stream-callback.md): with several
-- control-plane replicas, the agent's terminal POST /frontdoor-callback/:runId may land on a different process
-- than the one driving the run. deliver = INSERT; wait = atomic claim (FOR UPDATE SKIP LOCKED) polled until the
-- timeout. Rows are short-lived (consumed rows swept opportunistically on insert). Additive.
CREATE TABLE IF NOT EXISTS everdict_frontdoor_callbacks (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL,
  body jsonb NOT NULL,
  consumed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS everdict_frontdoor_callbacks_run_idx
  ON everdict_frontdoor_callbacks (run_id) WHERE NOT consumed;
