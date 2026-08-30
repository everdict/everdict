-- A tool turn's OUTCOME, recorded rather than re-read out of its text.
--
-- `everdict_agent_messages` is the chat protocol, and a tool result's success/failure was not part of it — so the
-- eval projection (`run-trace.ts`) answered "did this tool call work" by looking at the first characters of the
-- result string. The kernel knows the answer at the moment it produces the result (`tool_result.isError`), and the
-- in-memory try path already carries it; only the persisted row could not say it.
--
-- Nullable on purpose: rows written before this column have no outcome to state, and a reader that treated NULL as
-- success would invent one. The projection falls back to the text for those and for those only.
ALTER TABLE everdict_agent_messages ADD COLUMN IF NOT EXISTS is_error boolean;
