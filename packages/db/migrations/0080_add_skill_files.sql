-- Skill supporting files — the Claude-Code references/* reinterpretation. A skill stops being one giant document:
-- the SKILL.md body stays in `instructions`, and reference material moves into `files` jsonb ([{path, content}]),
-- each file loaded individually on demand by the agent (read_skill_file). Additive; existing rows default to [].
ALTER TABLE everdict_skills
  ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '[]'::jsonb;
