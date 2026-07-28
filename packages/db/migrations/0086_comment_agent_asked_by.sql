-- Discussion-agent follow-ups: agent_asked_by (the asking member — the completion notification's recipient,
-- survives restarts unlike an in-memory map) + an index for the stuck-answer sweep (non-terminal agent comments
-- whose lifecycle callbacks died, e.g. an agent-service crash mid-turn). Additive (no preflight).
ALTER TABLE everdict_comments ADD COLUMN IF NOT EXISTS agent_asked_by text;
CREATE INDEX IF NOT EXISTS everdict_comments_agent_status_idx
  ON everdict_comments (agent_status, updated_at) WHERE agent_status IN ('running', 'awaiting_approval');
