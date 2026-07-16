-- 0058_create_browser_profiles — additive (expand): the saved authenticated browser profile metadata table
-- (browser-profiles S2). Personal / self-scoped (owner = created_by, the subject) — listing is by (tenant, created_by).
-- cookie_domains = the domains this profile logs into (declared; refined from captured cookies in S3). The encrypted
-- storageState blob (S3) lives in object storage keyed by (tenant, id), NOT in this table.
CREATE TABLE IF NOT EXISTS everdict_browser_profiles (
  id            text NOT NULL,
  tenant        text NOT NULL,
  name          text NOT NULL,
  cookie_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id)
);

CREATE INDEX IF NOT EXISTS everdict_browser_profiles_owner_idx ON everdict_browser_profiles (tenant, created_by);
