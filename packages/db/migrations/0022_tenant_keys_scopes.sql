-- 0022_tenant_keys_scopes — additive (expand): per-API-key permission scope (read|write|admin).
-- scopes = space-delimited string (e.g. "read write"). NULL = legacy row/full access (unrestricted) — the auth core interprets it as unrestricted.
-- The permission matrix (scope→action) is owned by @everdict/auth; here we only store it. Existing key behavior is unchanged (NULL→unrestricted).
ALTER TABLE everdict_tenant_keys ADD COLUMN IF NOT EXISTS scopes text;
