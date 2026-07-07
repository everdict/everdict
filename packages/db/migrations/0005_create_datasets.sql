-- 0005_create_datasets — additive (expand): the dataset-version SSOT persistence table.
-- (tenant, id, version) is immutable — the code (PgDatasetRegistry) rejects re-registering different content.
-- Unlike harnesses, tenant ownership is included from the start (_shared = first-party benchmark fallback).
CREATE TABLE IF NOT EXISTS everdict_datasets (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  dataset    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS everdict_datasets_tenant_id_idx ON everdict_datasets (tenant, id);
