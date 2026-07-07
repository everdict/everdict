-- 0003_create_tenant_keys — additive (expand): tenant API keys (hash only).
-- key_hash = SHA-256(plaintext). The plaintext is shown once at issuance and never stored.
CREATE TABLE IF NOT EXISTS everdict_tenant_keys (
  key_hash   text PRIMARY KEY,
  tenant     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS everdict_tenant_keys_tenant_idx ON everdict_tenant_keys (tenant);
