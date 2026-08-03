-- Team ownership for the eval assets (migration 0106).
--
-- Teams became the tracker's ownership axis in 0105; this extends the same axis to everything a team actually
-- works ON. A harness, dataset, judge, rubric, runtime, model, agent or benchmark now records the team that owns
-- it, and the authz kernel refuses a WRITE from someone who is not on that team (reads stay workspace-wide —
-- ownership filters lists, it does not hide the workspace). See can() in @everdict/domain.
--
-- Ownership is a COLUMN, never a field inside the versioned spec: versions are immutable, so putting the owner in
-- the spec would mean transferring a team mints a new version of something whose content did not change. It sits
-- beside created_by, which is metadata for the same reason.
--
-- NULL = unowned, and that is a real state, not a gap to be filled later: `_shared` catalogue entries and anything
-- seeded by the operator belong to no team, and the gate deliberately lets those through. Only a tenant's OWN rows
-- are backfilled, and only into that tenant's default team — the one an issue lands in when the caller names none.

ALTER TABLE everdict_harness_templates  ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE everdict_harness_instances  ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE everdict_datasets           ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE everdict_judges             ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE everdict_rubrics            ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE everdict_runtimes           ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE everdict_models             ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE everdict_agents             ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE everdict_benchmarks         ADD COLUMN IF NOT EXISTS team_id text;

-- Batch results carry the same axis so "what has my team evaluated" is answerable without walking every harness.
ALTER TABLE everdict_scorecards         ADD COLUMN IF NOT EXISTS team_id text;
ALTER TABLE everdict_runs               ADD COLUMN IF NOT EXISTS team_id text;

-- Listing "this team's assets" is the read this axis exists for, and it is always tenant-scoped first.
CREATE INDEX IF NOT EXISTS everdict_harness_templates_team_idx ON everdict_harness_templates (tenant, team_id);
CREATE INDEX IF NOT EXISTS everdict_harness_instances_team_idx ON everdict_harness_instances (tenant, team_id);
CREATE INDEX IF NOT EXISTS everdict_datasets_team_idx          ON everdict_datasets (tenant, team_id);
CREATE INDEX IF NOT EXISTS everdict_judges_team_idx            ON everdict_judges (tenant, team_id);
CREATE INDEX IF NOT EXISTS everdict_rubrics_team_idx           ON everdict_rubrics (tenant, team_id);
CREATE INDEX IF NOT EXISTS everdict_runtimes_team_idx          ON everdict_runtimes (tenant, team_id);
CREATE INDEX IF NOT EXISTS everdict_models_team_idx            ON everdict_models (tenant, team_id);
CREATE INDEX IF NOT EXISTS everdict_agents_team_idx            ON everdict_agents (tenant, team_id);
CREATE INDEX IF NOT EXISTS everdict_benchmarks_team_idx        ON everdict_benchmarks (tenant, team_id);
CREATE INDEX IF NOT EXISTS everdict_scorecards_team_idx        ON everdict_scorecards (tenant, team_id);
CREATE INDEX IF NOT EXISTS everdict_runs_team_idx              ON everdict_runs (tenant, team_id);

-- Backfill: a tenant's own rows join that tenant's default team. `_shared` is skipped by the tenant join (it has
-- no team of its own), and rows already owned are left alone so re-running this is a no-op.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'everdict_harness_templates','everdict_harness_instances','everdict_datasets','everdict_judges',
    'everdict_rubrics','everdict_runtimes','everdict_models','everdict_agents','everdict_benchmarks',
    'everdict_scorecards','everdict_runs'
  ]
  LOOP
    EXECUTE format(
      'UPDATE %I x SET team_id = d.id FROM everdict_teams d
         WHERE d.tenant = x.tenant AND d.is_default AND x.team_id IS NULL',
      t
    );
  END LOOP;
END $$;
