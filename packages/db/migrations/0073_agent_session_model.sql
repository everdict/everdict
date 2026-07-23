-- 0073_agent_session_model — additive: a conversation may pin a registered model id the member picks in the chat
-- (a per-conversation override of the workspace AgentSpec's model / the agent server's default). Nullable →
-- existing rows fall back to the workspace/server default.
ALTER TABLE everdict_agent_sessions ADD COLUMN IF NOT EXISTS model text;
