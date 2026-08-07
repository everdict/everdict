-- Teammate durability (LESSON 059 P2): a standing teammate's config (name · standing task · watch kinds ·
-- execution-key id) persists on its session row, so an agent-service restart re-registers the roster instead
-- of evaporating it. The execution token itself is never stored (tenant keys are hashed one-way) — the boot
-- restore mints a fresh token and revokes the stale key by the stored key id. Additive.
ALTER TABLE everdict_agent_sessions ADD COLUMN IF NOT EXISTS teammate jsonb;
CREATE INDEX IF NOT EXISTS everdict_agent_sessions_teammate_idx
  ON everdict_agent_sessions (updated_at)
  WHERE teammate IS NOT NULL;
