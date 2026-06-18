-- 0006_create_scorecards — additive (expand): 스코어카드 run(데이터셋×하니스 배치 평가) 영속 테이블.
-- summary = 경량 집계(목록용), scorecard = 케이스별 전체 결과(상세용, 트레이스 포함 → 무거움).
CREATE TABLE IF NOT EXISTS assay_scorecards (
  id              text PRIMARY KEY,
  tenant          text NOT NULL,
  dataset_id      text NOT NULL,
  dataset_version text NOT NULL,
  harness_id      text NOT NULL,
  harness_version text NOT NULL,
  status          text NOT NULL,
  summary         jsonb,
  scorecard       jsonb,
  error           jsonb,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

-- 테넌트별 목록 + 커서(created_at DESC, id DESC) 정렬용.
CREATE INDEX IF NOT EXISTS assay_scorecards_tenant_created_idx ON assay_scorecards (tenant, created_at DESC, id DESC);
