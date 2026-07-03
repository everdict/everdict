-- run 실행자(제출자 subject) — 알림 피드의 수신자(N2: "내가 시킨 작업이 끝났다") + 목록 "누가" 표기용.
-- submit 시 principal.subject 를 스탬프; 과거 레코드·기계 발사(subject 없음)는 NULL.
-- 스코어카드(0035)와 동일 additive 패턴(preflight 불필요).
ALTER TABLE assay_runs ADD COLUMN IF NOT EXISTS created_by text;
