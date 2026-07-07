-- 0023_connections_owner — re-key Connected accounts to personal ownership.
-- owner = principal.subject (the person who owns the connection). The workspace column is kept — it records the workspace where the connection was "created"
-- so we can show a workspace application roster (the read-only view in Settings > Members tab). That is, connections are personally owned + workspace-visible.
-- ⚠ Existing rows: owner is best-effort backfilled with the workspace value (not the real subject) → until that user re-connects, consumers (clone/notify) won't resolve it.
ALTER TABLE everdict_connections ADD COLUMN owner text NOT NULL DEFAULT '';
UPDATE everdict_connections SET owner = workspace WHERE owner = '';
ALTER TABLE everdict_connections ALTER COLUMN owner DROP DEFAULT;
-- PK (workspace,id) → (owner,id): primary key for personal-ownership access (list/remove/tokenFor by owner).
ALTER TABLE everdict_connections DROP CONSTRAINT everdict_connections_pkey;
ALTER TABLE everdict_connections ADD PRIMARY KEY (owner, id);
-- Index for workspace-roster (listByWorkspace) lookups.
CREATE INDEX IF NOT EXISTS everdict_connections_workspace_idx ON everdict_connections (workspace);
