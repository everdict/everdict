-- 시크릿 스코프: 워크스페이스 공유(owner='') vs 유저 개인(owner=subject).
-- owner='' = 기존 워크스페이스 시크릿(admin 관리). owner=<subject> = 그 유저만의 개인 시크릿(셀프 관리).
-- 기존 행은 전부 워크스페이스 스코프(owner='')로 남는다. PK 를 (workspace, owner, name) 으로 확장해
-- 같은 이름을 워크스페이스/여러 유저가 각자 가질 수 있게 한다.
ALTER TABLE assay_secrets ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT '';
ALTER TABLE assay_secrets DROP CONSTRAINT IF EXISTS assay_secrets_pkey;
ALTER TABLE assay_secrets ADD PRIMARY KEY (workspace, owner, name);
