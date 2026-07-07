-- 0019_create_connections — workspace external-account links (Connected accounts) + single-use OAuth pending state.
-- Tokens (access/refresh) keep only the AES-GCM ciphertext (no plaintext). The KEK lives in the app environment (EVERDICT_SECRETS_KEY)/Vault.
CREATE TABLE IF NOT EXISTS everdict_connections (
  workspace          text NOT NULL,
  id                 text NOT NULL,
  provider           text NOT NULL,
  host               text,
  account_label      text NOT NULL,
  scopes             text NOT NULL DEFAULT '', -- OAuth scope, space-delimited
  ciphertext         text NOT NULL,            -- envelope-encrypted access token
  iv                 text NOT NULL,
  tag                text NOT NULL,
  refresh_ciphertext text,                     -- envelope-encrypted refresh token (if any)
  refresh_iv         text,
  refresh_tag        text,
  expires_at         timestamptz,              -- access token expiry (if any)
  connected_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace, id)
);

-- Single-use pending state between OAuth authorize→callback (CSRF + callback-context restore). DELETE on take.
CREATE TABLE IF NOT EXISTS everdict_oauth_states (
  state      text PRIMARY KEY,
  workspace  text NOT NULL,
  provider   text NOT NULL,
  host       text,
  created_by text NOT NULL,
  expires_at timestamptz NOT NULL
);
