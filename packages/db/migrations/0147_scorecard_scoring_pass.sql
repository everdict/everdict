-- The LIVE scoring pass (arch-review 7 P0) — the revision boundary made visible. Set before a re-score's
-- first strip, cleared in the same write as the revision append: while present, the persisted score plane
-- belongs to NO completed revision (or to an abandoned pass), and trust readers (gate/diff, product release
-- readiness, the issue regression watch) REFUSE instead of consuming it. Also the cross-replica
-- one-pass-at-a-time guard (the in-process Set was process-local) and the carrier of the pass-start judge
-- closure the finalized revision records. NULL = no pass since the last settle. Additive; no backfill.
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS scoring_pass jsonb;
