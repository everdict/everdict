-- 0025_create_runners — self-hosted runner personal-device pairing.
-- Personally owned (owner=principal.subject) + workspace-visible (workspace column). Same model as Connected accounts (0019/0023).
-- No plaintext for the pairing token — only the SHA-256 hash is stored (same as a tenant API key). Design: docs/architecture/self-hosted-runner.md.
CREATE TABLE IF NOT EXISTS everdict_runners (
  owner        text NOT NULL,
  id           text NOT NULL,
  workspace    text NOT NULL,            -- the paired workspace (for the roster). Ownership is owner.
  label        text NOT NULL,            -- display device name
  os           text,                     -- linux | darwin | win32 etc. (optional)
  capabilities text NOT NULL DEFAULT '', -- repo | browser | os-use | docker, space-delimited
  token_hash   text NOT NULL,            -- SHA-256 hash of the pairing token (no plaintext)
  paired_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,              -- last lease/heartbeat (later slice)
  PRIMARY KEY (owner, id)
);

-- For workspace-roster (listByWorkspace) lookups.
CREATE INDEX IF NOT EXISTS everdict_runners_workspace_idx ON everdict_runners (workspace);
-- Token hash → runner resolution (resolveByToken). Tokens are globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS everdict_runners_token_hash_idx ON everdict_runners (token_hash);
