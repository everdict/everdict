-- 0027_create_schedules — additive (expand): scheduled (cron) scorecard persistence table.
-- A schedule = a stored RunScorecardInput (run_template jsonb) + cron expression + policy. This table is the SSOT;
-- the Temporal Schedule is the execution mechanism (slice 2). Workspace (tenant) scoped. Design: docs/architecture/scheduled-evals.md.
CREATE TABLE IF NOT EXISTS everdict_schedules (
  id                text PRIMARY KEY,
  tenant            text NOT NULL,
  name              text NOT NULL,
  cron              text NOT NULL,
  timezone          text NOT NULL,
  overlap_policy    text NOT NULL,
  enabled           boolean NOT NULL,
  created_by        text NOT NULL,
  run_template      jsonb NOT NULL,
  last_fired_at     timestamptz,
  last_status       text,
  last_scorecard_id text,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);

-- For per-tenant listing + cursor (created_at DESC, id DESC) ordering.
CREATE INDEX IF NOT EXISTS everdict_schedules_tenant_created_idx ON everdict_schedules (tenant, created_at DESC, id DESC);
