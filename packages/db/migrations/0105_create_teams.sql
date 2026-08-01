-- Teams — the tracker's grouping layer inside a workspace (docs/tracker.md). A team owns ISSUES and names them
-- (`ENG-12`); projects and initiatives stay workspace-level so a release several teams contribute to is still
-- one readiness gate. The trust zone is unchanged: `workspace = tenant` remains the isolation boundary, and a
-- team is a grouping of intent inside it.

CREATE TABLE IF NOT EXISTS everdict_teams (
  id text NOT NULL,
  tenant text NOT NULL,
  -- Immutable after creation: it is baked into every identifier the team has ever minted.
  key text NOT NULL,
  name text NOT NULL,
  description text,
  is_default boolean NOT NULL DEFAULT false,
  -- The identifier sequence lives HERE rather than being derived with max(number)+1, so allocation is one
  -- conditional UPDATE … RETURNING and two concurrent filings can never be handed the same number.
  issue_counter integer NOT NULL DEFAULT 0,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, id)
);

-- One team per key per workspace — the prefix has to identify the team for identifiers to mean anything.
CREATE UNIQUE INDEX IF NOT EXISTS everdict_teams_tenant_key ON everdict_teams (tenant, key);
-- Exactly one default per workspace, enforced by the database rather than by convention: it is the landing
-- place for every issue filed without a team, so "which one" can never be ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS everdict_teams_tenant_default
  ON everdict_teams (tenant) WHERE is_default;

-- Team membership is its own roster, separate from workspace membership. It carries no role: permission still
-- comes from the workspace role (issues:* / teams:*), so this is a visibility and ownership statement only.
CREATE TABLE IF NOT EXISTS everdict_team_members (
  tenant text NOT NULL,
  team_id text NOT NULL,
  subject text NOT NULL,
  added_by text NOT NULL,
  added_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, team_id, subject)
);
CREATE INDEX IF NOT EXISTS everdict_team_members_subject ON everdict_team_members (tenant, subject);

-- --- Issues gain their owning team + identity ------------------------------------------------------------
-- Added nullable so the backfill below can fill them before the NOT NULL constraints land.
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS number integer;
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS identifier text;

-- --- Backfill --------------------------------------------------------------------------------------------
-- Every workspace keeps at least one team, so each existing one gets a default "Core" (key CORE). Tenants are
-- taken from the workspace roster UNION the tenants that already have issues — a tenant can own issues without
-- a workspace row (the dev/api-key bootstrap path), and leaving those issues teamless would break NOT NULL.
INSERT INTO everdict_teams (id, tenant, key, name, description, is_default, issue_counter, history, created_by, created_at, updated_at)
SELECT
  gen_random_uuid()::text,
  t.tenant,
  'CORE',
  'Core',
  'Created automatically when teams were introduced — every issue that predates teams belongs to it.',
  true,
  0,
  '[]'::jsonb,
  'system',
  now(),
  now()
FROM (
  SELECT id AS tenant FROM everdict_workspaces
  UNION
  SELECT DISTINCT tenant FROM everdict_issues
) AS t
WHERE NOT EXISTS (SELECT 1 FROM everdict_teams e WHERE e.tenant = t.tenant);

-- Existing issues join their workspace's default team and are numbered in creation order, so the oldest issue
-- becomes CORE-1 and the identifiers read as a history rather than a shuffle.
WITH numbered AS (
  SELECT
    i.tenant,
    i.id,
    row_number() OVER (PARTITION BY i.tenant ORDER BY i.created_at, i.id) AS seq
  FROM everdict_issues i
  WHERE i.team_id IS NULL
)
UPDATE everdict_issues i
SET team_id = d.id,
    number = n.seq,
    identifier = d.key || '-' || n.seq
FROM numbered n
JOIN everdict_teams d ON d.tenant = n.tenant AND d.is_default
WHERE i.tenant = n.tenant AND i.id = n.id;

-- The counter must continue past what the backfill consumed, or the next filing would collide.
UPDATE everdict_teams t
SET issue_counter = c.max_number
FROM (SELECT tenant, team_id, max(number) AS max_number FROM everdict_issues GROUP BY tenant, team_id) c
WHERE t.tenant = c.tenant AND t.id = c.team_id AND t.issue_counter < c.max_number;

ALTER TABLE everdict_issues ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE everdict_issues ALTER COLUMN number SET NOT NULL;
ALTER TABLE everdict_issues ALTER COLUMN identifier SET NOT NULL;

-- `ENG-12` is how people refer to an issue, so it has to resolve to exactly one row.
CREATE UNIQUE INDEX IF NOT EXISTS everdict_issues_tenant_identifier ON everdict_issues (tenant, identifier);
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_team ON everdict_issues (tenant, team_id, updated_at DESC);
