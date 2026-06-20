-- 0011_create_benchmarks — additive (expand): 벤치마크 정의(레시피) SSOT 영속 테이블.
-- (tenant, id, version) 는 불변 — 코드(PgBenchmarkRegistry)가 다른 내용 재등록을 거부한다.
-- 데이터셋과 동일한 테넌트 소유권 모델(_shared = first-party 레시피 폴백). spec = BenchmarkAdapterSpec(JSON).
CREATE TABLE IF NOT EXISTS assay_benchmarks (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  spec       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS assay_benchmarks_tenant_id_idx ON assay_benchmarks (tenant, id);
