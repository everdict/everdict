-- 스코어카드 부분 실행(subset) 표식 — 이 배치가 데이터셋의 어떤 부분집합을 돌렸나
-- ({total, selected, ids?, tags?, limit?}). NULL = 전체 실행. 경량이라 목록 SELECT 에도 포함.
-- 추가 컬럼이라 additive(preflight 불필요).
ALTER TABLE everdict_scorecards ADD COLUMN IF NOT EXISTS subset jsonb;
