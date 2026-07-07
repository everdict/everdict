-- 버전 태그 — 버전을 번호만으로 분간하기 어려워 붙이는 자유 라벨(여러 개, 표시/구분용).
-- 스펙(jsonb) 밖의 "가변 레지스트리 메타데이터"(created_by 와 동급): 등록 후에도 편집되며
-- specsEqual/버전 불변성(SSOT 보장)에는 관여하지 않는다. 4개 버전 엔티티 공통 + 템플릿
-- (everdict_harness_templates 는 PgVersionedStore 를 인스턴스와 공유하므로 컬럼만 동반 추가).
-- 추가 컬럼이라 additive(preflight 불필요).
ALTER TABLE everdict_harness_instances ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE everdict_harness_templates ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE everdict_datasets ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE everdict_judges ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE everdict_runtimes ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
