-- An initiative is a GOAL (docs/tracker.md), so it grows the half a goal needs and a release umbrella never
-- did: who is answerable for it, and how it is GOING in the words of the person answerable. Additive — an
-- initiative that predates this reads as unowned with no posted update, which is exactly what it was.

ALTER TABLE everdict_initiatives ADD COLUMN IF NOT EXISTS lead text;
-- The health of the LATEST posted update, denormalized onto the initiative so a list row shows it without
-- reading the update timeline once per row. The updates below stay the record; this is the current reading.
ALTER TABLE everdict_initiatives ADD COLUMN IF NOT EXISTS health text;

-- "The goals I am answerable for" — a narrow slice of the workspace's initiatives.
CREATE INDEX IF NOT EXISTS everdict_initiatives_tenant_lead ON everdict_initiatives (tenant, lead);

-- --- Initiative updates: the judgment, one level up --------------------------------------------------------
-- Append-only, mirroring everdict_project_updates. Its own table rather than a nullable owner on that one:
-- the two timelines are read separately (a goal's update summarizes across projects), and a half-used column
-- is how one table quietly becomes two.
CREATE TABLE IF NOT EXISTS everdict_initiative_updates (
  id text NOT NULL,
  tenant text NOT NULL,
  initiative_id text NOT NULL,
  health text NOT NULL,
  body text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, id)
);
-- The timeline read: one initiative's updates, newest first.
CREATE INDEX IF NOT EXISTS everdict_initiative_updates_tenant_initiative
  ON everdict_initiative_updates (tenant, initiative_id, created_at DESC);
