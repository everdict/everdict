-- 0015_tenant_keys_metadata — additive (expand): non-secret metadata for self-serve API-key management (list/revoke).
-- id     = stable identifier (targets the revoke; never exposes key_hash). Legacy rows are deterministically backfilled with md5(key_hash).
-- label  = human-assigned name (optional). prefix = ak_abcd… (plaintext identification hint; not a hash). Legacy rows have no plaintext, so it's an empty string.
-- The key_hash PK is unchanged (auth path / ON CONFLICT(key_hash) invariant).
ALTER TABLE everdict_tenant_keys ADD COLUMN IF NOT EXISTS id text;
ALTER TABLE everdict_tenant_keys ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE everdict_tenant_keys ADD COLUMN IF NOT EXISTS prefix text;
UPDATE everdict_tenant_keys SET id = md5(key_hash) WHERE id IS NULL;
ALTER TABLE everdict_tenant_keys ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS everdict_tenant_keys_tenant_id_idx ON everdict_tenant_keys (tenant, id);
