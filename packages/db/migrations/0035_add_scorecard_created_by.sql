-- 스코어카드 실행자(제출자 subject) — 목록/상세에서 "누가 실행시켰나"(아바타+이름) 표기 + 필터용.
-- submit/ingest 시 principal.subject 를 스탬프; 과거 레코드·기계 발사(subject 없음)는 NULL.
-- origin(어디서 발사됐나)과 짝을 이루는 '누가'. 추가 컬럼이라 additive(preflight 불필요) —
-- 데이터셋(assay_datasets.created_by)·하니스(0031)와 동일 패턴.
ALTER TABLE assay_scorecards ADD COLUMN IF NOT EXISTS created_by text;
