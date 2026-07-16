-- 0060_workspace_invites_reusable — retire the single-use lock; invites become reusable join links.
-- A link now stays valid until it expires (expires_at) or an admin revokes (deletes) it — many people can join with it.
-- accepted_count tracks how many people have joined via the link (0 = unused). Additive; safe to apply online.
-- The legacy single-use columns accepted_at/accepted_by are kept for historical rows but are no longer written or read
-- (consumeInvite dropped the `accepted_at IS NULL` lock).
ALTER TABLE everdict_workspace_invites ADD COLUMN IF NOT EXISTS accepted_count integer NOT NULL DEFAULT 0;

-- Backfill: an already-accepted single-use invite counts as one join.
UPDATE everdict_workspace_invites SET accepted_count = 1 WHERE accepted_at IS NOT NULL AND accepted_count = 0;
