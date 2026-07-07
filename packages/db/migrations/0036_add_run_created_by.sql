-- Run runner (submitter subject) — the notification-feed recipient (N2: "the job I asked for is done") + to show "who" in lists.
-- Stamps principal.subject on submit; past records and machine-fired runs (no subject) are NULL.
-- Same additive pattern as scorecards (0035) (no preflight needed).
ALTER TABLE everdict_runs ADD COLUMN IF NOT EXISTS created_by text;
