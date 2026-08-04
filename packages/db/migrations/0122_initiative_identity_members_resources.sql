-- A goal grows the rest of what a goal has (docs/tracker.md): a face, the people on it, and the places it is
-- written down or measured. Additive — an initiative that predates this reads as icon-less, with nobody but its
-- lead named and no resources, which is exactly what it was.

ALTER TABLE everdict_initiatives ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE everdict_initiatives ADD COLUMN IF NOT EXISTS member_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
-- {label, url} pairs, in the author's order — the order IS the display order.
ALTER TABLE everdict_initiatives ADD COLUMN IF NOT EXISTS resources jsonb NOT NULL DEFAULT '[]'::jsonb;

-- "The goals I am on" — the same narrow slice `everdict_projects_member_ids` already answers one level down.
CREATE INDEX IF NOT EXISTS everdict_initiatives_member_ids ON everdict_initiatives USING gin (member_ids);

-- `planned` joins the status vocabulary as the state a new goal starts in. Nothing to migrate: every existing
-- row was created `active` under the old rule, and that is still what it was — work had begun on it.
