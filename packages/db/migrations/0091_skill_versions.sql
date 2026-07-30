-- 0091_skill_versions — additive (expand): a workspace skill gets its OWN version line, plus the provenance of a skill
-- copied out of the store.
--
-- Everdict's managed skills are examples that live in the store, not a tier every workspace silently carries: taking
-- one COPIES it into the workspace's own library (everdict_skills), where the members edit it like anything they wrote
-- themselves. `origin` records which publication the copy came from — provenance only, never a live link (the store
-- uses it to stop offering an example the workspace already took).
--
-- `version` on the skill row is a POINTER, not history: the row is the working copy the members (and the agent, in
-- conversation) keep editing, and a stamp freezes that content into everdict_skill_versions and moves the pointer. So
-- the version names the last content the workspace decided to publish. Stamped rows are immutable, exactly like a
-- registry version — a correction is the next stamp, which is what makes "what did this procedure say back then?"
-- answerable. Existing rows read as 1.0.0 and get their first snapshot on their first stamp.
ALTER TABLE everdict_skills
  ADD COLUMN IF NOT EXISTS version text NOT NULL DEFAULT '1.0.0',
  ADD COLUMN IF NOT EXISTS origin  jsonb;

CREATE TABLE IF NOT EXISTS everdict_skill_versions (
  tenant       text        NOT NULL,
  skill_id     text        NOT NULL,
  version      text        NOT NULL,
  name         text        NOT NULL,
  description  text        NOT NULL,
  instructions text        NOT NULL,
  files        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  refs         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  note         text,
  stamped_by   text        NOT NULL,
  stamped_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, skill_id, version)
);

-- The version panel reads one skill's line newest-first.
CREATE INDEX IF NOT EXISTS everdict_skill_versions_skill_idx ON everdict_skill_versions (tenant, skill_id, stamped_at DESC);
