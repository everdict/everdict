-- Agent-authored comments (@everdict in a discussion thread) — lifecycle fields on everdict_comments. The agent's
-- answer IS a comment row: author_kind discriminates it, agent_status tracks running → awaiting_approval →
-- complete|failed, agent_activity is the live machine-readable "doing now" token, agent_session_id links to the
-- workspace-visible agent conversation backing the answer (the detail/continue surface). Additive (no preflight).
ALTER TABLE everdict_comments ADD COLUMN IF NOT EXISTS author_kind text;
ALTER TABLE everdict_comments ADD COLUMN IF NOT EXISTS agent_status text;
ALTER TABLE everdict_comments ADD COLUMN IF NOT EXISTS agent_activity text;
ALTER TABLE everdict_comments ADD COLUMN IF NOT EXISTS agent_session_id text;
