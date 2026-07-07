-- 0003_create_tenant_keys — additive (expand): 테넌트 API 키 (해시만 저장).
-- key_hash = SHA-256(평문). 평문은 발급 시 한 번만 노출되고 저장되지 않는다.
CREATE TABLE IF NOT EXISTS everdict_tenant_keys (
  key_hash   text PRIMARY KEY,
  tenant     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS everdict_tenant_keys_tenant_idx ON everdict_tenant_keys (tenant);
