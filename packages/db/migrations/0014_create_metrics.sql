-- 0014_create_metrics — additive (expand): Metric 버전 SSOT 영속 테이블.
-- (tenant, id, version) 는 불변 — 코드(PgMetricRegistry)가 다른 내용 재등록을 거부한다.
-- metric = MetricSpec(threshold 등 합격규칙, 비-비밀). _shared = first-party 기본 메트릭 폴백.
-- 유저가 런타임에 정의한 메트릭 → 컨트롤플레인이 run 후 trace/scores 위에 post-hoc 적용(judge 와 동일 경로).
CREATE TABLE IF NOT EXISTS everdict_metrics (
  tenant     text NOT NULL,
  id         text NOT NULL,
  version    text NOT NULL,
  metric     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id, version)
);

CREATE INDEX IF NOT EXISTS everdict_metrics_tenant_id_idx ON everdict_metrics (tenant, id);
