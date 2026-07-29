-- Envelope spend ledger (execution-model §5.2, O7 meter+headroom): one row per delegated envelope
-- (id = the delegating run's id). settle() meters real caused cost; admitted_runs counts caused runs at
-- the gate (capRuns / fan-out dimension). Never a reservation — the headroom check reads this ledger.
CREATE TABLE IF NOT EXISTS everdict_envelopes (
  id text PRIMARY KEY,
  tenant text NOT NULL,
  spent_usd double precision NOT NULL DEFAULT 0,
  admitted_runs integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);
