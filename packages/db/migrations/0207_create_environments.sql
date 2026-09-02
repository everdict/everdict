-- 0207_create_environments — additive (expand): the tenant Environment version SSOT.
-- (tenant, id, version) is immutable. environment = EnvironmentSpec (the world a case ACTS ON, as opposed to
-- the harness that acts). _shared = first-party shared fallback, like every other registry table.
-- Carries every column a registry table has carried since it existed (tags 0047, team_id 0106, origin 0111),
-- because a new table that omits them is a registry whose owner gate can never refuse (see PgRuntimeRegistry).
-- Design: docs/architecture/harness-definability-spec.md §2.
CREATE TABLE IF NOT EXISTS everdict_environments (
  tenant      text NOT NULL,
  id          text NOT NULL,
  version     text NOT NULL,
  environment jsonb NOT NULL,
  tags        jsonb NOT NULL DEFAULT '[]'::jsonb,
  team_id     text,
  origin      jsonb,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS everdict_environments_tenant_id_idx ON everdict_environments (tenant, id);
CREATE INDEX IF NOT EXISTS everdict_environments_team_idx ON everdict_environments (tenant, team_id);
