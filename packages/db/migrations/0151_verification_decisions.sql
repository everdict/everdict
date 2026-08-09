-- The verification ledger (arch-review 10 §10 / P1) — an independent actor's immutable judgment about
-- evidence, as its OWN aggregate rather than another handoff checkpoint.
--
-- Why separate: a HandoffCheckpoint transfers RESUMABLE STATE from a predecessor to a successor; a
-- verification is a JUDGMENT. Storing the second as a variant of the first is the category error GateDecision
-- avoided by not being a field on ScorecardRecord — it turns "who verified this, and did the verdict hold"
-- into a scan for a checkpoint that happens to reference another one, and it leaves the executor/verifier pair
-- the independence invariant is stated over as something every reader re-derives instead of a field.
--
-- Append-only: no update path, no delete. A verifier that changes its mind files a SECOND decision, because
-- "the verdict was revised" and "the verdict was always this" are different histories.
CREATE TABLE IF NOT EXISTS everdict_verification_decisions (
  id text NOT NULL,
  tenant text NOT NULL,
  -- What was verified. Columns (not just body) because "has anyone verified this checkpoint" is the read.
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  verdict text NOT NULL,
  created_at timestamptz NOT NULL,
  -- The whole contract: evidence refs, both actors, whether independence was enforced or abstained.
  body jsonb NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS everdict_verification_decisions_subject_idx
  ON everdict_verification_decisions (tenant, subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS everdict_verification_decisions_tenant_idx
  ON everdict_verification_decisions (tenant, created_at DESC);
