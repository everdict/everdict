-- Agent Judge 등록자(subject) — 목록에서 "누가 등록했나"(아바타+이름) 표기용.
-- 등록 시 스탬프(register 의 optional createdBy); 과거 레코드·파일 시드·_shared 는 NULL.
-- 추가 컬럼이라 additive(preflight 불필요). 하니스 0031·데이터셋과 동일 패턴.
ALTER TABLE everdict_judges ADD COLUMN IF NOT EXISTS created_by text;
