-- 0034_drop_metrics — contract: fully remove the Metric (threshold pass-rule) concept from the product/engine.
-- Scoring is unified to a single Grader (judge = model grader) + only the automatic summary (passRate/mean) is kept — MetricSpec/PgMetricRegistry are deleted.
-- Zero real usage (no scorecard has ever applied a threshold metric) → a safe dead-table cleanup. Reverting reproduces 0014.
DROP TABLE IF EXISTS everdict_metrics;
