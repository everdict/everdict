-- 0065_secret_offline_token — additive (expand): support an "offline token" secret kind alongside plain strings.
-- An offline_token secret stores a long-lived OAuth refresh token (inside the existing encrypted ciphertext, as a
-- JSON envelope) that the control plane exchanges for a short-lived access token on demand; anywhere the secret is
-- referenced by name, the injected value is a freshly-minted access token (never the refresh token). See docs/secrets.md.
--   kind                    — 'plain' (default, existing rows) | 'offline_token'. Discriminates the ciphertext payload.
--   access_token_expires_at — the ISO expiry of the currently-cached access token (offline_token only, else NULL).
--                             Stored in the clear (a timestamp, not a token) so `list` can show staleness without
--                             decrypting; mirrors the encrypted envelope's own copy, refreshed on each re-mint.
-- Both nullable/defaulted so existing rows are unaffected.
ALTER TABLE everdict_secrets ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'plain';
ALTER TABLE everdict_secrets ADD COLUMN IF NOT EXISTS access_token_expires_at timestamptz;
