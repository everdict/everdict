-- Notification feed (docs/architecture/notifications.md) — run/scorecard completion to an individual (recipient=subject).
-- The web bell inbox consumes it by polling, and new items also fire as browser/desktop native notifications.
CREATE TABLE IF NOT EXISTS everdict_notifications (
  id         text PRIMARY KEY,
  workspace  text NOT NULL,
  recipient  text NOT NULL,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text,
  link       jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
-- Bell-inbox query path: mine (recipient) + the workspace's latest/unread.
CREATE INDEX IF NOT EXISTS idx_everdict_notifications_recipient
  ON everdict_notifications (recipient, workspace, created_at DESC);
