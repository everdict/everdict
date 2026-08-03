-- Waiting as a first-class conversation state (LESSON 051).
--
-- An agent that starts slow work (a scorecard batch, a run) used to have two options: end its turn — which hands
-- the unfinished job back to the member ("ask me again later") — or poll, which the no-progress guard stops. The
-- third option is to WAIT, and a wait is only a promise if it outlives the process that made it: the intent lives
-- here, on the conversation, so a matching platform event or the deadline sweep resumes THIS session even after an
-- agent-service restart. NULL = nothing is being watched.
--
-- Additive: no backfill, no default, invisible to every existing reader.
ALTER TABLE everdict_agent_sessions ADD COLUMN IF NOT EXISTS wake_intent jsonb;

-- The event path scans one workspace's parked conversations; the sweep scans deadlines across all of them. Both are
-- narrow by nature (one row per waiting agent), so a partial index keeps them free without taxing the common case.
CREATE INDEX IF NOT EXISTS everdict_agent_sessions_wake_intent_idx
  ON everdict_agent_sessions (tenant, (wake_intent ->> 'deadlineAt'))
  WHERE wake_intent IS NOT NULL;
