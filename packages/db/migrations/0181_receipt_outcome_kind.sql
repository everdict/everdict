-- The outcome ledger's discriminant (arch-review 42, Three-Ledger Phase 1): which KIND of outcome a
-- receipt records — executed | failed | inherited — plus the inherited receipt's lineage (the batch whose
-- execution the carried result actually is). Nullable: rows committed before the discriminant existed read
-- as "executed-or-failed, kind unrecorded". No CHECK constraint on purpose — the closed vocabulary lives in
-- the contracts schema, and a new kind must not need a migration to be refused at the boundary.
ALTER TABLE everdict_case_commit_receipts
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS source_scorecard_id text;
