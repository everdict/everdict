-- Resource comments (datasets etc.) — discussion on the activity timeline. Workspace-scoped + author=author subject.
-- resource_type is extensible (currently "dataset"). A new table, so additive (no preflight needed).
CREATE TABLE IF NOT EXISTS everdict_comments (
  id            text PRIMARY KEY,
  tenant        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text NOT NULL,
  author        text NOT NULL,
  body          text NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);
-- Index for per-resource timeline lookups (oldest→newest).
CREATE INDEX IF NOT EXISTS everdict_comments_resource_idx
  ON everdict_comments (tenant, resource_type, resource_id, created_at);
