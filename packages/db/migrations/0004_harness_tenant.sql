-- 0004_harness_tenant — add tenant ownership to harnesses (expand). Existing rows are backfilled to _shared (first-party).
-- Redefines the PK as (tenant, id, version). The migrator runs it exactly once.
ALTER TABLE everdict_harnesses ADD COLUMN IF NOT EXISTS tenant text NOT NULL DEFAULT '_shared';

ALTER TABLE everdict_harnesses DROP CONSTRAINT IF EXISTS everdict_harnesses_pkey;
ALTER TABLE everdict_harnesses ADD PRIMARY KEY (tenant, id, version);

CREATE INDEX IF NOT EXISTS everdict_harnesses_tenant_id_idx ON everdict_harnesses (tenant, id);
