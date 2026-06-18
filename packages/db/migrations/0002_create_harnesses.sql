-- 0002_create_harnesses — additive (expand): 하니스 버전 SSOT 영속 테이블.
-- (id, version) 는 불변 — 코드(PgHarnessRegistry)가 다른 스펙 재등록을 거부한다.
-- 테넌트 소유권(tenant 컬럼)은 추후 expand 마이그레이션으로 추가 예정.
CREATE TABLE IF NOT EXISTS assay_harnesses (
  id         text NOT NULL,
  version    text NOT NULL,
  spec       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

CREATE INDEX IF NOT EXISTS assay_harnesses_id_idx ON assay_harnesses (id);
