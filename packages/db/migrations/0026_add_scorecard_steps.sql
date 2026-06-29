-- 스코어카드 실행 과정 타임라인(스텝) — run 이 진행되며 append 되는 이벤트 배열({ts,phase,status,message,caseId?}).
-- "진행 과정"을 웹에 보이기 위함. 무거운 scorecard 와 함께 get 에서만 조회(목록은 생략). 추가 컬럼이라 additive(preflight 불필요).
ALTER TABLE assay_scorecards ADD COLUMN IF NOT EXISTS steps jsonb;
