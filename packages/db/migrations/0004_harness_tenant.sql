-- 0004_harness_tenant — 하니스에 테넌트 소유권 추가 (expand). 기존 행은 _shared(first-party)로 백필.
-- PK 를 (tenant, id, version) 로 재지정. 마이그레이터가 한 번만 실행한다.
ALTER TABLE everdict_harnesses ADD COLUMN IF NOT EXISTS tenant text NOT NULL DEFAULT '_shared';

ALTER TABLE everdict_harnesses DROP CONSTRAINT IF EXISTS everdict_harnesses_pkey;
ALTER TABLE everdict_harnesses ADD PRIMARY KEY (tenant, id, version);

CREATE INDEX IF NOT EXISTS everdict_harnesses_tenant_id_idx ON everdict_harnesses (tenant, id);
