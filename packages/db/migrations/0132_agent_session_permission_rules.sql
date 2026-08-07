-- Standing permission rules (LESSON 059 P4): a conversation's tool → allow|deny rule set persists on its
-- session row, so "always allow this tool here" survives an agent-service restart instead of silently
-- reopening every prompt the member already answered. Additive.
ALTER TABLE everdict_agent_sessions ADD COLUMN IF NOT EXISTS permission_rules jsonb;
