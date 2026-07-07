-- 0007_create_secrets — stores workspace secrets (model/provider keys). Only the AES-GCM ciphertext is kept (no plaintext).
-- The KEK lives in the app environment (EVERDICT_SECRETS_KEY)/Vault — the DB holds only ciphertext/iv/tag.
CREATE TABLE IF NOT EXISTS everdict_secrets (
  workspace  text NOT NULL,
  name       text NOT NULL,
  ciphertext text NOT NULL,
  iv         text NOT NULL,
  tag        text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace, name)
);
