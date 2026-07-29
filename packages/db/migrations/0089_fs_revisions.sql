-- 0089_fs_revisions — additive (expand): the workspace filesystem's publication ledger
-- (docs/architecture/workspace-filesystem.md §Revisions). One row per published revision of a file: WHO published
-- it (actor jsonb — member or agent, with the agent + conversation and the member it acted for), when, on which
-- bytes (hash/size/content_type) and why (message). Content itself stays in object storage, keyed by
-- (path, revision) — rows here are small and retained indefinitely (product decision: no pruning).
--
-- The PRIMARY KEY is load-bearing, not bookkeeping: allocating a revision number IS the insert, so two writers
-- racing for the same number cannot both win, and the loser is told instead of silently overwriting the winner.
CREATE TABLE IF NOT EXISTS everdict_fs_revisions (
  tenant        text    NOT NULL,
  path          text    NOT NULL,
  revision      integer NOT NULL,
  size          bigint  NOT NULL,
  content_type  text    NOT NULL,
  hash          text    NOT NULL,
  actor         jsonb   NOT NULL,
  message       text,
  restored_from integer,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant, path, revision)
);

-- History of one file, newest first (the file's audit panel) — also serves head lookup (LIMIT 1) on every write.
CREATE INDEX IF NOT EXISTS everdict_fs_revisions_path_desc
  ON everdict_fs_revisions (tenant, path, revision DESC);

-- Workspace-wide "who published what, when" — the cross-file activity read.
CREATE INDEX IF NOT EXISTS everdict_fs_revisions_recent
  ON everdict_fs_revisions (tenant, created_at DESC);
