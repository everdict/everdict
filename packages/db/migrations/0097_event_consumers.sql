-- Durable-cursor consumer state (event-plumbing.md E1): one log, N cursors. Each consumer's position
-- survives restarts (replay = rewind the cursor; effects stay idempotent via natural keys). Dead letters
-- park a poison event VISIBLY instead of blocking the cursor forever.
CREATE TABLE IF NOT EXISTS everdict_event_cursors (
  consumer text PRIMARY KEY,
  seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS everdict_event_dead_letters (
  id bigserial PRIMARY KEY,
  consumer text NOT NULL,
  event_id text NOT NULL,
  seq bigint NOT NULL,
  error text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS everdict_event_dead_letters_consumer_idx
  ON everdict_event_dead_letters (consumer, created_at DESC);
