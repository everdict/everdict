-- 0027_create_schedules — additive (expand): 예약(cron) 스코어카드 영속 테이블.
-- 스케줄 = 저장된 RunScorecardInput(run_template jsonb) + 크론식 + 정책. 이 테이블이 SSOT,
-- Temporal Schedule 은 실행 메커니즘(slice 2). 워크스페이스(tenant) 스코프. 설계: docs/architecture/scheduled-evals.md.
CREATE TABLE IF NOT EXISTS assay_schedules (
  id                text PRIMARY KEY,
  tenant            text NOT NULL,
  name              text NOT NULL,
  cron              text NOT NULL,
  timezone          text NOT NULL,
  overlap_policy    text NOT NULL,
  enabled           boolean NOT NULL,
  created_by        text NOT NULL,
  run_template      jsonb NOT NULL,
  last_fired_at     timestamptz,
  last_status       text,
  last_scorecard_id text,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);

-- 테넌트별 목록 + 커서(created_at DESC, id DESC) 정렬용.
CREATE INDEX IF NOT EXISTS assay_schedules_tenant_created_idx ON assay_schedules (tenant, created_at DESC, id DESC);
