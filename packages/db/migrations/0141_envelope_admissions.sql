-- HARD capRuns admission for the CAUSAL budget (execution-model §5.2 / O7): the spend()-then-admit()
-- sequence was check-then-act — two replicas at capRuns=1 could both admit. The claim is now one atomic
-- statement on the envelope row (predicate re-evaluated under the row lock), and each admission writes a
-- request row so a retry with the same request id is the SAME right, never a second increment:
-- admitted_runs must always equal the sum of admitted request rows.
CREATE TABLE IF NOT EXISTS everdict_envelope_admissions (
  request_id text PRIMARY KEY,
  envelope_id text NOT NULL,
  runs integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS everdict_envelope_admissions_envelope_idx
  ON everdict_envelope_admissions (envelope_id, created_at);
