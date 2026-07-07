-- 0018_dataset_created_by_deleted_at — additive (expand): creator + soft-delete metadata on dataset versions.
-- created_by: the subject who registered this (tenant,id,version) — used to authorize soft-delete (the creator themselves or an admin).
--             Rows ingested via a system seed/file loader are NULL (no individual creator → only an admin can delete).
-- deleted_at: tombstone — once set, all reads in the code (PgDatasetRegistry) exclude it (WHERE deleted_at IS NULL).
--             Data is preserved → keeps past scorecards/runs reproducible (not a hard delete).
ALTER TABLE everdict_datasets ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE everdict_datasets ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Looking up live versions is the hot path → partial index (non-deleted rows only).
CREATE INDEX IF NOT EXISTS everdict_datasets_live_idx ON everdict_datasets (tenant, id) WHERE deleted_at IS NULL;
