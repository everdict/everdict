-- 0008_create_judges — additive (expand): the Agent Judge-version SSOT persistence table.
-- (tenant, id, version) is immutable — the code (PgJudgeRegistry) rejects re-registering different content.
-- judge = JudgeSpec(model | harness). _shared = first-party default judge fallback.
-- (0007 is the secrets migration from concurrent work → judges is 0008.)
CREATE TABLE IF NOT EXISTS everdict_judges (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  judge      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS everdict_judges_tenant_id_idx ON everdict_judges (tenant, id);
