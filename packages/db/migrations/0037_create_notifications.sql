-- 알림 피드(docs/architecture/notifications.md) — run/scorecard 완료를 개인(recipient=subject)에게.
-- 웹 벨 인박스가 폴링으로 소비하고, 새 항목은 브라우저/데스크톱 네이티브 알림으로도 발화된다.
CREATE TABLE IF NOT EXISTS assay_notifications (
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
-- 벨 인박스 조회 경로: 내(recipient) + 워크스페이스의 최신/미읽음.
CREATE INDEX IF NOT EXISTS idx_assay_notifications_recipient
  ON assay_notifications (recipient, workspace, created_at DESC);
