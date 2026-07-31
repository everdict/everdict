-- Session running memory (bounded replay for long conversations): a rolling digest of the conversation's oldest
-- records + the highest message seq it covers. The chat host maintains it at turn boundaries; the next turn
-- replays memory + only the messages after memory_through_seq. Additive: NULL = full replay (the historical
-- behaviour). See docs/architecture/agent-conversations.md.
ALTER TABLE everdict_agent_sessions ADD COLUMN IF NOT EXISTS memory text;
ALTER TABLE everdict_agent_sessions ADD COLUMN IF NOT EXISTS memory_through_seq integer;
