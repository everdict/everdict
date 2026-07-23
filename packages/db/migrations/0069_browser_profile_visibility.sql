-- 0069_browser_profile_visibility — additive (expand): a browser profile now carries a scope (browser-profiles
-- workspace-share). `private` = a personal profile visible only to its creator (user scope — the original behavior);
-- `workspace` = a shared workspace asset (read = any member, manage = creator-or-admin). Existing rows default to
-- `private` so nobody's already-captured personal login is retroactively exposed to the workspace. NOT NULL with a
-- default keeps the column safe for the running (pre-deploy) code, which never reads it.
ALTER TABLE everdict_browser_profiles
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';
