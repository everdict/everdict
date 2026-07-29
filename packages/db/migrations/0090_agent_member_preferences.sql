-- 0090_agent_member_preferences — additive (expand): the PER-MEMBER overlay on what a workspace's agent carries.
-- The workspace's AgentSpec + skill library are the shared baseline ("what this workspace supports"); a row here is
-- one member's answer to "which of it does MY agent carry" — the TOOLS it can call (Settings › Agent › Tools) and the
-- SKILLS it follows (Settings › Agent › Skills). Two members of one workspace therefore talk to the same assistant
-- and get different tools and different procedures.
--
-- Both columns are key → boolean, and an ABSENT key is meaningful: it means "follow the workspace baseline", so a
-- later change to that baseline still reaches the member. Storing today's baseline value instead would freeze them.
-- No secrets and no tool/skill CONTENT here — only decisions.
CREATE TABLE IF NOT EXISTS everdict_agent_member_preferences (
  tenant     text        NOT NULL,
  subject    text        NOT NULL,
  tools      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  skills     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, subject)
);
