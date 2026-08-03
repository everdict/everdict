-- Team VISIBILITY (docs/tracker.md) — Linear's private teams, as a filter and nothing more.
--
-- The trust zone is unchanged: `workspace = tenant` remains the isolation boundary, roles remain the only thing
-- authorization reads, and a private team is a narrowing ON TOP of `issues:read` — never a second authz axis.
-- A refused private-team read answers 404, the same no-existence-leak rule cross-workspace reads follow.
ALTER TABLE everdict_teams ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
