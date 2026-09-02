-- ── THE CODE HALF OF AN ADOPTION (docs/architecture/code-evolution-loop.md, D5) ─────────────────────
--
-- An adoption registers the BYTES a round measured. When those bytes were built from a pull request, the code
-- that produced them is still a branch until somebody merges it, and the next campaign's baseline image and the
-- default branch diverge for as long as that takes. The close now records that debt on the operation, and the
-- merge effect pays it. Kept as its own jsonb sub-document rather than a fourth `state`: `completed` is about the
-- ISSUE this adoption was opened against, this is about the REPOSITORY, and one column answering both questions
-- is one value doing two jobs.
--
--   { repo, prNumber, sha?, state: 'owed' | 'merged', mergedSha?, mergedAt? }
--
-- NULL = no code debt: the candidate named no pull request, or the row predates this migration. A NULL is not
-- "merged" — the chain check reads absence as "nothing owed", which is the honest reading for a candidate that
-- had no code to land.
ALTER TABLE everdict_adoption_operations
  ADD COLUMN IF NOT EXISTS code jsonb;

-- The rows still owing a merge, for an operator's view and any later sweep.
CREATE INDEX IF NOT EXISTS everdict_adoption_operations_code_owed
  ON everdict_adoption_operations (tenant, campaign_id)
  WHERE code IS NOT NULL AND code ->> 'state' = 'owed';
