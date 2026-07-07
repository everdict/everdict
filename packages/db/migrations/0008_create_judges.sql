-- 0008_create_judges — additive (expand): Agent Judge 버전 SSOT 영속 테이블.
-- (tenant, id, version) 는 불변 — 코드(PgJudgeRegistry)가 다른 내용 재등록을 거부한다.
-- judge = JudgeSpec(model | harness). _shared = first-party 기본 judge 폴백.
-- (0007 은 동시 작업의 secrets 마이그레이션 → judges 는 0008.)
CREATE TABLE IF NOT EXISTS everdict_judges (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  judge      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS everdict_judges_tenant_id_idx ON everdict_judges (tenant, id);
