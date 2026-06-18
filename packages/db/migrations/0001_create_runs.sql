-- 0001_create_runs — additive (expand): result-store 의 runs 테이블.
-- 파괴적 변경이 아니므로 deploy 와 함께 바로 적용 가능. preflight: docs/migration/preflight/0001_create_runs.md
CREATE TABLE IF NOT EXISTS assay_runs (
  id              text PRIMARY KEY,
  tenant          text NOT NULL,
  harness_id      text NOT NULL,
  harness_version text NOT NULL,
  case_id         text NOT NULL,
  status          text NOT NULL,
  result          jsonb,
  error           jsonb,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

-- 테넌트별 목록 + 커서(created_at DESC, id DESC) 정렬용.
CREATE INDEX IF NOT EXISTS assay_runs_tenant_created_idx ON assay_runs (tenant, created_at DESC, id DESC);
