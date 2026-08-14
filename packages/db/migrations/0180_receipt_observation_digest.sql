-- The receipt's execution-plane digest (arch-review 41 P1): `result_digest` freezes the commit-time bytes,
-- scores included — and a re-score legally replaces scores in place, so that digest diverges from a
-- re-scored child forever. `observation_digest` names the OBSERVATION only (scores and judge:* evidence
-- spans excluded) and stays true across every judgment revision; readers compare it when present and fall
-- back to the full digest for receipts committed before the split. Nullable by design — legacy rows.
ALTER TABLE everdict_case_commit_receipts
  ADD COLUMN IF NOT EXISTS observation_digest text;
