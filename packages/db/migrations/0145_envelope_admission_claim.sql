-- Claim-first envelope admission (arch-review 6, H6). The mig-0141 shape wrote the request row FROM the
-- counter claim, so two concurrent calls with the SAME request id both passed the (empty) existence probe
-- and both incremented admitted_runs — one right, charged twice, conservation broken. The request row is now
-- claimed FIRST (its unique index is the serialization point) and `admitted` records the decision:
--   NULL  = claimed, decision pending (a crash between claim and decision leaves this; the next retry of the
--           same request id takes the row over and decides it — no charge was made, no right granted)
--   true  = granted (the counter was incremented exactly once for this row)
-- A REFUSED claim deletes its own row (refusal holds no capacity and must not block a later ask), so false
-- never persists. Existing rows were all written from granted claims — backfill true.
ALTER TABLE everdict_envelope_admissions ADD COLUMN IF NOT EXISTS admitted boolean;
UPDATE everdict_envelope_admissions SET admitted = true WHERE admitted IS NULL;
