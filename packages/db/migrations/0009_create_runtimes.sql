-- 0009_create_runtimes — additive (expand): the tenant execution-infra (Runtime) version SSOT persistence table.
-- (tenant, id, version) is immutable. runtime = RuntimeSpec(local | nomad | k8s) — no secrets (credentials live in SecretStore).
-- _shared = first-party shared runtime fallback. (0007=secrets, 0008=judges → runtimes is 0009.)
CREATE TABLE IF NOT EXISTS everdict_runtimes (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  runtime    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS everdict_runtimes_tenant_id_idx ON everdict_runtimes (tenant, id);
