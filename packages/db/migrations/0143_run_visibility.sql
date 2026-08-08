-- Run visibility as a CREATION-TIME FACT (audience decoupled from the scheduling class): background
-- activation runs stamp "workspace" (fleet observability, matching their session door), interactive turns
-- and sandbox shells stamp "member". NULL = legacy row — the audience rule falls back to the class/kind
-- inference, conservatively.
ALTER TABLE everdict_runs ADD COLUMN IF NOT EXISTS visibility text;
