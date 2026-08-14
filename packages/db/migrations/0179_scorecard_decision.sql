-- The settle's frozen read-set (review 40, the Release pattern): which receipts the parent read, per
-- (case, trial), with the digest of the bytes it counted — so the summary is auditable against the ledger
-- a year later, and the terminal write can condition on the receipt COUNT it read (insert-only ⇒ freshness).
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS decision jsonb;
