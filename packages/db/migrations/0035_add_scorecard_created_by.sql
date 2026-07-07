-- Scorecard runner (submitter subject) — to show + filter "who ran it" (avatar+name) in lists/detail.
-- Stamps principal.subject on submit/ingest; past records and machine-fired runs (no subject) are NULL.
-- The 'who' that pairs with origin (where it was fired from). Just an added column, so additive (no preflight needed) —
-- same pattern as datasets (everdict_datasets.created_by) and harnesses (0031).
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS created_by text;
