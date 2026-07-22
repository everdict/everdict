-- 0064_browser_profile_expiry — additive (expand): the expected expiry of a browser profile's saved login
-- (browser-profiles — "surface staleness + one-click re-login"). expires_at = the EARLIEST wall-clock expiry among
-- the captured cookies (a login is only as fresh as its soonest-expiring persisted cookie), or NULL when every
-- captured cookie is a session cookie (no fixed expiry) / nothing is captured yet. Computed at capture time by the
-- apps/api capture service. Not sensitive (a timestamp, not a cookie value). Nullable so existing rows are unaffected.
ALTER TABLE everdict_browser_profiles ADD COLUMN IF NOT EXISTS expires_at timestamptz;
