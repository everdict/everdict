-- 0022_tenant_keys_scopes — additive (expand): API 키별 권한 범위(read|write|admin).
-- scopes = 공백 구분 문자열(예: "read write"). NULL = 레거시 행/full access(무제한) — 인증 코어가 무제한으로 해석한다.
-- 권한 매트릭스(scope→action)는 @assay/auth 가 소유; 여기는 저장만 한다. 기존 키 동작 불변(NULL→무제한).
ALTER TABLE assay_tenant_keys ADD COLUMN IF NOT EXISTS scopes text;
