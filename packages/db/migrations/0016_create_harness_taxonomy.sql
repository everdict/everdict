-- 0016_create_harness_taxonomy — additive (expand): harness Template (top-level category) + Instance SSOT.
-- Template = structural skeleton (services/slots, versions unpinned). Instance = template reference + pins (delta). Both are version-immutable
-- (the code rejects re-registering a different spec). Key = (tenant, id, version), _shared (first-party) fallback.
-- Design: docs/architecture/harness-taxonomy.md.
CREATE TABLE IF NOT EXISTS everdict_harness_templates (
  tenant     text NOT NULL DEFAULT '_shared',
  id         text NOT NULL,
  version    text NOT NULL,
  spec       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);
CREATE INDEX IF NOT EXISTS everdict_harness_templates_tenant_id_idx ON everdict_harness_templates (tenant, id);

CREATE TABLE IF NOT EXISTS everdict_harness_instances (
  tenant     text NOT NULL DEFAULT '_shared',
  id         text NOT NULL,
  version    text NOT NULL,
  spec       jsonb NOT NULL, -- HarnessInstanceSpec: { template:{id,version}, id, version, pins }
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);
CREATE INDEX IF NOT EXISTS everdict_harness_instances_tenant_id_idx ON everdict_harness_instances (tenant, id);
