-- 0002_create_harnesses — additive (expand): the harness-version SSOT persistence table.
-- (id, version) is immutable — the code (PgHarnessRegistry) rejects re-registering a different spec.
-- Tenant ownership (tenant column) is to be added later via an expand migration.
CREATE TABLE IF NOT EXISTS everdict_harnesses (
  id         text NOT NULL,
  version    text NOT NULL,
  spec       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

CREATE INDEX IF NOT EXISTS everdict_harnesses_id_idx ON everdict_harnesses (id);
