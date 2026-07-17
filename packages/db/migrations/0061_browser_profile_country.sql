-- 0061_browser_profile_country — additive (expand): the geo a browser profile's login ran through (browser-profiles).
-- country = the egress-proxy country picked when the profile's login session was created (NULL = direct login).
-- Re-login defaults to it; the eval-browser proxy launch (follow-up) reads it. Nullable so existing rows are unaffected.
ALTER TABLE everdict_browser_profiles ADD COLUMN IF NOT EXISTS country text;
