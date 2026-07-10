-- Version tags for rubrics — the 5th version entity (after harness/dataset/judge/runtime, migration 0047).
-- Same idiom as 0047_version_tags: free-form labels as "mutable registry metadata" outside the spec (jsonb),
-- on par with created_by — edited even after registration and not involved in specsEqual/version immutability
-- (the SSOT guarantee). Just an added column, so additive (no preflight needed).
ALTER TABLE everdict_rubrics ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
