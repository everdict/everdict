-- 저장된 스코어카드 분석 View(docs/architecture/scorecard-analysis-views.md) — 이름 붙인 AnalysisConfig 를
-- 워크스페이스에 저장/공유(비공개|공유). config 는 불투명 jsonb(웹이 형태 검증). 라이브 재실행이라 스냅샷 저장 안 함.
CREATE TABLE IF NOT EXISTS assay_views (
  id         text PRIMARY KEY,
  tenant     text NOT NULL,
  name       text NOT NULL,
  config     jsonb NOT NULL,
  visibility text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 조회 경로: 워크스페이스의 공유 뷰 + 내 비공개 뷰(최신순).
CREATE INDEX IF NOT EXISTS idx_assay_views_tenant ON assay_views (tenant, visibility, created_at DESC);
