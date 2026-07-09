-- 0053_create_rubrics — additive (expand): the Rubric-version SSOT persistence table (eval-domain-model S3).
-- (tenant, id, version) is immutable — the code (PgRubricRegistry) rejects re-registering different content.
-- rubric = RubricSpec (text and/or criteria + optional prompt template — HOW to judge, referenced by judges).
-- _shared = first-party default rubric fallback. created_by is included from the start (judges gained it in 0032).
CREATE TABLE IF NOT EXISTS everdict_rubrics (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  rubric     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS everdict_rubrics_tenant_id_idx ON everdict_rubrics (tenant, id);
