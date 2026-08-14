-- 0176_trajectory_attempt_id — additive (expand): WHICH physical attempt a sealed plane belongs to.
--
-- A trajectory is keyed by the run's live-correlation id and keeps the FIRST seal per emitter, which is right
-- (evidence is never rewritten) and says nothing about WHOSE evidence it is. Several physical executions of
-- one logical run are ordinary — a spillover, an OOM re-run, a speculative duplicate, a recovery re-drive —
-- and every one of them seals under the same id, so a reader holding a case's verdict could not ask "is this
-- the replay of the execution that produced it".
--
-- The attempt id is the answer, recorded beside the plane rather than derived from it: `<executionId>#g<n>`,
-- the same identity the commit receipt carries. Absent on every row written before this column existed, which
-- reads as "the producer did not say" — never as agreement with whatever attempt a reader has in hand.
ALTER TABLE everdict_trajectories          ADD COLUMN IF NOT EXISTS attempt_id text;
ALTER TABLE everdict_trajectory_segments   ADD COLUMN IF NOT EXISTS attempt_id text;

-- …and on the receipt, which is where the comparison is made: a reader holding a replay asks whether its
-- attempt id is the one the case's outcome was committed under. Storing the joined name rather than
-- re-deriving it at every call site is the point — two derivations that drift agree about nothing.
ALTER TABLE everdict_case_commit_receipts ADD COLUMN IF NOT EXISTS attempt_id text;
