-- 0013_create_models — additive (expand): Model 버전 SSOT 영속 테이블.
-- (tenant, id, version) 는 불변 — 코드(PgModelRegistry)가 다른 내용 재등록을 거부한다.
-- model = ModelSpec(provider + 하부 모델 + baseUrl/params, 비-비밀). _shared = first-party 기본 모델 폴백.
-- judge/harness 가 raw 문자열 대신 등록된 model 을 id 로 참조 → "어떤 모델로 돌렸나"가 비교 가능한 1급 대상.
CREATE TABLE IF NOT EXISTS assay_models (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  model      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS assay_models_tenant_id_idx ON assay_models (tenant, id);
