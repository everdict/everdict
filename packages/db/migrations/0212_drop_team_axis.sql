-- 0212_drop_team_axis — CONTRACT: the team columns and the team/cycle tables go.
--
-- ⚠️ DO NOT APPLY THIS UNTIL `scripts/live/migrate-teams-to-workspace.mjs` HAS RUN AND REPORTED CLEAN.
-- Everything below is irreversible, and two of the columns hold the only record of a decision:
--
--   · `everdict_issues.team_id`      — which list an issue was on, and therefore what its old identifier meant
--   · `everdict_teams.is_private`    — the read ceiling. Dropping it is the moment the assets of a private
--                                      team become visible to every member of the workspace. The script counts
--                                      those rows and prints them BEFORE anything is dropped, because
--                                      "how many things is this about to expose" is a question an operator
--                                      should be able to answer beforehand rather than afterwards.
--
-- The preflight for this file lives in `docs/migration/preflight/0212-drop-team-axis.md`.

-- ── ① THE OWNERSHIP AXIS ───────────────────────────────────────────────────────────────────────────
--
-- Fourteen tables carried `team_id` (migration 0106 and its successors). The workspace owns all of it now;
-- `tenant` was always the column that said so.
ALTER TABLE everdict_harness_templates    DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_harness_instances    DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_datasets             DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_judges               DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_rubrics              DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_runtimes             DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_models               DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_agents               DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_benchmarks           DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_scorecards           DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_runs                 DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_environments         DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_evolution_campaigns  DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_issues               DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_workflow_states      DROP COLUMN IF EXISTS team_id;
ALTER TABLE everdict_projects             DROP COLUMN IF EXISTS team_ids;

-- ② The iteration axis. Cycles were a team's numbered window and went with it (the maintainer's decision:
-- collapsing "Cycle 7" from several teams into one sequence would renumber history that people cite).
ALTER TABLE everdict_issues DROP COLUMN IF EXISTS cycle_id;
ALTER TABLE everdict_issues DROP COLUMN IF EXISTS in_triage;
DROP TABLE IF EXISTS everdict_cycles;

-- ③ The team itself, its roster, and the indexes that led with it.
DROP INDEX IF EXISTS everdict_harness_templates_team_idx;
DROP INDEX IF EXISTS everdict_harness_instances_team_idx;
DROP INDEX IF EXISTS everdict_datasets_team_idx;
DROP INDEX IF EXISTS everdict_judges_team_idx;
DROP INDEX IF EXISTS everdict_rubrics_team_idx;
DROP INDEX IF EXISTS everdict_runtimes_team_idx;
DROP INDEX IF EXISTS everdict_models_team_idx;
DROP INDEX IF EXISTS everdict_agents_team_idx;
DROP INDEX IF EXISTS everdict_benchmarks_team_idx;
DROP INDEX IF EXISTS everdict_scorecards_team_idx;
DROP INDEX IF EXISTS everdict_runs_team_idx;
DROP TABLE IF EXISTS everdict_team_members;
DROP TABLE IF EXISTS everdict_teams;
