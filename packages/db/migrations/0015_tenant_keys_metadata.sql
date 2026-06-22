-- 0015_tenant_keys_metadata — additive (expand): API 키 self-serve 관리(목록/취소)용 비-비밀 메타데이터.
-- id     = 안정적 식별자(취소 대상 지정; key_hash 노출 금지). 레거시 행은 md5(key_hash)로 결정적 백필.
-- label  = 사람이 붙인 이름(선택). prefix = ak_abcd…(평문 식별 힌트; 해시 아님). 레거시 행은 평문이 없어 빈 문자열.
-- key_hash PK 는 그대로(auth 경로 / ON CONFLICT(key_hash) 불변).
ALTER TABLE assay_tenant_keys ADD COLUMN IF NOT EXISTS id text;
ALTER TABLE assay_tenant_keys ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE assay_tenant_keys ADD COLUMN IF NOT EXISTS prefix text;
UPDATE assay_tenant_keys SET id = md5(key_hash) WHERE id IS NULL;
ALTER TABLE assay_tenant_keys ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS assay_tenant_keys_tenant_id_idx ON assay_tenant_keys (tenant, id);
