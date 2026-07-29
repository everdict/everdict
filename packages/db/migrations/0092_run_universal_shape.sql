-- The universal-run shape (docs/architecture/execution-model.md P0, master plan W1).
-- Additive and nullable: an absent value means "a legacy eval run from before the shape existed".
-- Nothing is enforced here — enforcement is the P4 admission gate; P0 only lets the ledger SAY
-- what ran (kind), why (origin), at what priority (class), on whose budget (envelope), where
-- (placement), for how long (lifetime), with which live channels (attach), inside which
-- orchestration (group_ref), related to which earlier runs (lineage), leaving what (outputs).
ALTER TABLE everdict_runs
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS class text,
  ADD COLUMN IF NOT EXISTS lifetime text,
  ADD COLUMN IF NOT EXISTS origin jsonb,
  ADD COLUMN IF NOT EXISTS envelope jsonb,
  ADD COLUMN IF NOT EXISTS placement jsonb,
  ADD COLUMN IF NOT EXISTS attach jsonb,
  ADD COLUMN IF NOT EXISTS group_ref jsonb,
  ADD COLUMN IF NOT EXISTS lineage jsonb,
  ADD COLUMN IF NOT EXISTS outputs jsonb;
