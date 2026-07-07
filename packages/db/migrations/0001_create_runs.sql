-- 0001_create_runs — additive (expand): the result-store runs table.
-- Not a destructive change, so it can be applied directly with the deploy. preflight: docs/migration/preflight/0001_create_runs.md
CREATE TABLE IF NOT EXISTS everdict_runs (
  id              text PRIMARY KEY,
  tenant          text NOT NULL,
  harness_id      text NOT NULL,
  harness_version text NOT NULL,
  case_id         text NOT NULL,
  status          text NOT NULL,
  result          jsonb,
  error           jsonb,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

-- For per-tenant listing + cursor (created_at DESC, id DESC) ordering.
CREATE INDEX IF NOT EXISTS everdict_runs_tenant_created_idx ON everdict_runs (tenant, created_at DESC, id DESC);
