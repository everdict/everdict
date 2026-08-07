-- Release-gate decisions (metrics commercialization A1/B1) — append-only decision artifacts recorded
-- against the CANDIDATE batch: decision (pass|block|not_comparable), the embedded policy + digest, the
-- comparison evidence, and any override (who forced a blocked ship, and why — catalog R7). Recorded on the
-- ledger row instead of a separate store (ledger-derivation principle); the audit report scans these.
-- NULL = no gate was ever asked of this candidate. Additive; no backfill.
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS gates jsonb;
