-- 0017_create_workspace_invites — additive: token/link-redemption workspace invites.
-- token_hash = SHA-256(plaintext inv_…). The plaintext is shown once at creation; only the hash is stored (same security model as tenant-keys).
-- Invite token = workspace-join secret → hash-only · expiring (expires_at) · single-use (accepted_at lock).
CREATE TABLE IF NOT EXISTS everdict_workspace_invites (
  token_hash  text PRIMARY KEY,
  id          text NOT NULL,                  -- stable identifier (revoke/list; never exposes token_hash)
  workspace   text NOT NULL,
  role        text NOT NULL,
  created_by  text NOT NULL,                   -- the admin subject who issued it
  prefix      text NOT NULL DEFAULT '',        -- inv_abcd… display hint (not a hash/plaintext)
  expires_at  timestamptz,                     -- NULL = never expires
  accepted_at timestamptz,                     -- NULL = unused (single-use lock key)
  accepted_by text,                            -- the subject who accepted
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS everdict_workspace_invites_ws_id_idx ON everdict_workspace_invites (workspace, id);
CREATE INDEX IF NOT EXISTS everdict_workspace_invites_workspace_idx ON everdict_workspace_invites (workspace);
