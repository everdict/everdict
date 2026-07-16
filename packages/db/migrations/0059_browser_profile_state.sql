-- 0059_browser_profile_state — additive (expand): the captured login blob for a browser profile (browser-profiles S3).
-- state_cipher = the encrypted (AES-256-GCM, EVERDICT_SECRETS_KEY KEK) Playwright-style storageState (cookies) captured
-- from an interactive session; SERVER-ONLY (never returned to the client). captured_at = when it was last captured
-- (NULL = no login captured yet — the profile is still a placeholder). Nullable so existing S2 rows are unaffected.
ALTER TABLE everdict_browser_profiles ADD COLUMN IF NOT EXISTS state_cipher text;
ALTER TABLE everdict_browser_profiles ADD COLUMN IF NOT EXISTS captured_at timestamptz;
