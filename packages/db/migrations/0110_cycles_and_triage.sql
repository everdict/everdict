-- CYCLES + TRIAGE (docs/tracker.md) — a team's iteration, and the queue in front of its workflow.
--
-- A cycle belongs to exactly one TEAM: an iteration is how a working group paces itself, and a workspace-wide
-- one would mean nothing to any of them. Projects and initiatives keep answering the other question ("did we
-- finish by the date"), so the two axes stay separate here as well.

CREATE TABLE IF NOT EXISTS everdict_cycles (
  id text NOT NULL,
  tenant text NOT NULL,
  team_id text NOT NULL,
  -- Per-team sequence, allocated from the team's own counter exactly like an issue number.
  number integer NOT NULL,
  name text,
  description text,
  -- Calendar dates (YYYY-MM-DD) stored verbatim: a cycle runs from a day to a day, and text round-trips with
  -- no timezone reinterpretation. The STATE (upcoming/active/completed) is derived from these plus
  -- `completed_at` — never stored, because a cycle becomes active by time passing and a stored status would be
  -- wrong for exactly as long as nobody wrote to it.
  starts_at text NOT NULL,
  ends_at text NOT NULL,
  completed_at timestamptz,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, id)
);

-- The team's cycle list, newest iteration first — the one read every cycle screen starts from.
CREATE INDEX IF NOT EXISTS everdict_cycles_tenant_team ON everdict_cycles (tenant, team_id, number DESC);
-- "Cycle 7" has to name one iteration per team, or a retro cites an ambiguous number.
CREATE UNIQUE INDEX IF NOT EXISTS everdict_cycles_tenant_team_number
  ON everdict_cycles (tenant, team_id, number);

-- --- The team's own cycle + triage settings -----------------------------------------------------------------
-- A default span rather than a schedule: nothing creates cycles on a timer, but planning the next one should be
-- a click instead of two dates. Triage is OFF by default — a team that has not asked for a queue in front of
-- its workflow should not suddenly have one.
ALTER TABLE everdict_teams ADD COLUMN IF NOT EXISTS cycle_duration_weeks integer NOT NULL DEFAULT 2;
ALTER TABLE everdict_teams ADD COLUMN IF NOT EXISTS triage_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE everdict_teams ADD COLUMN IF NOT EXISTS cycle_counter integer NOT NULL DEFAULT 0;

-- --- The issue's place in an iteration, and whether it is still waiting to enter the workflow ---------------
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS cycle_id text;
-- A FLAG, not a status: the status vocabulary is the workflow, and something waiting to enter the workflow has
-- not started it. Accepting clears the flag; declining cancels the issue.
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS in_triage boolean NOT NULL DEFAULT false;

-- The cycle board's read, and the triage inbox's — both are "this narrow slice of one team's issues".
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_cycle ON everdict_issues (tenant, cycle_id);
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_triage
  ON everdict_issues (tenant, team_id, updated_at DESC)
  WHERE in_triage;
