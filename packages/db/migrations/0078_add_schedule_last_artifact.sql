-- Report-mode schedules (docs/architecture/analysis-studio.md V4) stamp the previous fire's report artifact,
-- mirroring last_scorecard_id for eval-mode fires. Additive.
ALTER TABLE everdict_schedules ADD COLUMN IF NOT EXISTS last_artifact_id text;
