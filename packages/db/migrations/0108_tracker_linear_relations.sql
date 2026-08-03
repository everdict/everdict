-- The tracker's relationship axis, brought to Linear's shape (docs/tracker.md).
--
-- Until now a project carried at most ONE initiative and no team at all, and "this team's projects" was derived
-- from the team's issues — which answered "no projects" for exactly as long as a project was still being planned.
-- Linear's shape is two many-to-many edges (project↔team, project↔initiative) plus nesting on teams and
-- initiatives, and this migration lands all four. The single-initiative column is backfilled into the list and
-- then DROPPED in the same step — a deliberate clean break rather than an expand→contract window, because
-- carrying a mirror of the head of a list is a second source of truth for exactly the field this change exists
-- to make plural. Two spellings of "which initiative" is the bug, not the migration cost.

-- --- Project ↔ Team and Project ↔ Initiative, both many-to-many -------------------------------------------
-- jsonb arrays rather than join tables: these lists are short, always read WITH their project (never joined
-- against on their own), and the containment queries below index cleanly with GIN. A join table would buy
-- referential integrity we do not enforce anywhere else in the tracker — links are pointers here, resolved
-- through the normal RBAC-gated reads.
ALTER TABLE everdict_projects ADD COLUMN IF NOT EXISTS team_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE everdict_projects ADD COLUMN IF NOT EXISTS initiative_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

-- The single initiative becomes a one-element list. Done before the team backfill so a project that had an
-- umbrella keeps it no matter what its issues say.
UPDATE everdict_projects
SET initiative_ids = jsonb_build_array(initiative_id)
WHERE initiative_id IS NOT NULL AND initiative_ids = '[]'::jsonb;

-- Teams come from where the answer used to be computed: the teams that already have issues in the project. A
-- project nobody has filed an issue in gets no teams (workspace-wide), which is what it effectively was before.
WITH project_teams AS (
  SELECT i.tenant, i.project_id, jsonb_agg(DISTINCT i.team_id) AS team_ids
  FROM everdict_issues i
  WHERE i.project_id IS NOT NULL
  GROUP BY i.tenant, i.project_id
)
UPDATE everdict_projects p
SET team_ids = t.team_ids
FROM project_teams t
WHERE p.tenant = t.tenant AND p.id = t.project_id AND p.team_ids = '[]'::jsonb;

-- The readiness roll-up and the per-team project list are both containment tests over these arrays.
CREATE INDEX IF NOT EXISTS everdict_projects_initiative_ids ON everdict_projects USING gin (initiative_ids);
CREATE INDEX IF NOT EXISTS everdict_projects_team_ids ON everdict_projects USING gin (team_ids);

-- The scalar column and its index are gone: `initiative_ids` is now the only answer to "which umbrella".
DROP INDEX IF EXISTS everdict_projects_tenant_initiative;
ALTER TABLE everdict_projects DROP COLUMN IF EXISTS initiative_id;

-- --- Nesting: sub-teams and sub-initiatives ----------------------------------------------------------------
-- Organisational only. A sub-team still mints its own identifiers and owns its own issues; an initiative's
-- readiness, by contrast, DOES roll up through its descendants — that is the whole point of nesting a bet.
ALTER TABLE everdict_teams ADD COLUMN IF NOT EXISTS parent_id text;
ALTER TABLE everdict_initiatives ADD COLUMN IF NOT EXISTS parent_id text;
CREATE INDEX IF NOT EXISTS everdict_teams_tenant_parent ON everdict_teams (tenant, parent_id);
CREATE INDEX IF NOT EXISTS everdict_initiatives_tenant_parent ON everdict_initiatives (tenant, parent_id);

-- --- An issue's former names -------------------------------------------------------------------------------
-- Moving an issue between teams re-mints its identifier from the destination's counter, so `ENG-12` becomes
-- `PLT-3`. Every link already pasted into a pull request or a chat message says the old name, so the old name
-- has to keep resolving: the lookup falls back to this list and the web redirects to the canonical slug.
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS former_identifiers jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS everdict_issues_former_identifiers
  ON everdict_issues USING gin (former_identifiers);
