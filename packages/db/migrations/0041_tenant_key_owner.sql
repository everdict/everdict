-- Personal (user) API keys: attach an owner (issuer subject) to the key. owner='' = legacy workspace machine key (admin, behavior unchanged),
-- owner=<subject> = that user's personal key (resolved to the issuer's membership role on auth, self-managed). Existing rows stay owner='' and work as before.
ALTER TABLE everdict_tenant_keys ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS everdict_tenant_keys_tenant_owner ON everdict_tenant_keys (tenant, owner);
