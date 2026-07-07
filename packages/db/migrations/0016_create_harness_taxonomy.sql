-- 0016_create_harness_taxonomy — additive (expand): 하네스 Template(대분류) + Instance SSOT.
-- Template = 구조 골격(서비스/슬롯, 버전 미고정). Instance = template 참조 + pins(델타). 둘 다 버전 불변
-- (코드가 다른 스펙 재등록을 거부). 키 = (tenant, id, version), _shared(first-party) 폴백.
-- 설계: docs/architecture/harness-taxonomy.md.
CREATE TABLE IF NOT EXISTS everdict_harness_templates (
  tenant     text NOT NULL DEFAULT '_shared',
  id         text NOT NULL,
  version    text NOT NULL,
  spec       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);
CREATE INDEX IF NOT EXISTS everdict_harness_templates_tenant_id_idx ON everdict_harness_templates (tenant, id);

CREATE TABLE IF NOT EXISTS everdict_harness_instances (
  tenant     text NOT NULL DEFAULT '_shared',
  id         text NOT NULL,
  version    text NOT NULL,
  spec       jsonb NOT NULL, -- HarnessInstanceSpec: { template:{id,version}, id, version, pins }
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);
CREATE INDEX IF NOT EXISTS everdict_harness_instances_tenant_id_idx ON everdict_harness_instances (tenant, id);
