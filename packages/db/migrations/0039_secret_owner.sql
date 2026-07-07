-- Secret scope: workspace-shared (owner='') vs user-personal (owner=subject).
-- owner='' = existing workspace secret (admin-managed). owner=<subject> = that user's own personal secret (self-managed).
-- All existing rows remain workspace-scoped (owner=''). Extend the PK to (workspace, owner, name) so
-- the workspace and multiple users can each hold the same name.
ALTER TABLE everdict_secrets ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT '';
ALTER TABLE everdict_secrets DROP CONSTRAINT IF EXISTS everdict_secrets_pkey;
ALTER TABLE everdict_secrets ADD PRIMARY KEY (workspace, owner, name);
