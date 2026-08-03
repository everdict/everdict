-- Projects grow the half Linear has and we did not (docs/tracker.md): who is answerable, who is on it, how it
-- is GOING, and the checkpoints inside it. Additive — a project that predates all four reads as unowned, with
-- no posted update and no milestones, which is exactly what it was.

ALTER TABLE everdict_projects ADD COLUMN IF NOT EXISTS lead text;
ALTER TABLE everdict_projects ADD COLUMN IF NOT EXISTS member_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
-- The health of the LATEST posted update, denormalized onto the project so a list row can show it without
-- reading the update timeline once per row. The updates below stay the record; this is the current reading.
ALTER TABLE everdict_projects ADD COLUMN IF NOT EXISTS health text;
-- The checkpoints, in order. Embedded rather than a table: a handful per project, never read without it, and
-- an issue points at one by id (`everdict_issues.milestone_id`).
ALTER TABLE everdict_projects ADD COLUMN IF NOT EXISTS milestones jsonb NOT NULL DEFAULT '[]'::jsonb;

-- "My projects" — the lead's list and the member's list are both a narrow slice of the workspace's projects.
CREATE INDEX IF NOT EXISTS everdict_projects_tenant_lead ON everdict_projects (tenant, lead);
CREATE INDEX IF NOT EXISTS everdict_projects_member_ids ON everdict_projects USING gin (member_ids);

-- --- Project updates: the one JUDGMENT the tracker records --------------------------------------------------
-- Append-only. "At risk" is somebody SAYING so, not arithmetic over the rollup, so the health rides with the
-- sentence that explains it — and a reader who sees the colour change goes to the sentence.
CREATE TABLE IF NOT EXISTS everdict_project_updates (
  id text NOT NULL,
  tenant text NOT NULL,
  project_id text NOT NULL,
  health text NOT NULL,
  body text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant, id)
);
-- The timeline read: one project's updates, newest first.
CREATE INDEX IF NOT EXISTS everdict_project_updates_tenant_project
  ON everdict_project_updates (tenant, project_id, created_at DESC);

-- --- An issue's checkpoint ----------------------------------------------------------------------------------
ALTER TABLE everdict_issues ADD COLUMN IF NOT EXISTS milestone_id text;
CREATE INDEX IF NOT EXISTS everdict_issues_tenant_milestone ON everdict_issues (tenant, milestone_id);
