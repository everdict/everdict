-- WORKFLOW STATES (docs/tracker.md) — a team's own names for the positions in its workflow.
--
-- The canonical vocabulary stays CLOSED (`everdict_issues.status`): a workflow state is a NAMED VIEW onto it,
-- declaring which canonical status it is. That is what lets a team rename "Todo" to "Up next", recolour it,
-- reorder the board or add "In QA" beside "In review" while every programmatic reader — the release gate, the
-- rollups, the regression watch, the GitHub sync — keeps reading `status` and cannot be broken by a rename.

CREATE TABLE IF NOT EXISTS everdict_workflow_states (
  id text NOT NULL,
  tenant text NOT NULL,
  team_id text NOT NULL,
  name text NOT NULL,
  description text,
  -- The canonical status this state IS. Two states may share one (a team with both "In review" and "In QA"),
  -- which is the flexibility a team wants and the invariance every reader needs.
  status text NOT NULL,
  color text NOT NULL,
  -- Board order: a workflow is a sequence, so position is meaning rather than a display preference.
  position integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS everdict_workflow_states_tenant_team
  ON everdict_workflow_states (tenant, team_id, position);
-- One name per team, or a board shows two columns nobody can tell apart.
CREATE UNIQUE INDEX IF NOT EXISTS everdict_workflow_states_tenant_team_name
  ON everdict_workflow_states (tenant, team_id, lower(name));

-- Which state an issue sits in. NULL = the team's default state for the issue's canonical status, which is what
-- every issue that predates this table reads as.
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS state_id text;
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_state ON everdict_issues (tenant, state_id);

-- --- Seed every existing team with the default set -----------------------------------------------------------
-- Six states, in board order, mapped onto the canonical statuses. `regressed` deliberately gets no state: an
-- issue reaches it only by falling from a resolution (the regression watch), never by somebody dragging a card.
INSERT INTO everdict_workflow_states (id, tenant, team_id, name, status, color, position, created_at, updated_at)
SELECT gen_random_uuid()::text, t.tenant, t.id, d.name, d.status, d.color, d.position, now(), now()
FROM everdict_teams t
CROSS JOIN (VALUES
  ('Backlog', 'backlog', 'gray', 0),
  ('Todo', 'todo', 'blue', 1),
  ('In progress', 'in_progress', 'yellow', 2),
  ('In review', 'in_review', 'purple', 3),
  ('Done', 'done', 'green', 4),
  ('Cancelled', 'cancelled', 'gray', 5)
) AS d(name, status, color, position)
WHERE NOT EXISTS (
  SELECT 1 FROM everdict_workflow_states w WHERE w.tenant = t.tenant AND w.team_id = t.id
);

-- Existing issues land in their team's state for the status they already have. A `regressed` issue stays
-- state-less, which reads exactly as it should: it is not sitting in a column somebody put it in.
UPDATE everdict_issues i
SET state_id = w.id
FROM everdict_workflow_states w
WHERE i.state_id IS NULL AND w.tenant = i.tenant AND w.team_id = i.team_id AND w.status = i.status;
