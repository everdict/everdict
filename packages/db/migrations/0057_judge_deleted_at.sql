-- Agent Judge version soft-delete — same tombstone pattern as datasets (0018), harnesses (0042), models (0056).
-- Once deleted_at is set, all reads in the code (PgVersionedStore, softDelete: true) exclude it (WHERE deleted_at IS NULL);
-- data is preserved so past scorecards keep their reproducibility basis, and re-registering identical content revives it.
-- everdict_judges already has created_by (0032) — this adds only the tombstone column the shared store needs to expose softDelete.
-- Just an added column, so additive (no preflight needed).
ALTER TABLE everdict_judges ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Looking up live versions is the hot path → partial index (non-deleted rows only).
CREATE INDEX IF NOT EXISTS everdict_judges_live_idx ON everdict_judges (tenant, id) WHERE deleted_at IS NULL;
