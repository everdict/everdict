-- The scoring stage is re-keyed to (scorecard, pass, case, JUDGE) — arch-review 12.
--
-- The stage's row was per CASE while every other property of a judgment is per JUDGE: `JudgeProgress` is
-- per judge, the attempt budget is per judge, metric-family ownership is per judge, and the retry now strips
-- and re-runs per judge (`pendingJudgesFor`). A persistence key that does not follow the independently
-- mutable unit is the same mismatch this whole review round is about — completion decided in one unit,
-- mutation performed in another — one layer down.
--
-- Concretely, per-case rows cannot express what the contract step needs:
--   · first-writer-wins arbitrates a whole case, so two attempts that judged DIFFERENT judges collide;
--   · a promotion cannot tell which judge in a row a given pass actually produced;
--   · a per-judge attempt CAS (the natural next step for same-pass duplicate attempts) has nowhere to live.
--
-- Done NOW because now is when it is free: the stage is expand-only, nothing reads it to decide anything
-- (the single reader is the parity REPORT, a comparison), and its contents are shadow data by construction —
-- the carriers are the source of truth for this deploy. After the contract step this same change would be a
-- migration plus a reshape of authoritative data.
--
-- Existing rows are DELETED rather than backfilled: they are per-case shaped, so there is no judge id to
-- recover, and inventing one would put a fabricated key into the table the promotion will later trust.
-- Deleting shadow data that nothing reads loses nothing, which is the whole reason the expand step exists.
DELETE FROM everdict_scoring_stage;

ALTER TABLE everdict_scoring_stage
  DROP CONSTRAINT IF EXISTS everdict_scoring_stage_pkey;

ALTER TABLE everdict_scoring_stage
  ADD COLUMN IF NOT EXISTS judge_id TEXT NOT NULL DEFAULT '';

ALTER TABLE everdict_scoring_stage
  ALTER COLUMN judge_id DROP DEFAULT;

ALTER TABLE everdict_scoring_stage
  ADD PRIMARY KEY (scorecard_id, pass_id, case_key, judge_id);
