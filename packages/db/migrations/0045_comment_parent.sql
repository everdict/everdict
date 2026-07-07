-- Comment replies (one-level thread) — if parent_id is set, it's a reply to that comment. Only a top-level comment can be a parent (service-enforced).
-- Just an added column, so additive (no preflight needed). Index for per-parent reply lookups / delete cascade.
ALTER TABLE everdict_comments ADD COLUMN IF NOT EXISTS parent_id text;
CREATE INDEX IF NOT EXISTS everdict_comments_parent_idx ON everdict_comments (tenant, parent_id) WHERE parent_id IS NOT NULL;
