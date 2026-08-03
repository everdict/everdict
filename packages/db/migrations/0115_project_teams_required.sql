-- A project belongs to at least one team (docs/tracker.md).
--
-- `team_ids = '[]'` used to be legal and mean "workspace-wide", which quietly made a SECOND kind of project:
-- one that appears in no team's sidebar, and — now that an issue may only join a project its own team is on —
-- one no issue may ever be filed into. Linear has one kind of project and it is somebody's work. From here the
-- record schema requires a non-empty list, so this migration has to leave every existing row satisfying it.
--
-- Nothing is deleted and no link is dropped: both repairs are ADDITIVE, and they run in the order that loses
-- the least (derive from the issues actually in the project first, fall back to the default team only for the
-- projects that still name nobody).

-- ① The teams that already have issues in this project but are missing from its list. 0108 derived exactly this
-- when the column was introduced; drift since then (an issue moved teams, a team removed from the list while
-- its issues stayed) is repaired the same way. Appended rather than re-aggregated, because the order of the
-- list is its display order and a rewrite would reshuffle teams somebody arranged.
WITH missing AS (
  SELECT p.tenant, p.id, jsonb_agg(DISTINCT to_jsonb(i.team_id)) AS add_ids
  FROM everdict_projects p
  JOIN everdict_issues i ON i.tenant = p.tenant AND i.project_id = p.id
  WHERE NOT (p.team_ids @> to_jsonb(i.team_id))
  GROUP BY p.tenant, p.id
)
UPDATE everdict_projects p
SET team_ids = p.team_ids || m.add_ids
FROM missing m
WHERE p.tenant = m.tenant AND p.id = m.id;

-- ② A project nobody has filed an issue in yet lands on the workspace's default team — the same courtesy an
-- issue filed without a team gets, and the same fallback the create path now uses.
UPDATE everdict_projects p
SET team_ids = jsonb_build_array(t.id)
FROM everdict_teams t
WHERE t.tenant = p.tenant AND t.is_default AND p.team_ids = '[]'::jsonb;

-- ③ A workspace whose default flag never got repaired (`TeamService.ensureDefault` fixes it lazily, on a list
-- read that may not have happened yet) still has teams — take its oldest rather than leaving a row the record
-- schema will refuse to parse.
WITH oldest AS (
  SELECT DISTINCT ON (tenant) tenant, id FROM everdict_teams ORDER BY tenant, created_at, id
)
UPDATE everdict_projects p
SET team_ids = jsonb_build_array(o.id)
FROM oldest o
WHERE o.tenant = p.tenant AND p.team_ids = '[]'::jsonb;
