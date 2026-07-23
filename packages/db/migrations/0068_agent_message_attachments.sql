-- 0068_agent_message_attachments — additive: a user turn may attach files whose text content is folded into the
-- model context at send time; only the metadata (name/type/size) is persisted, as jsonb (AgentAttachment[]).
-- Nullable → existing rows unaffected.
ALTER TABLE everdict_agent_messages ADD COLUMN IF NOT EXISTS attachments jsonb;
