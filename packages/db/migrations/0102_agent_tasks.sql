-- The workspace task ledger (docs/architecture/agent-teams.md): cross-turn, cross-agent coordination tasks
-- members and agents create, claim, chain (blocked_by) and complete. Workspace-shared by design (no visibility
-- tier — a coordination ledger only coordinates what everyone can see). Lifecycle facts (task.created/claimed/
-- completed/cancelled) are emitted by TaskService, not stored here.
CREATE TABLE IF NOT EXISTS everdict_agent_tasks (
  id text NOT NULL,
  tenant text NOT NULL,
  subject text NOT NULL,
  description text,
  status text NOT NULL,
  owner text,
  blocked_by jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  origin jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS everdict_agent_tasks_tenant_status ON everdict_agent_tasks (tenant, status, updated_at DESC);
