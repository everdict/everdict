-- 하네스 인스턴스/템플릿 등록자(subject) — 목록에서 "누가 등록했나"(아바타+이름) 표기용.
-- 등록 시 스탬프(register 의 optional createdBy); 과거 레코드·파일 시드·_shared 는 NULL.
-- 추가 컬럼이라 additive(preflight 불필요). 데이터셋(everdict_datasets.created_by)과 동일 패턴.
ALTER TABLE everdict_harness_instances ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE everdict_harness_templates ADD COLUMN IF NOT EXISTS created_by text;
