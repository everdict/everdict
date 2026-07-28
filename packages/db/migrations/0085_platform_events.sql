-- Platform event log (docs/architecture/agent-automation.md A1) — append-only facts the control plane records at
-- lifecycle points. seq is the deployment-wide reconcile cursor (the agent service walks `seq > lastSeen`).
-- Additive (no preflight).
CREATE TABLE IF NOT EXISTS everdict_platform_events (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  tenant TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  actor TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  caused_by TEXT,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS everdict_platform_events_tenant_seq ON everdict_platform_events (tenant, seq);
CREATE INDEX IF NOT EXISTS everdict_platform_events_tenant_kind_seq ON everdict_platform_events (tenant, kind, seq);
