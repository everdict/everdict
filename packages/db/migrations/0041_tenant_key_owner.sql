-- 개인(user) API 키: 키에 owner(발급자 subject)를 붙인다. owner='' = 레거시 워크스페이스 머신 키(admin, 종전 동작 유지),
-- owner=<subject> = 그 유저의 개인 키(인증 시 발급자 멤버십 역할로 해석, 셀프 관리). 기존 행은 owner=''로 남아 그대로 동작.
ALTER TABLE assay_tenant_keys ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS assay_tenant_keys_tenant_owner ON assay_tenant_keys (tenant, owner);
