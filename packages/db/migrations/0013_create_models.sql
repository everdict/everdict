-- 0013_create_models — additive (expand): the Model-version SSOT persistence table.
-- (tenant, id, version) is immutable — the code (PgModelRegistry) rejects re-registering different content.
-- model = ModelSpec(provider + underlying model + baseUrl/params, non-secret). _shared = first-party default model fallback.
-- judge/harness reference a registered model by id instead of a raw string → "which model was it run with" becomes a comparable first-class object.
CREATE TABLE IF NOT EXISTS everdict_models (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  model      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS everdict_models_tenant_id_idx ON everdict_models (tenant, id);
