-- Agent session visibility — NULL|'private' = owner-only (personal chat history), 'workspace' = any workspace
-- member may read/continue (e.g. a comment-thread discussion session). Additive (no preflight).
ALTER TABLE everdict_agent_sessions ADD COLUMN IF NOT EXISTS visibility text;
