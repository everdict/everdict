-- 0067_agent_message_references — additive: a user turn may @-reference workspace entities (harness/runtime/run/
-- dataset/scorecard/judge/view) whose context the agent is handed. Stored as jsonb (AgentReference[]). Column is
-- `refs` (not `references`, a SQL reserved word). Nullable → existing rows unaffected.
ALTER TABLE everdict_agent_messages ADD COLUMN IF NOT EXISTS refs jsonb;
