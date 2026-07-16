-- 0056_model_created_by_deleted_at — additive (expand): creator + soft-delete metadata on model versions.
-- Mirrors 0018 for datasets — gives everdict_models the two columns the shared PgVersionedStore needs to expose
-- createdBy + softDelete for a versioned table.
-- created_by: the subject who registered this (tenant,id,version) — used to authorize soft-delete (the creator themselves or an admin).
--             Rows ingested via a system seed/file loader / bundle apply are NULL (no individual creator → only an admin can delete).
-- deleted_at: tombstone — once set, all reads in the code (PgModelRegistry) exclude it (WHERE deleted_at IS NULL).
--             Data is preserved → keeps past scorecards/runs that referenced the model reproducible (not a hard delete).
ALTER TABLE everdict_models ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE everdict_models ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Looking up live versions is the hot path → partial index (non-deleted rows only).
CREATE INDEX IF NOT EXISTS everdict_models_live_idx ON everdict_models (tenant, id) WHERE deleted_at IS NULL;
