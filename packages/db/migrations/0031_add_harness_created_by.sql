-- Harness instance/template registrant (subject) — to show "who registered it" (avatar+name) in lists.
-- Stamped at registration (register's optional createdBy); past records, file seeds, and _shared are NULL.
-- Just an added column, so additive (no preflight needed). Same pattern as datasets (everdict_datasets.created_by).
ALTER TABLE everdict_harness_instances ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE everdict_harness_templates ADD COLUMN IF NOT EXISTS created_by text;
