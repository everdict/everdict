-- Where a registered version came from (migration 0109).
--
-- `created_by` already says WHO registered a harness/dataset/judge; nothing said WHY it exists. A judge an agent
-- authored from an issue arrived in the workspace anonymous — its detail view could name its creator and its
-- content and nothing else, so "why was this made, and from what" had no answer once the conversation scrolled
-- away. This column is that answer: the issue the version was built for, the agent + conversation that shaped it,
-- and the channel the registration came through. See packages/contracts/src/records/capability-origin.ts.
--
-- Provenance is a COLUMN, never a field inside the versioned spec — the same reason team_id and created_by are.
-- Versions are immutable, so a spec-resident origin would mean two versions born from the same issue are no longer
-- comparable, and re-stating where something came from would mint a version of content that did not change.
--
-- It also has to live on the RECORD rather than be derived from the `*.registered` platform facts: the event log is
-- swept (deleteOlderThan), and "why does this judge exist" is a question asked long after. Same reasoning as the
-- tracker's durable per-record history.
--
-- NULL is the normal state for everything registered before this migration, and it stays NULL: an origin invented
-- after the fact would be a guess wearing the clothes of a record. Existing capabilities surface their tie to an
-- issue through the reverse read (GET /issues?linkType=judge&linkId=…) instead.

ALTER TABLE everdict_harness_templates  ADD COLUMN IF NOT EXISTS origin jsonb;
ALTER TABLE everdict_harness_instances  ADD COLUMN IF NOT EXISTS origin jsonb;
ALTER TABLE everdict_datasets           ADD COLUMN IF NOT EXISTS origin jsonb;
ALTER TABLE everdict_judges             ADD COLUMN IF NOT EXISTS origin jsonb;
ALTER TABLE everdict_rubrics            ADD COLUMN IF NOT EXISTS origin jsonb;
ALTER TABLE everdict_runtimes           ADD COLUMN IF NOT EXISTS origin jsonb;
ALTER TABLE everdict_models             ADD COLUMN IF NOT EXISTS origin jsonb;
ALTER TABLE everdict_agents             ADD COLUMN IF NOT EXISTS origin jsonb;

-- "What did this issue give birth to" is the reverse read the tracker will want (the issue link answers it for
-- capabilities someone linked BY HAND; this answers it for the ones an agent actually created). Partial, because
-- the vast majority of rows carry no origin at all and an index over NULLs would be dead weight.
CREATE INDEX IF NOT EXISTS everdict_datasets_origin_from_idx
  ON everdict_datasets (tenant, (origin -> 'from' ->> 'type'), (origin -> 'from' ->> 'id'))
  WHERE origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS everdict_judges_origin_from_idx
  ON everdict_judges (tenant, (origin -> 'from' ->> 'type'), (origin -> 'from' ->> 'id'))
  WHERE origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS everdict_harness_instances_origin_from_idx
  ON everdict_harness_instances (tenant, (origin -> 'from' ->> 'type'), (origin -> 'from' ->> 'id'))
  WHERE origin IS NOT NULL;
