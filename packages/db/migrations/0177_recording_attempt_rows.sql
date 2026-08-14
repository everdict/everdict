-- 0177_recording_attempt_rows — expand: ONE ROW PER ATTEMPT, not one row per run (review 39, Phase 4).
--
-- 0173 gave the recording a generation so a stale producer could be revoked, and left the buffer where it
-- was: one row per run, cleared each time a re-drive raised the number. Revocation was the urgent half and it
-- worked; the other half is that clearing a buffer DELETES an execution that really happened. A run that
-- spilled over, OOMed, or was re-driven by a recovery has a first attempt whose frames were the only record
-- of what it did — and the operator asking "what did the attempt that failed actually do" was asking about
-- bytes this table had already overwritten.
--
-- An attempt is a row from here on. Opening one INSERTs; the previous attempt keeps its frames, its seal and
-- its metadata under its own generation, and the pointer a seal returns names the attempt rather than the
-- run (`pg://recording/<runId>/g<n>`), so a reader can play the execution it holds a verdict for instead of
-- whichever one happened to be last.
--
-- Existing rows are attempt 0 — the generation every producer that has not been told otherwise stamps — so
-- the widened key is exactly the old key on today's data, and no row moves.
ALTER TABLE everdict_recordings DROP CONSTRAINT IF EXISTS everdict_recordings_pkey;
ALTER TABLE everdict_recordings ADD PRIMARY KEY (run_id, generation);

-- The two reads this store makes are both "the newest attempt of this run" — the live tail, and the newest
-- SEALED one for replay. Both walk generations descending within a run.
CREATE INDEX IF NOT EXISTS everdict_recordings_run_generation_idx
  ON everdict_recordings (run_id, generation DESC);
