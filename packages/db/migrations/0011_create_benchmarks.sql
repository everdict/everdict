-- 0011_create_benchmarks — additive (expand): the benchmark-definition (recipe) SSOT persistence table.
-- (tenant, id, version) is immutable — the code (PgBenchmarkRegistry) rejects re-registering different content.
-- Same tenant-ownership model as datasets (_shared = first-party recipe fallback). spec = BenchmarkAdapterSpec(JSON).
CREATE TABLE IF NOT EXISTS everdict_benchmarks (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  spec       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS everdict_benchmarks_tenant_id_idx ON everdict_benchmarks (tenant, id);
