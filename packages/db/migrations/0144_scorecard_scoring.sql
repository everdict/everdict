-- Scoring identity ledger (arch-review 6: ScoringRevision) — one entry per scoring pass over the batch
-- (the initial settle + each re-score), append-only even though the live score plane mutates in place.
-- Each entry records the pass's selected judges with their sealed model closures and a content digest of
-- the whole score plane it left behind, so "which judgment did you read" stays answerable after a re-score
-- (gate decisions pin {revision, scorePlaneDigest} per side). NULL = a pre-ledger batch, or a failed/
-- aborted settle (never gated, so it carries no judgment to identify). Additive; no backfill.
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS scoring jsonb;
