-- 0014_create_metrics — additive (expand): the Metric-version SSOT persistence table.
-- (tenant, id, version) is immutable — the code (PgMetricRegistry) rejects re-registering different content.
-- metric = MetricSpec(pass rules such as threshold, non-secret). _shared = first-party default metric fallback.
-- User-defined metrics at runtime → the control plane applies them post-hoc over the trace/scores after a run (same path as a judge).
CREATE TABLE IF NOT EXISTS everdict_metrics (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  metric     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS everdict_metrics_tenant_id_idx ON everdict_metrics (tenant, id);
