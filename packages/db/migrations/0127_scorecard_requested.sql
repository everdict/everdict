-- Trust-kernel contract ② (denominators): the batch's ASK — cases × trials sealed at submit (ingest: the
-- trace count). requested − executed is the unlaunched/cancelled tally, and it is UNRECOVERABLE from the
-- results alone: a case skipped by cancellation leaves no row to count. 841/970 (verdicted) and 841/1000
-- (requested) are different claims; without this column the second one cannot be made.
-- NULL = submitted before the field existed. Additive; no backfill.
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS requested integer;
