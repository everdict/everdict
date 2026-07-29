-- Durable agent-approval ledger (agent-automation A6, execution-master-plan W2): a parked agent mutation
-- survives an agent-service restart as a record; the approval:<id> workflow owns the days-long wait +
-- deny-on-expiry on top. request_id correlates back to the in-process wait for live delivery.
CREATE TABLE IF NOT EXISTS everdict_approvals (
  id text PRIMARY KEY,
  tenant text NOT NULL,
  session_id text NOT NULL,
  agent_id text,
  request_id text NOT NULL,
  request jsonb NOT NULL,
  status text NOT NULL,
  decided_by text,
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
-- The pending-list read (web bell/fleet + the workflow's guards) — narrow by workspace and status.
CREATE INDEX IF NOT EXISTS everdict_approvals_tenant_status_idx
  ON everdict_approvals (tenant, status, created_at DESC);
