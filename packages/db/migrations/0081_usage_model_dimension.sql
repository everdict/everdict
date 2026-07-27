-- Itemize metered usage per model: add a `model` dimension to everdict_usage so a workspace sees which model each
-- activity (harness / judge / agent) spent on, not just a single lump total (docs/architecture/usage-metering.md).
-- The accumulation key widens (tenant, source) -> (tenant, source, model). Existing rows default to model '' (an
-- unattributed legacy bucket), which keeps every current (tenant, source) row unique under the new key. Additive.
ALTER TABLE everdict_usage ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT '';

ALTER TABLE everdict_usage DROP CONSTRAINT IF EXISTS everdict_usage_pkey;
ALTER TABLE everdict_usage ADD PRIMARY KEY (tenant, source, model);
