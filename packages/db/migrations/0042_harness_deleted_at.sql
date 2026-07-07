-- Harness (instance/template) version soft-delete — same tombstone pattern as datasets (0018).
-- Once deleted_at is set, all reads in the code (PgVersionedStore) exclude it (WHERE deleted_at IS NULL);
-- data is preserved so past scorecards keep their reproducibility basis, and re-registering identical content revives it.
-- Just an added column, so additive (no preflight needed).
ALTER TABLE everdict_harness_instances ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE everdict_harness_templates ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS everdict_harness_instances_live_idx ON everdict_harness_instances (tenant, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS everdict_harness_templates_live_idx ON everdict_harness_templates (tenant, id) WHERE deleted_at IS NULL;
