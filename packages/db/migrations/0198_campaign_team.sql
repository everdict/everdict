-- ── WHOSE CAMPAIGN THIS IS (arch-review 76 P1-security) ─────────────────────────────────────────────
--
-- A campaign drove a team-owned effect — it registers a successor under the entity's owning team — while
-- carrying no team of its own. So the read surface could only filter by tenant (a private team's campaign,
-- its issue id, its round hypotheses and its adoption proof were visible workspace-wide) and the adopt
-- mutation could only be gated by a workspace-level action, which asks nothing about the resource it
-- changes. Preserving an owner and being allowed to write to it are different questions.
--
-- Frozen at open from the ISSUE's team: the campaign journals into that issue, so they cannot belong to
-- different teams without one of them being a lie.
--
-- NULLABLE, and NOT backfilled. Rows written before this column existed have no team, which the authz
-- kernel reads as UNOWNED — the workspace's, never everyone's. Guessing which team an old campaign belonged
-- to would invent an authority nobody granted, which is the same reason the held-out flags were not
-- backfilled when that rule arrived (mig 0194's own lesson, one column over).
ALTER TABLE everdict_evolution_campaigns ADD COLUMN IF NOT EXISTS team_id text;

-- The team-filtered list read: a private team's campaigns are answered as nonexistent to everybody else,
-- so the page is built by the query rather than filtered after it.
CREATE INDEX IF NOT EXISTS everdict_evolution_campaigns_team_idx
  ON everdict_evolution_campaigns (tenant, team_id, created_at DESC, id DESC);
