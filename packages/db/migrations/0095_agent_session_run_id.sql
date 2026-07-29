-- The session's latest ledger run (execution-model.md P3): an agent activation/turn is a Run{kind:"agent"}
-- on the universal ledger; the session keeps the transcript and points at the run that is (or last was)
-- driving it. Additive — unset on chat sessions and pre-P3 records.
ALTER TABLE everdict_agent_sessions ADD COLUMN IF NOT EXISTS run_id text;
