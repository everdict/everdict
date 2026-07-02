-- 스코어카드가 실제로 쓴 모델(리더보드 model 축) — {observed:[],declared?,primary?}.
-- observed=트레이스 관측, declared=spec 선언, primary=그룹 키. 경량이라 무거운 scorecard 와 달리 목록(list)에도 포함한다.
-- 추가 컬럼이라 additive(preflight 불필요). 과거 레코드는 NULL(=primary unknown; 백필은 후속).
ALTER TABLE assay_scorecards ADD COLUMN IF NOT EXISTS models jsonb;
