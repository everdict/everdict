-- 0005_create_datasets — additive (expand): 데이터셋 버전 SSOT 영속 테이블.
-- (tenant, id, version) 는 불변 — 코드(PgDatasetRegistry)가 다른 내용 재등록을 거부한다.
-- 하니스와 달리 처음부터 테넌트 소유권 포함(_shared = first-party 벤치마크 폴백).
CREATE TABLE IF NOT EXISTS assay_datasets (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  dataset    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS assay_datasets_tenant_id_idx ON assay_datasets (tenant, id);
