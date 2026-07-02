-- 이 run 을 채점한 judge 모델(들) — 리더보드 '채점자' 축(model 축=하니스가 쓴 LLM 과 별개).
-- distinct judge 모델 문자열 배열. 경량이라 무거운 scorecard 와 달리 목록(list)에도 포함(공정 비교 필터·표시).
-- 추가 컬럼이라 additive(preflight 불필요). 과거 레코드는 NULL.
ALTER TABLE assay_scorecards ADD COLUMN IF NOT EXISTS judge_models jsonb;
