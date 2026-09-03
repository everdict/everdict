-- 0209_shared_worlds — additive (expand): a world several cases take turns in.
-- A `per-case` world is created and torn down per case; a `per-run` world stands once and the batch's cases
-- share it, which needs two things a per-case row does not: WHICH world two cases are asking for
-- (`shared_key`), and how many are inside it right now (`holders`). The refcount is the FENCE — a world is
-- never torn down while somebody is in it — and `expires_at` is the backstop for a holder that died without
-- leaving. Design: docs/architecture/world-and-engagement-model.md.
ALTER TABLE everdict_created_worlds ADD COLUMN IF NOT EXISTS shared_key text;
ALTER TABLE everdict_created_worlds ADD COLUMN IF NOT EXISTS holders integer NOT NULL DEFAULT 0;
ALTER TABLE everdict_created_worlds ADD COLUMN IF NOT EXISTS expires_at timestamptz;
-- The coordinates the CREATOR got: a joiner has no other way to learn them, because the world exists in
-- somebody else's process and asking the runtime again would be a second answer to a settled question.
ALTER TABLE everdict_created_worlds ADD COLUMN IF NOT EXISTS endpoints jsonb;

-- ONE LIVE row per shared world, which is what makes "am I the one who must create it" the INSERT's own
-- conflict arm rather than a read followed by a write. Partial twice over:
--   `shared_key IS NOT NULL` — a per-case row has no shared key and every one of them would otherwise
--                              collide on NULL semantics nobody intends;
--   `state <> 'released'`    — a world that was torn down leaves its name free, so the next batch to ask for
--                              it INSERTS a new row rather than reviving a settled one. The released row is
--                              history and stays readable; nothing joins it, and no statement has to
--                              distinguish "I revived it" from "I joined it" in its own RETURNING.
CREATE UNIQUE INDEX IF NOT EXISTS everdict_created_worlds_shared_uidx
  ON everdict_created_worlds (tenant, shared_key)
  WHERE shared_key IS NOT NULL AND state <> 'released';
