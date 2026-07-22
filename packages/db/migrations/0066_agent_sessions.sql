-- 0066_agent_sessions — additive (expand): persistence for Everdict's own conversational agent
-- (docs/architecture/agent-conversations.md). A session is owner-scoped within a workspace (a member's own chat
-- history); messages form an append-only, seq-ordered transcript. tool_calls holds an assistant turn's requested
-- tools (jsonb) so the transcript can be replayed into the model as loop history.
CREATE TABLE IF NOT EXISTS everdict_agent_sessions (
  id          text PRIMARY KEY,
  tenant      text NOT NULL,
  owner       text NOT NULL,
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS everdict_agent_sessions_owner_idx
  ON everdict_agent_sessions (tenant, owner, updated_at DESC);

CREATE TABLE IF NOT EXISTS everdict_agent_messages (
  id            text PRIMARY KEY,
  tenant        text NOT NULL,
  session_id    text NOT NULL,
  seq           integer NOT NULL,
  role          text NOT NULL,
  content       text NOT NULL,
  tool_calls    jsonb,
  tool_call_id  text,
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS everdict_agent_messages_session_idx
  ON everdict_agent_messages (tenant, session_id, seq);
