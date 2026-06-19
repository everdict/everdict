-- 0009_create_runtimes — additive (expand): 테넌트 실행 인프라(Runtime) 버전 SSOT 영속 테이블.
-- (tenant, id, version) 는 불변. runtime = RuntimeSpec(local | nomad | k8s) — 비밀 없음(자격증명은 SecretStore).
-- _shared = first-party 공용 런타임 폴백. (0007=secrets, 0008=judges → runtimes 는 0009.)
CREATE TABLE IF NOT EXISTS assay_runtimes (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  runtime    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS assay_runtimes_tenant_id_idx ON assay_runtimes (tenant, id);
