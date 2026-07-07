-- 0016_workspace_member_email — additive (expand): email/preferred_username claim for readable member lists.
-- subject is an opaque Keycloak sub UUID → capture a human-readable identifier (email) at login/invite-acceptance (display only, no authz bearing).
-- Legacy rows are NULL (COALESCE backfill on next login). The PK(workspace,subject) is unchanged.
ALTER TABLE everdict_workspace_members ADD COLUMN IF NOT EXISTS email text;
