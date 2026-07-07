-- Workspace (=tenant=trust-zone key) registry + membership. SSOT for self-serve creation/switching.
-- The control plane is the authority for membership (the Keycloak token's workspace claim is a default bootstrapped from membership on the first request).
-- A workspace's id is the tenant-key string for all data. Membership is subject (user sub/key) ↔ workspace ↔ role.
CREATE TABLE IF NOT EXISTS everdict_workspaces (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  owner      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS everdict_workspace_members (
  workspace  text NOT NULL,
  subject    text NOT NULL,
  role       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace, subject)
);

-- For listForSubject (workspaces I belong to) lookups.
CREATE INDEX IF NOT EXISTS everdict_workspace_members_subject ON everdict_workspace_members (subject);
