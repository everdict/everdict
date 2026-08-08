-- The stamped-policy verdict aggregate (arch-review 7 §4) — persisted at every judged settle and refreshed
-- by a re-score. headlinePassRate ranks metrics by a hardcoded authority ladder that cannot know a composed
-- verdict policy's custom ground_truth metrics, so release-shaped surfaces (product readiness, timeline)
-- acting on the headline could contradict the actual case verdicts. This column is the number they read:
-- {verdicted, passed, failed, passRate?, policyDigest} computed under the batch's OWN stamped policy, the
-- digest making a stale aggregate detectable instead of silently trusted. NULL = pre-field record or a
-- failed/aborted settle. Additive; no backfill (readers fall back to the headline for legacy rows).
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS verdict_summary jsonb;
