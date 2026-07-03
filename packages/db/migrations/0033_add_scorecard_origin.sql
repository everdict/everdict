-- 스코어카드 트리거 출처(provenance): source(schedule|github-actions|api|web) + repo/sha/ref/prNumber/runUrl
-- + pinOverrides(제출 시점 임시 핀 — PR 이미지 스왑 기록). 경량이라 목록에도 포함.
-- 추가 컬럼이라 additive(preflight 불필요). 과거 레코드는 NULL.
ALTER TABLE assay_scorecards ADD COLUMN IF NOT EXISTS origin jsonb;
