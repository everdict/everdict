-- Agent Judge registrant (subject) — to show "who registered it" (avatar+name) in lists.
-- Stamped at registration (register's optional createdBy); past records, file seeds, and _shared are NULL.
-- Just an added column, so additive (no preflight needed). Same pattern as harnesses 0031 and datasets.
ALTER TABLE everdict_judges ADD COLUMN IF NOT EXISTS created_by text;
