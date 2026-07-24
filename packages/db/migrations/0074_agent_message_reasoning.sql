-- 0074_agent_message_reasoning — additive (expand): persist an assistant turn's reasoning / extended-thinking text
-- so the transcript can re-render the model's thought process (docs/architecture/agent-conversations.md). Display
-- text only — the provider-native thinking blocks used for same-turn tool-use replay live in the loop's memory and
-- are never persisted. NULL for user/tool turns and for assistant turns that produced no reasoning.
ALTER TABLE everdict_agent_messages ADD COLUMN IF NOT EXISTS reasoning text;
