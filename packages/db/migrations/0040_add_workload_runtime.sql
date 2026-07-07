-- Records the runtime a workload (run/scorecard) was placed on (placement.target: registered runtime id | self:<runnerId>) —
-- the work-queue view's "which runtime it was scheduled on / what's running per runtime" axis.
-- NULL = default backend (no runtime specified) or a past record. Just an added column, so additive (no preflight needed).
ALTER TABLE everdict_runs ADD COLUMN IF NOT EXISTS runtime text;
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS runtime text;
