-- User profile (mutable display info) — name/username/avatar layered on top of the Keycloak identity. subject (=OIDC sub) is the key.
-- email is not stored (an SSO claim, display-only/read-only). A pure profile unrelated to membership/authz.
CREATE TABLE IF NOT EXISTS everdict_user_profiles (
  subject     TEXT PRIMARY KEY,
  name        TEXT,
  username    TEXT,
  avatar_url  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
