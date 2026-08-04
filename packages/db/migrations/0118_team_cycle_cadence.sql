-- TEAM CYCLE CADENCE (docs/tracker.md) — the settings that make a team's iterations exist without anybody
-- planning each one by hand.
--
-- 0110 gave a team `cycle_duration_weeks`: a span to propose the next window with. That is not a cadence — a
-- team still had to remember to create every cycle, and the first one started on whichever day somebody
-- happened to click. These three columns turn it into one: cycles are something a team switches ON, they start
-- on a fixed weekday, and the list read keeps `upcoming_cycle_count` of them standing in front of the active
-- one. Still no timer anywhere — provisioning happens on the read that needs them, the same way a workspace's
-- default team is recovered when its team list is read.

-- Whether the team paces itself in iterations at all. OFF by default, the same reasoning triage has — except
-- for teams that ALREADY have cycles, for whom off would mean losing a feature they are using.
ALTER TABLE everdict_teams ADD COLUMN IF NOT EXISTS cycles_enabled boolean NOT NULL DEFAULT false;
UPDATE everdict_teams t
   SET cycles_enabled = true
 WHERE NOT t.cycles_enabled
   AND EXISTS (SELECT 1 FROM everdict_cycles c WHERE c.tenant = t.tenant AND c.team_id = t.id);

-- 0 = Sunday … 6 = Saturday, Monday by default. Without it, two teams on the same fortnight are offset by
-- whichever afternoon each of them started, forever.
ALTER TABLE everdict_teams ADD COLUMN IF NOT EXISTS cycle_start_day integer NOT NULL DEFAULT 1;

-- How many FUTURE iterations stay provisioned in front of the active one, so next fortnight's work has
-- somewhere to go before anybody plans next fortnight.
ALTER TABLE everdict_teams ADD COLUMN IF NOT EXISTS upcoming_cycle_count integer NOT NULL DEFAULT 2;

-- --- The columns 0110 added but no store ever read or wrote ------------------------------------------------
-- `cycle_duration_weeks`, `triage_enabled` and `cycle_counter` have existed since 0110, but PgTeamStore never
-- selected them into the record nor listed them among its patchable columns — so on Postgres the team's cadence
-- and its triage switch read back as the schema defaults no matter what was saved, and `cycle_counter` stayed 0
-- forever, which made a team's SECOND cycle collide with the first on
-- `everdict_cycles_tenant_team_number`. The store fix ships with this migration; the backfill below repairs the
-- counter for teams that already have cycles, so the next one they plan gets the number after their latest
-- rather than a duplicate.
UPDATE everdict_teams t
   SET cycle_counter = c.max_number
  FROM (SELECT tenant, team_id, max(number) AS max_number FROM everdict_cycles GROUP BY tenant, team_id) c
 WHERE c.tenant = t.tenant
   AND c.team_id = t.id
   AND t.cycle_counter < c.max_number;
