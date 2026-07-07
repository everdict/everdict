-- Version tags — free-form labels (multiple, for display/disambiguation) because versions are hard to tell apart by number alone.
-- "Mutable registry metadata" outside the spec (jsonb) (on par with created_by): edited even after registration and
-- not involved in specsEqual/version immutability (the SSOT guarantee). Common to the 4 version entities + templates
-- (everdict_harness_templates shares PgVersionedStore with instances, so the column is just added alongside).
-- Just an added column, so additive (no preflight needed).
ALTER TABLE everdict_harness_instances ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE everdict_harness_templates ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE everdict_datasets ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE everdict_judges ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE everdict_runtimes ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
