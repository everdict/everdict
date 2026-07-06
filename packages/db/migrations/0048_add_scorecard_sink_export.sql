-- 트레이스 싱크 적재 결과 — 채점 완료 후 케이스별 trace+점수를 워크스페이스 관측 플랫폼
-- (MLflow/Langfuse/LangSmith/Phoenix)에 내보낸 기록(status/링크/케이스별 외부 id).
-- 레코드 필드명은 export(TS), 컬럼은 예약어 충돌을 피해 sink_export.
-- 추가 컬럼이라 additive(preflight 불필요). 설계: docs/architecture/trace-sink.md
ALTER TABLE assay_scorecards ADD COLUMN IF NOT EXISTS sink_export jsonb;
