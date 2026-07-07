-- 0006_create_scorecards — additive (expand): scorecard-run (dataset×harness batch eval) persistence table.
-- summary = lightweight aggregate (for listing), scorecard = full per-case results (for detail, includes traces → heavy).
CREATE TABLE IF NOT EXISTS everdict_scorecards (
  id              text PRIMARY KEY,
  tenant          text NOT NULL,
  dataset_id      text NOT NULL,
  dataset_version text NOT NULL,
  harness_id      text NOT NULL,
  harness_version text NOT NULL,
  status          text NOT NULL,
  summary         jsonb,
  scorecard       jsonb,
  error           jsonb,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

-- For per-tenant listing + cursor (created_at DESC, id DESC) ordering.
CREATE INDEX IF NOT EXISTS everdict_scorecards_tenant_created_idx ON everdict_scorecards (tenant, created_at DESC, id DESC);
