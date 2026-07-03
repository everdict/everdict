-- 0034_drop_metrics — contract: Metric(threshold 합격규칙) 개념을 제품/엔진에서 완전 제거한다.
-- 채점은 Grader 하나로 통일(judge = model grader) + 자동 요약(passRate/mean)만 유지 — MetricSpec/PgMetricRegistry 삭제됨.
-- 실사용 0(어떤 스코어카드도 threshold metric 을 적용한 적 없음) → 안전한 데드 테이블 정리. 되돌림은 0014 재현.
DROP TABLE IF EXISTS assay_metrics;
