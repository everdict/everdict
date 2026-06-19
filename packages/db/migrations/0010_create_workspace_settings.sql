-- 워크스페이스 단위 설정(컨트롤플레인 정책). settings 는 JSONB 로 확장 용이(현재: meterUsage).
CREATE TABLE IF NOT EXISTS assay_workspace_settings (
  workspace  text PRIMARY KEY,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
