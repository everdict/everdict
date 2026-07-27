-- The conversation's standing permission mode (default|auto|bypass|plan) — how the agent's mutating tool calls are
-- approved for this session. NULL = "default" (ask for every mutation). Additive; no backfill needed.
ALTER TABLE everdict_agent_sessions
  ADD COLUMN IF NOT EXISTS permission_mode text;
