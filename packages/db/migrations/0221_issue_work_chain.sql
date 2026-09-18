-- The work chain (DEFAUL-39, docs/specs/work-chain-invariants-spec.md): has this request been designed,
-- decided, and shipped. A SECOND AXIS beside `status`, not a value inside it — every rollup, the release gate
-- and the regression watch decide on the status CATEGORY, and putting `accepted` in that enum would grow an
-- arm on each of them for a value that is not about progress.
--
-- NULLABLE, and the null is a third value rather than a default. Every issue that exists today has no chain,
-- and reading that as `draft` would render an already-shipped request as one nobody has designed — and then
-- accepting it would date its acceptance after its own commits. There is no backfill: an issue enters the
-- chain when somebody accepts or rejects it.
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS chain jsonb;

-- "How much of this tracker is under the invariant at all" — the count the migration owes, because "the
-- invariant is on" and "the invariant covers anything" are different facts and a gate over an empty corpus
-- reads exactly like coverage.
CREATE INDEX IF NOT EXISTS everdict_issues_chain_state_idx
  ON everdict_issues (tenant, (chain->>'state'))
  WHERE chain IS NOT NULL;
