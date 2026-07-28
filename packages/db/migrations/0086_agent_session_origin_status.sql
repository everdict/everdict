-- Agent-run identity (docs/architecture/agent-automation.md A3/A4): origin = what started the session (chat /
-- discussion / teammate / trigger / schedule / api; trigger runs pin agentId@version + the waking event), status =
-- the headless run's lifecycle. The (agentId, eventId) expression index backs the durable activation dedup
-- ("one run per (agent, event)" under at-least-once delivery). Additive (no preflight).
ALTER TABLE everdict_agent_sessions ADD COLUMN IF NOT EXISTS origin jsonb;
ALTER TABLE everdict_agent_sessions ADD COLUMN IF NOT EXISTS status text;
CREATE INDEX IF NOT EXISTS everdict_agent_sessions_trigger_dedup
  ON everdict_agent_sessions (tenant, (origin->>'agentId'), (origin->>'eventId'))
  WHERE origin IS NOT NULL;
